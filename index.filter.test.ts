// Wave 5 — RED phase: failing tests for the NEW behavior (add-session-list-filtering).
//
// These tests describe the INTENDED behavior from
// `openspec/changes/add-session-list-filtering/` (decisions D1–D6). They are
// written to FAIL against the current HEAD (d264d01 / v0.6.1) because the feature
// is not implemented yet. That is the point of the RED phase: they prove the test
// suite catches the missing behavior. When the GREEN phase lands, these flip to
// passing.
//
// The companion `index.characterization.test.ts` (Wave 4) locks the CURRENT
// behavior; this file asserts the TARGET behavior. They are deliberately kept in
// separate files so the characterization baseline is independent of the new spec.
//
// Coverage map (spec requirement → test):
//   R1  D1  kind field set from PI_TEAMS_WORKER at registration   (worker + interactive)
//   R2  D1  broker validator rejects a non-string `kind`
//   R3  D2  worker hidden from default `list` "Other sessions"
//   R4  D2  `all:true` reveals hidden workers (+ tool schema declares `all`)
//   R5  D2  the calling session is always shown in "Current session" (even if worker)
//   R6  D2  a hidden worker remains addressable by id (display-only filter — CRITICAL)
//   R7  D3  `list` sorted by lastActivity desc, most recent first
//   R8  D4  list rows render the FULL session id (not the 8-char truncation)
//   R9  D5  optional `cwd` filter narrows "Other sessions" by exact match
//          (+ tool schema declares `cwd`)
//   R10 D6  openIntercomOverlay hides workers from the picker (Alt+M)
//
// WHY EACH FAILS TODAY (the "right reason"):
//   R1  buildRegistration ignores PI_TEAMS_WORKER → kind stays undefined.
//   R2  isSessionRegistration does not type-check `kind` → non-string kind is stored.
//   R3  list handler has no kind-hide filter → worker appears.
//   R4  `all` param is ignored + no hide rule → output identical to default.
//   R5  precondition (self.kind === "teams-worker") is not met until R1 lands.
//   R6  precondition (worker hidden from list) is not met until R3 lands.
//   R7  list handler returns broker registration order, no sort.
//   R8  formatSessionListRow uses shortSessionId (slice(0,8)).
//   R9  `cwd` param is ignored → all peers shown regardless.
//   R10 openIntercomOverlay passes allSessions through unfiltered.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SessionInfo, Message } from "./types.ts";

const repoDir = process.cwd();

