# Wave 4 — Characterization tests: verification + teardown-hang finding

> **Date:** 2026-07-09
> **Task:** #5 (Wave 4 — Characterization tests, lock CURRENT behavior, ≥80% coverage, standalone PR)
> **Repo:** `/home/bhd/Documents/Projects/bhd/pi-intercom` (fork)
> **Mode:** This is an analysis/verification note. Created in **untracked** `flow/findings/` so it does not touch any teammate's tracked files in this shared working directory.

---

## 0. Status: Wave 4 is DONE & verified (produced by an earlier pass)

The Wave 4 deliverable already exists on branch **`test/characterization-lock-current-behavior`** (commit `9142102`, pushed to `origin`):

- **File:** `index.characterization.test.ts` (695 lines, + `package.json` test-script wiring — 1 line).
- **Purity ✅:** `git diff main...HEAD --stat` = ONLY `index.characterization.test.ts` (new) + `package.json` (test wiring). No source file (`index.ts`, `types.ts`, `broker/broker.ts`) modified.
- **All 6 characterization targets covered ✅** (see §1).
- **All 14 tests PASS against unmodified HEAD** (see §2).
- **Downstream work is already built on top of it** (see §4 branch landscape) — so the team has accepted and extended it.

> NOTE: I (w3-impact-analyst, task #5) did NOT create this branch — it was produced by an earlier pass and pushed. My work here is **verification + a teardown-reliability finding**. I did not rewrite the shared branch (two other branches depend on commit `9142102`; amending it would orphan them).

---

## 1. Coverage of the 6 characterization targets (angle a)

| # | Target | Tests | Status |
|---|---|---|---|
| 5 | `broker isSessionRegistration` permissive | A1 (required-only ok), A2 (unknown extra field ok), A3 (string `kind` ok), A4 (non-string `kind` ok today) | ✅ |
| 6 | broker `list` returns ALL sessions | B1 (worker-named peer appears) | ✅ |
| 1 | `buildRegistration` ignores `PI_TEAMS_WORKER` | C1 (env=1 → no `kind` field today) | ✅ |
| 2 | `formatSessionListRow` = 8-char id | D1 (short id; full id tail absent) | ✅ |
| 3 | `list` handler: unsorted, unfiltered, no cwd/all params | D2 (registration order, not activity-desc), D3 (all peers incl worker), D4 (cwd no-op), D5 (`all` no-op), D6 (schema lacks cwd/all) | ✅ |
| 4 | `openIntercomOverlay` shows all | E1 (SessionListOverlay.render unit), E2 (overlay integration via command) | ✅ |

---

## 2. Test results (angle b)

- **Pre-existing 5 files** (`broker/paths.test.ts`, `broker/spawn.test.ts`, `reply-tracker.test.ts`, `intercom.integration.test.ts`, `test/inline-message.test.ts`): **41 tests → 40 pass / 1 fail**.
  - The single failure is **test #20 "busy non-interactive sessions auto-reply to top-level asks without aborting"** — the documented **pre-existing timing flake**, NOT caused by Wave 4. Matches the task brief exactly.
- **Characterization file** (`index.characterization.test.ts`): **14 tests → 14 pass / 0 fail** (verified via streamed TAP: `ok 1`…`ok 14`).

### ⚠️ Caveat that blocks a clean combined `npm test` run: teardown HANG (see §3)

When the characterization file runs to completion, all 14 assertions pass, **but the node process does not exit** — it hangs in teardown and must be killed by a timeout. This is why a combined `npm test` did not print a final summary in this environment. Root cause + fix in §3.

---

## 3. ⚠️ FINDING — Teardown hang: orphaned broker processes hold stdio pipes open

### Symptom
All 14 tests print `ok`, but the runner never prints its `# tests` summary and never exits (killed at 240s). `ps` shows **orphaned broker node processes reparented to init (`ppid=1`)**.

### Root cause
`startBroker()` spawns `npx --no-install tsx broker/broker.ts`. The process tree is:
`npx → sh -c → node(tsx loader) → node(broker)`.
`killBroker()` did `broker.kill("SIGTERM")`, which signals **only the direct `npx` child**. The real broker node process (a grandchild) is reparented to init and **keeps running**, still holding the **inherited `stdout`/`stderr` pipe write-ends**. The test runner holds the read-ends; until ALL write-ends close the event loop stays alive → node:test never finalizes/exits. (The sibling `intercom.integration.test.ts` happens to avoid visible hangs because its orphaned brokers self-shutdown via the broker's 5s idle timer once their clients disconnect; the characterization tests' extension clients can pin brokers longer.)

### Fix (ready-to-apply patch — TEST-ONLY, isolated to `index.characterization.test.ts`)
Spawn the broker in its own process group (`detached: true`) and SIGKILL the whole group on teardown. Exact diff:

```diff
 async function startBroker(): Promise<ChildProcessWithoutNullStreams> {
+  // detached:true => broker tree gets its own process group (pgid == broker.pid).
+  // killBroker() then SIGKILLs the whole tree so no grandchild survives to hold
+  // the inherited stdio pipe write-ends open (which would hang the test runner).
   const broker = spawn("npx", ["--no-install", "tsx", path.join(repoDir, "broker", "broker.ts")], {
     cwd: repoDir,
     env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
     stdio: ["ignore", "pipe", "pipe"],
+    detached: true,
   });
   try {
     await waitForBrokerReady(broker);
     return broker;
   } catch (error) {
-    broker.kill("SIGTERM");
-    await once(broker, "exit").catch(() => undefined);
+    await killBrokerTree(broker);
     throw error;
   }
 }

+async function killBrokerTree(broker: ChildProcessWithoutNullStreams): Promise<void> {
+  try {
+    process.kill(-broker.pid, "SIGKILL");   // negative pid => whole process group
+  } catch {
+    broker.kill("SIGTERM");                  // group already gone / not detached
+  }
+  await once(broker, "exit").catch(() => undefined);
+}
+
 async function killBroker(broker: ChildProcessWithoutNullStreams): Promise<void> {
-  broker.kill("SIGTERM");
-  await once(broker, "exit").catch(() => undefined);
+  await killBrokerTree(broker);
 }
```

This same defect also affects `intercom.integration.test.ts` (same spawn/kill pattern). Applying the same `killBrokerTree` there is recommended for parity/robustness.

> **Why I did not commit this myself:** This working directory is **shared with concurrent teammates** (load avg 17, a teammate is mid-edit on `README.md`/`index.filter.test.ts`). Git mutations (`checkout --`, `stash`) are guard-blocked here. I left the edit uncommitted in the working tree on `index.characterization.test.ts` only (it does NOT touch the teammate's files). A human should commit it as a **new commit on `test/characterization-lock-current-behavior`** (NOT an amend — `9142102` has two downstream branches built on it) and/or cherry-pick onto `feat/session-list-filtering`.

---

## 4. Branch landscape (the feature pipeline is already complete)

```
main (d264d01, v0.6.1)
  └─ test/characterization-lock-current-behavior (9142102)  ← Wave 4 (this task) ✅ pushed
       └─ test/red-phase-filter-behavior (dd9f672)          ← Wave 5 RED tests ✅ pushed
            └─ feat/session-list-filtering (b5f9427)        ← FULL FEATURE IMPLEMENTED ✅ pushed
                ("feat: hide teams-worker sessions, sort by activity, show full id, cwd filter")
```

Wave 5 (RED) and the feature implementation are **already pushed** and built directly atop the Wave 4 commit. So the prerequisite (Wave 4) succeeded.

---

## 5. Coverage (angle a) — honest limitation

Could **not** obtain a clean combined coverage number. Reasons:
1. The teardown hang (§3) prevents the full `npm test` from finalizing, and node's `--experimental-test-coverage` emits the report only at a clean exit.
2. `c8` is not installed; per task guidance I used node's built-in `--experimental-test-coverage`.
3. The shared machine is at **load average 17** (other sessions), so each broker-spawning test (`npx --no-install tsx` cold start) takes 30–60s; the full suite exceeds sandbox timeouts / OOMs when all 6 files spawn ~70 brokers in one node process.

**What was verified:** the broker-free tests (D6 schema check, E1 overlay render) run fast, pass, and exit cleanly — confirming the test file parses and non-broker logic is green. The broker tests (A/B/C/D1-D5/E2) each pass individually (streamed TAP `ok`). A definitive line/branch % for `index.ts`/`broker.ts` requires a full clean run on an unloaded machine after the §3 fix lands.

**Expected coverage reality (per the task's own caveat):** `broker/broker.ts` and `types.ts` are high (heavily exercised by integration + characterization). `index.ts` (70KB extension entry wired to the pi host) is **not importable in true isolation** (requires the pi host `ExtensionAPI`); the characterization harness imports it via a stub `pi` and exercises only `buildRegistration`/`list`/`formatSessionListRow`/`openIntercomOverlay`, so full-file 80% on `index.ts` is only reachable via the combined integration+characterization run — not in isolation. This matches the task's "be honest about the gap" guidance.

---

## 6. PR status (deliverable item)

`gh` is currently **API rate-limited** (`GraphQL: API rate limit already exceeded for user ID 5408008`), so I could not open or query the PR programmatically. The branch **is** pushed (`origin/test/characterization-lock-current-behavior`, tracking clean). Human-runnable command once rate limit resets:

```bash
cd /home/bhd/Documents/Projects/bhd/pi-intercom
gh pr create \
  --base main \
  --head test/characterization-lock-current-behavior \
  --title "test: characterization tests — lock behavior before list-filtering change" \
  --body "Baseline-locking tests (Wave 4) for the add-session-list-filtering openspec change. Pins current behavior of types.ts/broker.ts/index.ts/ui/session-list.ts before the feature lands. All 14 new tests pass against HEAD; the only suite failure is the pre-existing flaky test #20 (busy non-interactive auto-reply). See openspec/changes/add-session-list-filtering/."
```

---

## 7. Human actions requested (coordination — shared directory)

1. **Commit the teardown fix** (§3 patch) as a NEW commit on `test/characterization-lock-current-behavior` (do not amend `9142102`) and/or cherry-pick to `feat/session-list-filtering`. Apply the same to `intercom.integration.test.ts` for parity.
2. **Open the PR** via the command in §6 (once gh rate limit resets).
3. **My uncommitted working-tree edit** on `index.characterization.test.ts` is exactly the §3 patch (verified: `git diff index.characterization.test.ts` shows only the killBroker changes; it does NOT touch the teammate's `README.md`/`index.filter.test.ts`). Decide keep-or-discard during commit.
