// Wave 4 — Characterization tests: lock CURRENT behavior.
//
// These tests pin the behavior of the files that the `add-session-list-filtering`
// openspec change will modify (`types.ts`, `broker/broker.ts`, `index.ts`,
// `ui/session-list.ts`) as of HEAD d264d01 (v0.6.1).
//
// They MUST pass against unmodified HEAD. Wave 5 (RED phase) will add FAILING
// tests for the NEW behavior (full id, sort-by-lastActivity, hide-by-kind,
// cwd/all params). These baseline tests characterize what exists today so the
// intended deltas are observable.
//
// Characterization targets (all 6 from the Wave 4 brief):
//   A. broker isSessionRegistration is permissive (accepts missing `kind`, accepts
//      unknown extra fields, accepts `kind` of any type today).
//   B. broker list handler returns ALL sessions (no kind/cwd filtering).
//   C. buildRegistration does NOT read PI_TEAMS_WORKER (no `kind` field today).
//   D. formatSessionListRow renders the 8-char shortSessionId; the list handler is
//      unsorted (registration order), shows all peers, and cwd/all params have no
//      effect today (and are not declared in the tool schema).
//   E. openIntercomOverlay / SessionListOverlay show ALL sessions today (no worker
//      filter) and render the 8-char short id.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SessionInfo } from "./types.ts";

const repoDir = process.cwd();

// Isolated temp HOME so the broker's socket + PID files never collide with the
// user's real intercom dir or with the sibling integration test (node:test runs
// each file in its own process, so this env mutation is process-local).
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-char-home-"));
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
// Broker harness (mirrors intercom.integration.test.ts; duplicated intentionally
// to keep this baseline file self-contained + isolated from the integration test).
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

// Minimal peer factory. lastActivity is passed through verbatim so list-ordering
// characterization can register peers out-of-activity-order on purpose.
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
// Extension harness (mirrors createExtensionHarness in intercom.integration.test.ts).
// Captures the registered tools/commands and lets us drive the tool's execute().
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
    sessionManager: { getSessionId: () => "session-char-self" },
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

async function invokeList(
  intercomTool: CapturedTool,
  ctx: unknown,
  params: Record<string, unknown> = { action: "list" },
): Promise<string> {
  const result = await intercomTool.execute("tc-list", params, new AbortController().signal, undefined, ctx);
  return result.content[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Section A — broker isSessionRegistration is permissive (target #5/#6).
//
// isSessionRegistration() is module-private in broker/broker.ts, so we
// characterize it through the broker's registration behavior over a real socket.
// ---------------------------------------------------------------------------

test("A1: register with only required fields succeeds", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const client = await connectClient({
      cwd: "/repo/work",
      model: "m",
      pid: 1,
      startedAt: 0,
      lastActivity: 100,
    });
    // connect() resolves only after the broker accepted the registration and
    // replied "registered", so reaching this line means the validator passed.
    const sessions = await client.listSessions();
    assert.equal(sessions.length, 1);
    await client.disconnect();
  } finally {
    await killBroker(broker);
  }
});

test("A2: register with an unknown extra field is accepted (not rejected)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    // Today the validator checks only the known required/optional fields; it does
    // NOT reject unknown keys. Wave 5 keeps this for unknown fields (only `kind`
    // gets type-checked).
    const session = {
      cwd: "/repo/work",
      model: "m",
      pid: 2,
      startedAt: 0,
      lastActivity: 100,
      customUnknownField: "anything",
    } as Omit<SessionInfo, "id">;
    const client = await connectClient(session);
    const sessions = await client.listSessions();
    assert.equal(sessions.length, 1);
    await client.disconnect();
  } finally {
    await killBroker(broker);
  }
});

test("A3: register with a string `kind` is accepted today (permissive extra field)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    // Baseline Wave 5 preserves for string kind: accepted + propagated verbatim.
    // Today `kind` is simply an unknown extra field and is accepted.
    const session = {
      cwd: "/repo/work",
      model: "m",
      pid: 3,
      startedAt: 0,
      lastActivity: 100,
      kind: "teams-worker",
    } as Omit<SessionInfo, "id">;
    const client = await connectClient(session);
    const sessions = await client.listSessions();
    const stored = sessions[0];
    // The broker stores {...session, id} and never strips unknown keys, so the
    // `kind` field round-trips through the list response.
    assert.equal((stored as { kind?: string }).kind, "teams-worker");
    await client.disconnect();
  } finally {
    await killBroker(broker);
  }
});