// Isolated temp HOME so the broker's socket + PID files never collide with the
// user's real intercom dir or with the sibling test files (node:test runs each
// file in its own process, so this env mutation is process-local).
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-red-home-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
const { IntercomClient } = await import("./broker/client.ts");
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Broker harness (mirrors index.characterization.test.ts; duplicated to keep
// this file self-contained + isolated).
// ---------------------------------------------------------------------------

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

async function startBroker(): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn("npx", ["--no-install", "tsx", path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForBrokerReady(broker);
    return broker;
  } catch (error) {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    throw error;
  }
}

async function connectClient(session: Omit<SessionInfo, "id">): Promise<InstanceType<typeof IntercomClient>> {
  const client = new IntercomClient();
  await client.connect(session);
  return client;
}

async function killBroker(broker: ChildProcessWithoutNullStreams): Promise<void> {
  broker.kill("SIGTERM");
  await once(broker, "exit").catch(() => undefined);
}

async function waitForSessionByName(
  client: InstanceType<typeof IntercomClient>,
  name: string,
): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name}; saw ${JSON.stringify(sessions.map((s) => s.name))}`);
}

// Resolves the first inbound `message` event matching a predicate. Used to prove
// a hidden worker still RECEIVES a send (R6) — the CRITICAL display-only guarantee.
function waitForMessage(
  client: InstanceType<typeof IntercomClient>,
  predicate: (message: Message) => boolean,
  timeoutMs = 3000,
): Promise<{ from: SessionInfo; message: Message }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", handler);
      reject(new Error("Timed out waiting for inbound message"));
    }, timeoutMs);
    const handler = (from: SessionInfo, message: Message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      client.off("message", handler);
      resolve({ from, message });
    };
    client.on("message", handler);
  });
}

// A peer that declares `kind` (i.e. a "teams-worker"). The broker accepts the
// field today (permissive validator) and stores it; it is how a worker would
// appear once buildRegistration reads PI_TEAMS_WORKER.
function workerRegistration(opts: {
  name: string;
  kind?: string;
  cwd?: string;
  lastActivity: number;
}): Omit<SessionInfo, "id"> {
  return {
    name: opts.name,
    cwd: opts.cwd ?? "/repo/work",
    model: "worker-model",
    pid: 4000 + Math.floor(Math.random() * 1000),
    startedAt: 0,
    lastActivity: opts.lastActivity,
    kind: opts.kind ?? "teams-worker",
  } as Omit<SessionInfo, "id">;
}

function peerRegistration(opts: {
  name: string;
  cwd?: string;
  model?: string;
  startedAt?: number;
  lastActivity: number;
}): Omit<SessionInfo, "id"> {
  return {
    name: opts.name,
    cwd: opts.cwd ?? "/repo/work",
    model: opts.model ?? "peer-model",
    pid: 1000 + Math.floor(Math.random() * 1000),
    startedAt: opts.startedAt ?? 0,
    lastActivity: opts.lastActivity,
  };
}

// ---------------------------------------------------------------------------
// Extension harness (mirrors createExtensionHarness in the characterization +
// integration tests). Captures the registered tools/commands and lets us drive
// the tool's execute().
// ---------------------------------------------------------------------------

interface CapturedToolResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
  details?: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<CapturedToolResult>;
}

function createExtensionHarness(sessionName: string, options: { hasUI?: boolean; ui?: unknown } = {}) {
  const events = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: CapturedTool[] = [];
  const pi = {
    getSessionName: () => sessionName,
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    registerMessageRenderer: () => undefined,
    registerTool: (tool: CapturedTool) => {
      tools.push(tool);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, command.handler);
    },
    registerShortcut: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  };
  const ctx = {
    cwd: repoDir,
    model: { id: "self-model" },
    sessionManager: { getSessionId: () => "session-red-self" },
    isIdle: () => true,
    hasUI: options.hasUI ?? false,
    abort: () => undefined,
    ui: options.ui,
  };
  return {
    pi,
    ctx,
    tools,
    commands,
    async emitLifecycle(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, eventContext);
      }
    },
  };
}

async function loadExtension(harness: ReturnType<typeof createExtensionHarness>): Promise<CapturedTool> {
  const { default: piIntercomExtension } = await import("./index.ts");
  piIntercomExtension(harness.pi as never);
  const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
  assert.ok(intercomTool, "intercom tool was registered");
  return intercomTool;
}

async function invokeTool(
  intercomTool: CapturedTool,
  ctx: unknown,
  params: Record<string, unknown>,
): Promise<CapturedToolResult> {
  return intercomTool.execute("tc-call", params, new AbortController().signal, undefined, ctx);
}

async function invokeList(
  intercomTool: CapturedTool,
  ctx: unknown,
  params: Record<string, unknown> = { action: "list" },
): Promise<string> {
  const result = await invokeTool(intercomTool, ctx, params);
  return result.content[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// R1 — D1: a session started with PI_TEAMS_WORKER=1 registers kind="teams-worker";
//         an interactive session registers WITHOUT kind.
// ---------------------------------------------------------------------------

test("R1a: PI_TEAMS_WORKER=1 session registers with kind === 'teams-worker'", { concurrency: false }, async () => {
  const broker = await startBroker();
  const previousTeamsWorker = process.env.PI_TEAMS_WORKER;
  process.env.PI_TEAMS_WORKER = "1";
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    const harness = createExtensionHarness("red-teams-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    try {
      await harness.emitLifecycle("session_start");
      const self = await waitForSessionByName(observer, "red-teams-self");

      // TARGET (D1): buildRegistration reads PI_TEAMS_WORKER and tags the session.
      assert.equal(
        (self as { kind?: string }).kind,
        "teams-worker",
        "expected kind to equal 'teams-worker' for a PI_TEAMS_WORKER=1 session",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    if (previousTeamsWorker === undefined) delete process.env.PI_TEAMS_WORKER;
    else process.env.PI_TEAMS_WORKER = previousTeamsWorker;
    await killBroker(broker);
  }
});

test("R1b: an interactive session (no PI_TEAMS_WORKER) registers WITHOUT kind", { concurrency: false }, async () => {
  // NOTE: this is a forward-looking GUARD. It passes today (buildRegistration
  // already omits kind) and MUST keep passing once R1a lands — the feature must
  // not tag interactive sessions.
  const broker = await startBroker();
  const previousTeamsWorker = process.env.PI_TEAMS_WORKER;
  delete process.env.PI_TEAMS_WORKER;
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    const harness = createExtensionHarness("red-interactive-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    try {
      await harness.emitLifecycle("session_start");
      const self = await waitForSessionByName(observer, "red-interactive-self");

      assert.equal(
        (self as { kind?: string }).kind,
        undefined,
        "interactive session must not declare a kind",
      );
      assert.equal("kind" in self, false, "interactive SessionInfo must not carry a kind key");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    if (previousTeamsWorker === undefined) delete process.env.PI_TEAMS_WORKER;
    else process.env.PI_TEAMS_WORKER = previousTeamsWorker;
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R2 — D1: isSessionRegistration rejects a non-string `kind`.
// Probed through the broker socket: a malformed `kind` MUST NOT be stored.
// ---------------------------------------------------------------------------

test("R2: broker rejects a registration whose `kind` is a non-string (number)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    try {
      // A non-string kind must be rejected. Today the validator ignores `kind`
      // entirely, so the registration is accepted and the session appears.
      const bad = {
        name: "bad-kind-worker",
        cwd: "/repo/work",
        model: "m",
        pid: 7,
        startedAt: 0,
        lastActivity: 100,
        kind: 12345,
      } as Omit<SessionInfo, "id">;
      // connect() resolves today; after GREEN it rejects (socket destroyed by
      // the broker). Either way the observable is "is the bad session stored?".
      const badClient = await connectClient(bad).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const sessions = await observer.listSessions();
      const stored = sessions.find((s) => s.name === "bad-kind-worker");
      // TARGET (D1/D6): an invalid kind MUST be rejected, so the session is absent.
      assert.equal(
        stored,
        undefined,
        `broker must reject a non-string kind; got kind=${JSON.stringify(
          (stored as { kind?: unknown } | undefined)?.kind,
        )}`,
      );
      // Cleanup: tear down the (today-accepted) bad client so it does not leak.
      await badClient?.disconnect().catch(() => undefined);
    } finally {
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R3 — D2: a kind:"teams-worker" peer is hidden from the default list.
// ---------------------------------------------------------------------------

test("R3: a kind:teams-worker peer does NOT appear in default list 'Other sessions'", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-hide-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-hide-self");

      await connectClient(peerRegistration({ name: "interactive-peer", lastActivity: 1 }));
      await connectClient(workerRegistration({ name: "hidden-worker", lastActivity: 2 }));
      await waitForSessionByName(observer, "hidden-worker");

      const listResult = await invokeList(intercomTool, harness.ctx);
      // The interactive peer is still shown ...
      assert.match(listResult, /interactive-peer/);
      // ... but a background-role (kind) worker MUST be hidden by default.
      assert.equal(
        /hidden-worker/.test(listResult),
        false,
        "a kind:teams-worker session must NOT appear in the default list",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R4 — D2: `all:true` reveals hidden workers; default hides them (so the two
// outputs differ). Also: the tool schema MUST declare `all`.
// ---------------------------------------------------------------------------

test("R4: all:true reveals a worker hidden by default, and the outputs differ", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-all-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-all-self");

      await connectClient(workerRegistration({ name: "all-worker", lastActivity: 2 }));
      await waitForSessionByName(observer, "all-worker");

      const defaultList = await invokeList(intercomTool, harness.ctx, { action: "list" });
      const allList = await invokeList(intercomTool, harness.ctx, {
        action: "list",
        all: true,
      } as Record<string, unknown>);

      // TARGET (D2): default hides the worker ...
      assert.equal(
        /all-worker/.test(defaultList),
        false,
        "default list must hide a kind:teams-worker session",
      );
      // ... while all:true reveals it ...
      assert.match(allList, /all-worker/, "all:true must include background-role sessions");
      // ... so the two outputs are NOT identical (all is the non-lossy complement).
      assert.notEqual(defaultList, allList, "all:true must change the list output when a worker is present");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("R4-schema: the intercom tool schema declares the optional `all` param", async () => {
  const harness = createExtensionHarness("red-schema-all");
  const intercomTool = await loadExtension(harness);
  const properties = (intercomTool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(properties, "tool parameters schema has a properties object");
  assert.equal("all" in properties, true, "the intercom tool must declare an optional `all` param");
});

// ---------------------------------------------------------------------------
// R5 — D2: the calling session is always shown in "Current session", even when
//         the caller itself is a worker (kind set).
//
// This test first establishes the precondition (self is tagged a worker — the
// R1 behavior), then asserts the invariant (self still rendered as current).
// ---------------------------------------------------------------------------

test("R5: a worker-tagged caller is still shown in 'Current session'", { concurrency: false }, async () => {
  const broker = await startBroker();
  const previousTeamsWorker = process.env.PI_TEAMS_WORKER;
  process.env.PI_TEAMS_WORKER = "1";
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    const harness = createExtensionHarness("red-current-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    try {
      await harness.emitLifecycle("session_start");
      const self = await waitForSessionByName(observer, "red-current-self");

      // Precondition (D1): the caller is tagged a worker. Fails today because
      // buildRegistration ignores PI_TEAMS_WORKER — this is why the test is RED.
      assert.equal(
        (self as { kind?: string }).kind,
        "teams-worker",
        "precondition: caller must be tagged teams-worker to test the worker-self case",
      );

      // Invariant (D2): even though self has kind, it is always shown as current.
      const listResult = await invokeList(intercomTool, harness.ctx);
      assert.match(listResult, /\*\*Current session:\*\*/);
      assert.match(listResult, /red-current-self/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    if (previousTeamsWorker === undefined) delete process.env.PI_TEAMS_WORKER;
    else process.env.PI_TEAMS_WORKER = previousTeamsWorker;
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R6 — D2 / impact-analysis HIGH-risk: a worker hidden from the list MUST still
// receive a message addressed by id. The filter is DISPLAY-ONLY; pushing it into
// listSessions()/broker list would break this. This test guards that contract.
//
// It first asserts the worker is hidden (R3 behavior), then sends to it by id
// and asserts delivery. The hide assertion is what fails today (RED); delivery
// already works today and MUST keep working once the hide lands.
// ---------------------------------------------------------------------------

test("R6: a worker hidden from the list still receives a send by id", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-deliver-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-deliver-self");

      const worker = await connectClient(workerRegistration({ name: "deliver-worker", lastActivity: 2 }));
      await waitForSessionByName(observer, "deliver-worker");

      // Step 1 (D2): the worker is hidden from the default list. RED today — it
      // is currently shown. This is the precondition for "hidden but addressable".
      const defaultList = await invokeList(intercomTool, harness.ctx);
      assert.equal(
        /deliver-worker/.test(defaultList),
        false,
        "precondition: worker must be hidden from the list to test hidden-but-addressable",
      );

      // Step 2 (D2, CRITICAL): despite being hidden, a message addressed by id is
      // delivered. ResolvesSessionTarget / broker findSessions must NOT be filtered.
      const workerId = (await observer.listSessions()).find((s) => s.name === "deliver-worker")!.id;
      const received = waitForMessage(worker, (message) => message.content.text === "ping-hidden-worker");
      const delivered = await observer.send(workerId, { text: "ping-hidden-worker" });
      assert.equal(delivered.delivered, true, "send to a hidden worker by id must be accepted by the broker");
      const { from, message } = await received;
      assert.equal(message.content.text, "ping-hidden-worker");
      assert.equal(from.name, "observer", "message should be delivered from the named sender");

      await worker.disconnect();
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R7 — D3: list is sorted by lastActivity descending (most recent first).
// ---------------------------------------------------------------------------

test("R7: 'Other sessions' are sorted by lastActivity desc (most recent first)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-sort-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-sort-self");

      // Register Alpha, Bravo, Charlie in that order, but with lastActivity set
      // out of order: Alpha=3000 (newest), Charlie=2000, Bravo=1000 (oldest).
      // Sorted desc the order is Alpha, Charlie, Bravo.
      const alpha = await connectClient(peerRegistration({ name: "Alpha", lastActivity: 3000 }));
      const bravo = await connectClient(peerRegistration({ name: "Bravo", lastActivity: 1000 }));
      const charlie = await connectClient(peerRegistration({ name: "Charlie", lastActivity: 2000 }));
      await waitForSessionByName(observer, "Charlie");

      const listResult = await invokeList(intercomTool, harness.ctx);
      const alphaIdx = listResult.indexOf("Alpha");
      const bravoIdx = listResult.indexOf("Bravo");
      const charlieIdx = listResult.indexOf("Charlie");
      assert.ok(alphaIdx !== -1 && bravoIdx !== -1 && charlieIdx !== -1, "all three peers rendered");

      // TARGET (D3): most-recent-first → Alpha (3000) < Charlie (2000) < Bravo (1000).
      assert.ok(alphaIdx < charlieIdx, `Alpha must precede Charlie (newest first); got alpha=${alphaIdx} charlie=${charlieIdx}`);
      assert.ok(charlieIdx < bravoIdx, `Charlie must precede Bravo; got charlie=${charlieIdx} bravo=${bravoIdx}`);

      await alpha.disconnect();
      await bravo.disconnect();
      await charlie.disconnect();
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// R8 — D4: list rows render the FULL session id (not the 8-char truncation).
// ---------------------------------------------------------------------------

test("R8: a list row renders the FULL session id, including the chars past index 8", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-fullid-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      const self = await waitForSessionByName(observer, "red-fullid-self");

      const listResult = await invokeList(intercomTool, harness.ctx);
      assert.match(listResult, /\*\*Current session:\*\*/);

      // TARGET (D4): the full id appears ...
      assert.match(listResult, new RegExp(`\\(${escapeRegExp(self.id)}\\)`), "the row must render the full id in parens");
      // ... in particular the tail past the 8th char (which shortSessionId drops).
      const tail = self.id.slice(8);
      assert.ok(tail.length > 0, "test session id is long enough to have a tail past char 8");
      assert.ok(
        listResult.includes(tail),
        "list row must include the id tail past the first 8 chars (full id, not shortSessionId)",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// R9 — D5: optional `cwd` filter narrows "Other sessions" by exact cwd match.
//         Also: the tool schema MUST declare `cwd`.
// ---------------------------------------------------------------------------

test("R9: cwd filter narrows 'Other sessions' to exact-match peers", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("red-cwd-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-cwd-self");

      const inA1 = await connectClient(peerRegistration({ name: "in-repo-a1", cwd: "/repo/a", lastActivity: 1 }));
      const inA2 = await connectClient(peerRegistration({ name: "in-repo-a2", cwd: "/repo/a", lastActivity: 2 }));
      const inB = await connectClient(peerRegistration({ name: "in-repo-b", cwd: "/repo/b", lastActivity: 3 }));
      await waitForSessionByName(observer, "in-repo-b");

      const scoped = await invokeList(intercomTool, harness.ctx, {
        action: "list",
        cwd: "/repo/a",
      } as Record<string, unknown>);

      // TARGET (D5): only exact-match /repo/a peers appear ...
      assert.match(scoped, /in-repo-a1/);
      assert.match(scoped, /in-repo-a2/);
      // ... and the /repo/b peer is excluded.
      assert.equal(
        /in-repo-b/.test(scoped),
        false,
        "cwd filter must exclude peers whose cwd is not an exact match",
      );
      // Exact match only: a near-match (trailing slash) must NOT bring /repo/b in.
      const nearMiss = await invokeList(intercomTool, harness.ctx, {
        action: "list",
        cwd: "/repo/b/",
      } as Record<string, unknown>);
      assert.equal(
        /in-repo-b/.test(nearMiss),
        false,
        "cwd filter must be exact (trailing-slash variant must not match /repo/b)",
      );

      await inA1.disconnect();
      await inA2.disconnect();
      await inB.disconnect();
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("R9-schema: the intercom tool schema declares the optional `cwd` param", async () => {
  const harness = createExtensionHarness("red-schema-cwd");
  const intercomTool = await loadExtension(harness);
  const properties = (intercomTool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(properties, "tool parameters schema has a properties object");
  assert.equal("cwd" in properties, true, "the intercom tool must declare an optional `cwd` param");
});

// ---------------------------------------------------------------------------
// R10 — D6 / task 3.7: openIntercomOverlay hides kind-set sessions from the
//       picker, keeping list and overlay discovery surfaces consistent.
//
// Driven through the registered `intercom` command; the overlay factory is
// captured to inspect which sessions reach the picker (mirrors the
// characterization E2 pattern).
// ---------------------------------------------------------------------------

test("R10: openIntercomOverlay excludes a kind:teams-worker session from the picker", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    let capturedOverlayText: string | undefined;
    const overlayTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
    const overlayKeybindings = { getKeys: (_action: string) => ["Enter"] };
    const ui = {
      notify: () => undefined,
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => { render(width: number): string[] },
      ) => {
        const overlay = factory(undefined, overlayTheme, overlayKeybindings, () => undefined);
        capturedOverlayText = overlay.render(120).join("\n");
        return undefined;
      },
    };
    const harness = createExtensionHarness("red-overlay-self", { hasUI: true, ui });
    await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "red-overlay-self");

      await connectClient(peerRegistration({ name: "overlay-interactive", lastActivity: 1 }));
      await connectClient(workerRegistration({ name: "overlay-worker", lastActivity: 2 }));
      await waitForSessionByName(observer, "overlay-worker");

      const openOverlay = harness.commands.get("intercom");
      assert.ok(openOverlay, "intercom overlay command registered");
      await openOverlay("", harness.ctx);

      assert.ok(capturedOverlayText, "overlay was rendered");
      // The interactive peer remains selectable ...
      assert.match(capturedOverlayText, /overlay-interactive/);
      // ... but the kind:teams-worker session MUST NOT reach the picker (D6/3.7).
      assert.equal(
        /overlay-worker/.test(capturedOverlayText),
        false,
        "openIntercomOverlay must hide kind:teams-worker sessions from the picker",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});
