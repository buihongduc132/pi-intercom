import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const repoDir = process.cwd();
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-issue4-home-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
const { IntercomClient } = await import("../broker/client.ts");
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

async function waitForBrokerReady(broker: ChildProcessWithoutNullStreams): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      broker.stdout.off("data", onStdout);
      broker.off("exit", onExit);
    };

    broker.stdout.on("data", onStdout);
    broker.once("exit", onExit);
  });

  await ready;
}

async function spawnBroker(): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn("npx", ["--no-install", "tsx", path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForBrokerReady(broker);
  return broker;
}

test("issue #4: a rejecting pi.sendMessage does not surface as an unhandled rejection", async () => {
  // ExtensionAPI.sendMessage is typed `void` in the real host and returns
  // undefined (the SDK self-swallows internally). Some hosts/contexts may return
  // a thenable. The guard in sendIncomingMessage must NEVER throw a TypeError by
  // calling .catch() on undefined, AND must swallow a rejection when a thenable
  // IS returned. Cover both shapes.
  const { default: piIntercomExtension } = await import("../index.ts");

  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const runOnce = async (sendMessageImpl: () => unknown): Promise<void> => {
    const events = new EventEmitter();
    const pi = {
      getSessionName: () => "orchestrator",
      events: {
        on: (channel: string, handler: (payload: unknown) => void) => {
          events.on(channel, handler);
          return () => events.off(channel, handler);
        },
        emit: (channel: string, payload: unknown) => events.emit(channel, payload),
      },
      on: () => undefined,
      registerMessageRenderer: () => undefined,
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      sendMessage: sendMessageImpl,
      appendEntry: () => undefined,
    };

    piIntercomExtension(pi as never);
    // The subagent:control-intercom seam drives deliverLocalSubagentRelayMessage
    // -> sendIncomingMessage -> pi.sendMessage when the target is the current session.
    events.emit("subagent:control-intercom", {
      to: "orchestrator",
      message: "subagent needs attention",
    });
    // Allow the async relay path and any microtask rejection to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  try {
    // Shape A — the REAL host: sendMessage returns undefined (void). A naive
    // `pi.sendMessage(...).catch()` would throw TypeError here.
    await runOnce(() => undefined);
    // Shape B — a host that returns a rejecting thenable. The guard must swallow
    // it so no unhandledRejection reaches the host.
    const sendError = new Error("boom from sendMessage");
    await runOnce(() => Promise.reject(sendError));

    assert.equal(
      rejections.length,
      0,
      `expected no unhandled rejection, but got: ${rejections.map(String).join(", ")}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("issue #4: IntercomClient.destroy() tears down the socket synchronously", { concurrency: false }, async () => {
  const broker = await spawnBroker();
  try {
    const client = new IntercomClient();
    await client.connect({
      name: "destroy-target",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });

    assert.equal(client.isConnected(), true);

    // destroy() must be synchronous and release the underlying socket.
    client.destroy();
    assert.equal(client.isConnected(), false);

    // Idempotent: a second call must not throw.
    assert.doesNotThrow(() => client.destroy());
  } finally {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
  }
});

test("issue #4: the extension 'error' handler destroys the live client socket", { concurrency: false }, async () => {
  const broker = await spawnBroker();
  // Capture the real client instance the extension creates, and spy on its
  // destroy() so we can prove the index.ts 'error' handler routes through it.
  // (If the handler were still empty, destroy would never be called from the
  // error path and this test fails — that is the RED the goal requires.)
  let liveClient: InstanceType<typeof IntercomClient> | null = null;
  let destroyCalls = 0;
  const proto = IntercomClient.prototype;
  const realDestroy = proto.destroy;
  proto.destroy = function (this: InstanceType<typeof IntercomClient>) {
    destroyCalls += 1;
    return realDestroy.call(this);
  };
  // Capture each new client instance so we can emit "error" on the live one.
  const originalNew = proto.constructor;
  const instrumentConnect = proto.connect;
  proto.connect = async function (this: InstanceType<typeof IntercomClient>, ...args: Parameters<typeof instrumentConnect>) {
    liveClient = this;
    return instrumentConnect.apply(this, args);
  } as typeof instrumentConnect;
  void originalNew;

  let harness: { emitLifecycle: (e: string) => Promise<void> } | null = null;
  try {
    const events = new EventEmitter();
    const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      getSessionName: () => "error-handler-worker",
      events: {
        on: (channel: string, handler: (payload: unknown) => void) => { events.on(channel, handler); return () => events.off(channel, handler); },
        emit: (channel: string, payload: unknown) => events.emit(channel, payload),
      },
      on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
        const handlers = lifecycleHandlers.get(event) ?? [];
        handlers.push(handler);
        lifecycleHandlers.set(event, handlers);
      },
      registerMessageRenderer: () => undefined,
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      sendMessage: () => Promise.resolve(),
      appendEntry: () => undefined,
    };
    const ctx = {
      cwd: repoDir,
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => "session-error-handler-test" },
      isIdle: () => true,
      hasUI: false,
      abort: () => undefined,
      ui: undefined,
    };
    harness = {
      emitLifecycle: async (event: string) => {
        for (const handler of lifecycleHandlers.get(event) ?? []) {
          await handler({}, ctx);
        }
      },
    };

    const { default: piIntercomExtension } = await import("../index.ts");
    piIntercomExtension(pi as never);

    // session_start triggers ensureConnected("startup"), which creates and
    // connects the live IntercomClient and registers the error handler.
    await harness.emitLifecycle("session_start");

    // Wait for the background connect to settle on the live client.
    const deadline = Date.now() + 5000;
    while ((!liveClient || !liveClient.isConnected()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(liveClient, "expected the extension to create a live client");
    assert.equal(liveClient.isConnected(), true, "expected the live client to connect");

    const callsBefore = destroyCalls;
    // Emit the same "error" event the socket-level handlers forward
    // (onSocketError / onReaderError) to IntercomClient consumers.
    liveClient.emit("error", new Error("simulated socket error"));

    // Give the synchronous destroy() call in the handler one tick.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      destroyCalls > callsBefore,
      "expected the extension 'error' handler to call destroy() on the live client",
    );
    assert.equal(liveClient.isConnected(), false, "expected the socket to be torn down after the error handler ran");
  } finally {
    // Restore the prototype and shut down.
    proto.destroy = realDestroy;
    proto.connect = instrumentConnect;
    void harness;
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
  }
});