test("A4: register with a NON-string `kind` is ACCEPTED today (Wave 5 flips this to REJECTED)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    // Today the validator does not type-check `kind` (it is an unknown extra
    // field), so a non-string `kind` is accepted. Wave 5 will reject this.
    const session = {
      cwd: "/repo/work",
      model: "m",
      pid: 4,
      startedAt: 0,
      lastActivity: 100,
      kind: 12345,
    } as Omit<SessionInfo, "id">;
    const client = await connectClient(session);
    const sessions = await client.listSessions();
    assert.equal(sessions.length, 1);
    await client.disconnect();
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// Section B — broker list handler returns ALL sessions (target #6).
// ---------------------------------------------------------------------------

test("B1: a worker-named peer appears in the broker's list response (no filtering today)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    const worker = await connectClient(peerRegistration({ name: "teams-worker-a", lastActivity: 2 }));
    await waitForSessionByName(observer, "teams-worker-a");

    const sessions = await observer.listSessions();
    const names = sessions.map((s) => s.name).sort();
    // The broker list handler returns every connected session; a worker-named
    // peer is present (no hide/filter logic exists today).
    assert.ok(names.includes("teams-worker-a"));
    assert.deepEqual(names, ["observer", "teams-worker-a"]);

    await worker.disconnect();
    await observer.disconnect();
  } finally {
    await killBroker(broker);
  }
});

// ---------------------------------------------------------------------------
// Section C — buildRegistration does NOT read PI_TEAMS_WORKER (target #1).
// ---------------------------------------------------------------------------

