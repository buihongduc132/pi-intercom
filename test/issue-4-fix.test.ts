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
  const { default: piIntercomExtension } = await import("../index.ts");

  const events = new EventEmitter();
  const sendError = new Error("boom from sendMessage");
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
    // The real ExtensionAPI.sendMessage returns Promise<void>. Make the mock match
    // reality so the .catch() chain in sendIncomingMessage is exercised.
    sendMessage: () => Promise.reject(sendError),
    appendEntry: () => undefined,
  };

  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    piIntercomExtension(pi as never);

    // The subagent:control-intercom seam drives deliverLocalSubagentRelayMessage
    // -> sendIncomingMessage -> pi.sendMessage when the target is the current session.
    pi.events.emit("subagent:control-intercom", {
      to: "orchestrator",
      message: "subagent needs attention",
    });

    // Allow the async relay path and any microtask rejection to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));

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