test("C1: a session started with PI_TEAMS_WORKER=1 registers WITHOUT a kind field today", { concurrency: false }, async () => {
  const broker = await startBroker();
  const previousTeamsWorker = process.env.PI_TEAMS_WORKER;
  process.env.PI_TEAMS_WORKER = "1";
  try {
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    const harness = createExtensionHarness("char-teams-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    try {
      await harness.emitLifecycle("session_start");
      // The extension registers in a setTimeout(0) after session_start; by the
      // time the observer sees the session, buildRegistration() has already run.
      await waitForSessionByName(observer, "char-teams-self");

      const listResult = await invokeList(intercomTool, harness.ctx);
      // The list output is rendered at all (registration succeeded).
      assert.match(listResult, /\*\*Current session:\*\*/);

      const sessions = await observer.listSessions();
      const self = sessions.find((s) => s.name === "char-teams-self");
      assert.ok(self, "self session registered");
      // TODAY buildRegistration ignores PI_TEAMS_WORKER -> kind is absent.
      // (Wave 5 flips this to kind === "teams-worker".)
      assert.equal((self as { kind?: string }).kind, undefined);
      assert.equal("kind" in self, false, "no kind key on SessionInfo today");
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
// Section D — formatSessionListRow (8-char id) + list handler (target #2/#3).
// ---------------------------------------------------------------------------

test("D1: list rows render the 8-char shortSessionId, NOT the full id", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("char-list-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 1 }));
    try {
      await harness.emitLifecycle("session_start");
      const self = await waitForSessionByName(observer, "char-list-self");

      const listResult = await invokeList(intercomTool, harness.ctx);
      // The current-session row exists.
      assert.match(listResult, /\*\*Current session:\*\*/);
      // The row shows the first 8 chars of the id in parens ...
      const short = self.id.slice(0, 8);
      assert.match(listResult, new RegExp(`\\(${short}\\)`));
      // ... and does NOT show the full id (chars after the 8th never appear).
      const tail = self.id.slice(8);
      assert.equal(
        listResult.includes(tail),
        false,
        "full id tail must NOT appear in list rows (shortSessionId baseline)",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("D2: list is unsorted today (broker registration order, NOT lastActivity desc)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("char-sort-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "char-sort-self");

      // Register peers IN ORDER Alpha, Bravo, Charlie but with lastActivity set
      // out-of-order: Alpha=3000 (newest), Charlie=2000, Bravo=1000 (oldest).
      // If sorted by lastActivity desc the order would be Alpha, Charlie, Bravo.
      // Today there is NO sort, so the rendered order is registration order:
      // Alpha, Bravo, Charlie.
      const alpha = await connectClient(peerRegistration({ name: "Alpha", lastActivity: 3000 }));
      const bravo = await connectClient(peerRegistration({ name: "Bravo", lastActivity: 1000 }));
      const charlie = await connectClient(peerRegistration({ name: "Charlie", lastActivity: 2000 }));
      await waitForSessionByName(observer, "Charlie");

      const listResult = await invokeList(intercomTool, harness.ctx);
      const alphaIdx = listResult.indexOf("Alpha");
      const bravoIdx = listResult.indexOf("Bravo");
      const charlieIdx = listResult.indexOf("Charlie");
      assert.ok(alphaIdx !== -1 && bravoIdx !== -1 && charlieIdx !== -1, "all three peers rendered");

      // Registration order: Alpha < Bravo < Charlie (NOT the activity-desc order
      // Alpha < Charlie < Bravo). This pins the "no sort" baseline.
      assert.ok(alphaIdx < bravoIdx, `Alpha before Bravo (got alpha=${alphaIdx} bravo=${bravoIdx})`);
      assert.ok(bravoIdx < charlieIdx, `Bravo before Charlie (got bravo=${bravoIdx} charlie=${charlieIdx})`);

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

test("D3: list shows ALL peers today, including a worker-named peer (no hide rule)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("char-all-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "char-all-self");

      await connectClient(peerRegistration({ name: "interactive-peer", lastActivity: 1 }));
      await connectClient(peerRegistration({ name: "teams-worker-hidden", lastActivity: 2 }));
      await waitForSessionByName(observer, "teams-worker-hidden");

      const listResult = await invokeList(intercomTool, harness.ctx);
      // Both peers appear today: there is no kind-based hide rule yet.
      assert.match(listResult, /interactive-peer/);
      assert.match(listResult, /teams-worker-hidden/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("D4: cwd param has NO effect today (list is identical with/without it)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("char-cwd-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "char-cwd-self");

      await connectClient(peerRegistration({ name: "in-repo-a", cwd: "/repo/a", lastActivity: 1 }));
      await connectClient(peerRegistration({ name: "in-repo-b", cwd: "/repo/b", lastActivity: 2 }));
      await waitForSessionByName(observer, "in-repo-b");

      const withoutCwd = await invokeList(intercomTool, harness.ctx, { action: "list" });
      // Passing cwd today is ignored by the (non-existent) handler: both peers
      // still appear regardless of the value.
      const withCwd = await invokeList(intercomTool, harness.ctx, {
        action: "list",
        cwd: "/repo/a",
      } as Record<string, unknown>);
      assert.match(withCwd, /in-repo-a/);
      assert.match(withCwd, /in-repo-b/);
      assert.equal(withoutCwd, withCwd, "cwd param must have no effect today");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("D5: all param has NO effect today (list is identical with/without it)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    const harness = createExtensionHarness("char-allflag-self", { hasUI: true });
    const intercomTool = await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "char-allflag-self");

      await connectClient(peerRegistration({ name: "peer-one", lastActivity: 1 }));
      await connectClient(peerRegistration({ name: "peer-two", lastActivity: 2 }));
      await waitForSessionByName(observer, "peer-two");

      const withoutAll = await invokeList(intercomTool, harness.ctx, { action: "list" });
      const withAll = await invokeList(intercomTool, harness.ctx, {
        action: "list",
        all: true,
      } as Record<string, unknown>);
      // `all` is ignored today: identical output, all peers shown either way.
      assert.equal(withoutAll, withAll, "all param must have no effect today");
      assert.match(withAll, /peer-one/);
      assert.match(withAll, /peer-two/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});

test("D6: the intercom tool schema does NOT declare cwd or all params today", async () => {
  const harness = createExtensionHarness("char-schema-self");
  const intercomTool = await loadExtension(harness);
  const properties = (intercomTool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(properties, "tool parameters schema has a properties object");
  // Wave 5 adds cwd + all. Today they are absent from the declared schema.
  assert.equal("cwd" in properties, false, "cwd must not be declared today");
  assert.equal("all" in properties, false, "all must not be declared today");
  // The baseline set of params.
  assert.ok("action" in properties);
  assert.ok("to" in properties);
});

// ---------------------------------------------------------------------------
// Section E — openIntercomOverlay / SessionListOverlay (target #4).
//
// openIntercomOverlay drives ctx.ui.custom(...) (a TUI surface), which makes the
// full overlay flow hard to assert on in isolation. We characterize it two ways:
//   E1. a low-level unit assertion directly on SessionListOverlay.render()
//       (the display + filter logic), and
//   E2. an integration assertion that drives openIntercomOverlay through the
//       harness command and captures what sessions reach the overlay.
// ---------------------------------------------------------------------------

test("E1: SessionListOverlay.render shows ALL passed sessions (no kind filter) and uses the 8-char id", async () => {
  const { SessionListOverlay } = await import("./ui/session-list.ts");
  const fullId = "abcdef1234567890fedcba9876543210";
  const current: SessionInfo = {
    id: "current-session-id",
    name: "me",
    cwd: "/repo",
    model: "self-model",
    pid: 1,
    startedAt: 0,
    lastActivity: 100,
  };
  const interactive: SessionInfo = {
    id: fullId,
    name: "interactive-peer",
    cwd: "/repo",
    model: "m",
    pid: 2,
    startedAt: 0,
    lastActivity: 50,
  };
  // Today SessionInfo has no `kind`; the overlay must not filter on it. We pass a
  // session carrying an extra `kind` to prove the render path ignores it today.
  const worker = {
    id: "worker00000000id",
    name: "teams-worker-peer",
    cwd: "/repo",
    model: "m",
    pid: 3,
    startedAt: 0,
    lastActivity: 25,
    kind: "teams-worker",
  } as SessionInfo;

  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const keybindings = { getKeys: (_action: string) => ["Enter"] };
  const overlay = new SessionListOverlay(
    theme as never,
    keybindings as never,
    current,
    [interactive, worker],
    () => undefined,
  );

  const text = overlay.render(120).join("\n");

  // Both sessions are shown today: no kind-based hide rule in the overlay.
  assert.match(text, /interactive-peer/);
  assert.match(text, /teams-worker-peer/);
  // The 8-char short id is rendered, the full id is not.
  assert.ok(text.includes(fullId.slice(0, 8)), "overlay renders the 8-char short id");
  assert.equal(text.includes(fullId.slice(8)), false, "overlay must not render the full id tail today");
});

test("E2: openIntercomOverlay passes ALL sessions to the picker today (worker-named peer shown)", { concurrency: false }, async () => {
  const broker = await startBroker();
  try {
    let capturedOverlayText: string | undefined;
    // Minimal stand-ins for the TUI theme/keybindings the real SessionListOverlay
    // factory needs to render. fg/bold are passthroughs; getKeys feeds the footer.
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
        // Drive the real SessionListOverlay factory to capture what sessions the
        // overlay actually received, then cancel selection (done(undefined)).
        const overlay = factory(undefined, overlayTheme, overlayKeybindings, () => undefined);
        capturedOverlayText = overlay.render(120).join("\n");
        return undefined;
      },
    };
    const harness = createExtensionHarness("char-overlay-self", { hasUI: true, ui });
    await loadExtension(harness);
    const observer = await connectClient(peerRegistration({ name: "observer", lastActivity: 0 }));
    try {
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(observer, "char-overlay-self");

      await connectClient(peerRegistration({ name: "teams-worker-overlay", lastActivity: 1 }));
      await waitForSessionByName(observer, "teams-worker-overlay");

      // openIntercomOverlay is registered as the `intercom` command (Alt+M).
      const openOverlay = harness.commands.get("intercom");
      assert.ok(openOverlay, "intercom overlay command registered");
      await openOverlay("", harness.ctx);

      // Today the overlay receives every other session (no kind/cwd filter), so
      // the worker-named peer is selectable in the picker.
      assert.ok(capturedOverlayText, "overlay was rendered");
      assert.match(capturedOverlayText, /teams-worker-overlay/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
    }
  } finally {
    await killBroker(broker);
  }
});
