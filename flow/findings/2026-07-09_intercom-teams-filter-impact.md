# Impact Analysis — `add-session-list-filtering` (teams-worker filter)

> **Date:** 2026-07-09
> **Change (Wave 2 design):** Mark teams-worker sessions via a new `SessionInfo` field populated from `process.env.PI_TEAMS_WORKER === "1"`; carry it through the broker protocol; filter those sessions out of the `list` action by default; sort list by `lastActivity` desc; show full session id; add an optional `cwd` filter param.
> **Scope:** fork repo `/home/bhd/Documents/Projects/bhd/pi-intercom` (v0.6.1) + cross-repo consumers in `/home/bhd/Documents/Projects/bhd/pi-plugins`.
> **Mode:** Analysis only. No source modified; this is the only artifact created.

---

## TL;DR — key structural facts that drive the whole risk picture

1. **All `SessionInfo`/register validators are permissive (presence-only).** Neither `isSessionRegistration` (broker) nor `isSessionInfo` (client) ever rejects *extra* fields. They only assert the required fields exist with correct types. → Adding an **optional** field cannot break validation in either direction.
2. **The broker carries the field for free.** `register` does `const info = { ...clientMessage.session, id }` and then stores/forwards that same `info` object verbatim in `list`, `session_joined`, `presence_update`, and the `message` `from` payload. Any field a client includes is structurally carried end-to-end with **zero broker code change**. "Carry the field through the protocol" is a *type-level* change, not a wire change.
3. **index.ts does NOT subscribe to `session_joined` / `presence_update` / `session_left`.** It attaches only `message` / `disconnected` / `error` on the client (`attachClientHandlers`, index.ts:690). All session-list state is re-derived from `listSessions()` on demand. → Presence/broadcast messages are currently *unconsumed* by this repo's own UI.
4. **Addressability is decoupled from list visibility.** `findSessions` (broker) and `resolveSessionTarget` (index.ts) both search the live session map / `listSessions()` result. If filtering is applied **only in the `list` display case** (the intended design), workers stay fully reachable by id/name. If filtering is accidentally pushed into the broker `list` handler or a `listSessions()` wrapper, addressability + duplicate-name detection silently break.

---

## 1. `types.ts` — `SessionInfo`

| Surface | File:line | Risk | Why | Mitigation |
|---|---|---|---|---|
| `SessionInfo` interface | `types.ts:1-10` | **LOW** | Adding an optional field (`isTeamsWorker?: boolean`) is purely additive. | None — additive optional field. |
| `ClientMessage` `register` shape | `types.ts:28` (`{ type:"register"; session: Omit<SessionInfo,"id"> }`) | **LOW** | `Omit<SessionInfo,"id">` automatically includes the new optional field. | None — derives from `SessionInfo`. |
| `BrokerMessage` `sessions` / `session_joined` / `presence_update` / `message.from` | `types.ts:31-34` | **LOW** | All reference `SessionInfo` directly → field included automatically. | None. |

**Exhaustive-struct check:** No code anywhere does a strict shape/equality check on a `SessionInfo` object (no `Object.keys` count, no `JSON.stringify` round-trip equality, no schema validator with `additionalProperties:false`). Confirmed via `rg` over both repos. ✅

---

## 2. `broker/broker.ts`

| Surface | File:line | Risk | Why | Mitigation |
|---|---|---|---|---|
| `isSessionRegistration()` validator | `broker.ts:73-93` | **LOW** | Permissive: asserts required `cwd/model/pid/startedAt/lastActivity` + optional `name/status`. Ignores unknown keys. A new optional `isTeamsWorker` passes. | None needed; optionally add an explicit `isTeamsWorker` boolean check for type-safety (not required for interop). |
| `register` handler — spread carry | `broker.ts:179-193` (`{ ...clientMessage.session, id }` at `:190`) | **LOW** | Spread carries any extra field. **No broker change required** for "carry through protocol". | Document that the field is carried structurally; do not hand-edit the spread. |
| `sessions` Map | declared `broker.ts:89`; stored at `broker.ts:192` | **LOW** | Stores full `info`; field persists for session lifetime. | None. |
| `list` handler | `broker.ts:211-216` | **HIGH (design-coupled)** | Returns ALL sessions: `Array.from(this.sessions.values()).map(s => s.info)` (`broker.ts:216`). **Intended design = filter client-side in index.ts**, leaving this untouched. If instead the filter is implemented here, it cascades into `resolveSessionTarget` + `duplicateSessionNames` (see §4, §6). | **Do NOT filter here.** Keep broker list authoritative & complete; filter only in index.ts `list`/overlay display. |
| `send` handler + `findSessions` | `broker.ts:221-270`, `broker.ts:303-311` | **LOW** | Searches the full live map by id OR name, independent of any list filter. Workers stay addressable as long as they remain in the `sessions` Map. | None — confirms "still addressable by id even when hidden from list". |
| `broadcast` (`session_joined`/`presence_update`/`session_left`) | `broker.ts:313-319` | **MED** | Broadcasts to ALL sockets including workers; non-workers receive `session_joined`/`presence_update` for workers (with the new field). index.ts ignores these events (§4), but any future/cross-repo subscriber (session-status) will see worker presence for sessions it was told are "not in the list". | Acceptable; document. If strict consistency is later needed, broker could skip broadcasting worker joins to non-workers — but that is out of scope and would complicate presence. |
| Shutdown idle timer | `broker.ts:115-127` | **LOW** | Counts `sessions.size`; workers count toward "not idle". Correct — a worker IS an active connection. | None. |

**Backward compat (broker side):** old broker + new client → old broker's permissive validator accepts the extra field and carries it. ✅ New broker + old client → field absent, validator treats as optional. ✅

---

## 3. `broker/client.ts`

| Surface | File:line | Risk | Why | Mitigation |
|---|---|---|---|---|
| `isSessionInfo()` validator | `client.ts:58-80` | **LOW** | Permissive (mirror of broker validator). Required `id/cwd/model/pid/startedAt/lastActivity`, optional `name/status`. Ignores unknown keys → a `SessionInfo` carrying `isTeamsWorker` validates in `sessions`, `message`, `presence_update`, `session_joined` handlers. | None. |
| `connect(session)` payload | `client.ts:~155` (`writeMessage(socket, { type:"register", session })`) | **LOW** | Forwards the object verbatim; if `buildRegistration()` includes the field, it is sent. No change needed in client. | None. |
| `listSessions()` | `client.ts:~440-465` | **MED** | Sends `{ type:"list", requestId }`. The optional **cwd filter** param (design item 6) is NOT in the wire protocol. Two options: (a) extend `ClientMessage` `list` with optional `cwd?` + broker filters — but **old brokers ignore `cwd`** and return all, so the client must filter anyway; (b) keep protocol unchanged and filter in index.ts. | **Recommend (b): filter cwd client-side in index.ts.** Avoids a protocol change and stays backward-compatible with old brokers. If (a) is chosen, client MUST still client-side filter as fallback. |
| `handleBrokerMessage` — `sessions`/`message`/`presence_update`/`session_joined` | `client.ts:~230-300` | **LOW** | Each re-validates via `isSessionInfo` (permissive) then emits. Field passes through to event consumers. | None. |
| `updatePresence({name,status,model})` | `client.ts:~510` | **LOW** | Presence only carries name/status/model — `isTeamsWorker` is set once at register and never mutated by presence. A worker that changes model/name stays a worker (field is in the stored `info`, not re-sent). ✅ | None — confirms worker flag is stable across presence updates. |

---

## 4. `index.ts` (main extension)

| Surface | File:line | Risk | Why | Mitigation |
|---|---|---|---|---|
| `buildRegistration()` | `index.ts:535-550` | **LOW** | Returns `Omit<SessionInfo,"id">`. Add `isTeamsWorker: process.env.PI_TEAMS_WORKER === "1"`. Reads `liveContext`/`currentSessionId`/`sessionStartedAt` — env read is side-effect-free. | Add the field; guard env read at module load (cache once) to avoid repeated `process.env` lookups. |
| `list` case (the "list action") | `index.ts:1359-1390` | **MED** | Today: splits self vs others, **no sort** (insertion order), `formatSessionListRow` uses short id. Must add: (a) filter out `isTeamsWorker`; (b) sort `otherSessions` by `lastActivity` desc; (c) accept optional `cwd` param and filter by it. Note `resolveSessionTarget` and `openIntercomOverlay` call the SAME `listSessions()` — filtering must be local to this case only, not in a shared helper. | Apply filter/sort/cwd **inline in this case** on the returned array; do not mutate the shared `listSessions()` path. |
| `formatSessionListRow()` | `index.ts:392-397` | **MED** | Uses `shortSessionId(session.id)` = `slice(0,8)`. "Show full id" → replace with full `session.id`. Also feeds any string/snapshot assertion. README §`list` (README.md:339) documents "short ID" — doc must update. | Change to full id here; update README. (Consider keeping short id only for the dedup-disambiguation in `formatSessionLabel`, index.ts:383 — separate concern.) |
| `resolveSessionTarget()` | `index.ts:786-800` | **HIGH** | Calls `listSessions()` and matches by id then name; throws on duplicate names. **If the worker filter leaks into `listSessions()` (broker-side or a wrapper), workers vanish here → send/ask/reply to a worker BY NAME throws/returns null.** By id the broker fallback (`?? to`) still works, but duplicate-name detection and name resolution break. | **Keep `listSessions()` unfiltered.** Filter is display-only (list case + overlay). Verify no refactor moves the filter into a shared `listSessions` wrapper. |
| send / ask / reply / orchestrator-target paths | `index.ts:861, 1114, 1401, 1485` | **MED→LOW (conditional)** | All do `await resolveSessionTarget(client, to) ?? to`, then `client.send(sendTo,...)`. If resolve returns null (worker hidden), falls back to raw `to`; broker `findSessions` still resolves it. → **Workers remain addressable by exact id/name** as long as broker list stays complete. | Confirms intended "hidden but addressable" semantics hold. Add a test asserting a hidden worker is still deliverable by id. |
| `duplicateSessionNames()` + usage | `index.ts:349-354`, used at `index.ts:1729` (overlay) | **MED** | Runs over the FULL `listSessions()` result. If workers stay in that result (display-only filter), dup detection still covers workers (so two workers sharing a name, or a worker + user sharing a name, are still flagged). If filter leaks into `listSessions()`, workers are silently excluded from dup detection. | Same as resolveSessionTarget: keep `listSessions()` complete. |
| `openIntercomOverlay()` (Alt+M picker) | `index.ts:1715-1745` | **HIGH** | Calls `listSessions()`, runs `duplicateSessionNames(allSessions)`, then renders `SessionListOverlay` with `sessions = allSessions.filter(s => s.id !== mySessionId)`. **It does NOT filter workers** → the overlay picker would SHOW workers even though `intercom list` hides them → inconsistent UX and an accidental "message a worker" surface. | **Apply the identical worker filter in `openIntercomOverlay`** (and decide whether the overlay should also respect the `cwd` filter). This is the single most likely place to be missed. |
| `ui/session-list.ts` `SessionListOverlay` / `sessionTitle` | `ui/session-list.ts:36-42`, `shortSessionId` at `:32` | **MED** | Overlay title also uses `shortSessionId`. If "full id" is wanted in the picker too, change here; otherwise leave (but then list-vs-overlay id format diverges). | Decide scope of "full id": list only, or list+overlay. Document the choice. |
| `status` case | `index.ts:1666-1683` | **LOW** | Reports `Active sessions: ${sessions.length}` over the unfiltered list → counts workers even though they are hidden from `list`. Mild inconsistency (status says N, list shows N−k). | Either filter before counting, or leave and document. Low user impact. |
| presence sync (`syncPresenceIdentity`/`syncPresenceStatus`/`model_select`) | `index.ts:543-562, 1009` | **LOW** | Only sends name/status/model. Never re-sends `isTeamsWorker`. Field stays in broker's stored `info` from register. ✅ | None. |
| incoming-message renderer + `handleIncomingMessage` | `index.ts:696-701`, renderer at `:1023` | **LOW** | `from: SessionInfo` now carries the field; code reads only `from.name`/`from.cwd`/`from.id`. Ignored safely. | None. |
| `deliverLocalSubagentRelayMessage` synthetic sender | `index.ts:802-820` | **LOW** | Builds an inline `SessionInfo`-shaped object (literal fields) for local relay; does not include the new field — fine, it's a synthetic non-worker sender. | None (object literal only needs required fields). |

---

## 5. Cross-repo consumers — `/home/bhd/Documents/Projects/bhd/pi-plugins`

### 5a. `profile/extensions/session-status/tracker.ts` — the named consumer

| Surface | File:line | Risk | Why | Mitigation |
|---|---|---|---|---|
| Local `IntercomSession` interface | `tracker.ts:28-38` | **LOW** | **Duplicate, hand-written interface — NOT imported from pi-intercom.** Adding a field to pi-intercom's `SessionInfo` has **zero** structural effect on it. | None now. If the field is ever needed here, add it to this local interface (it won't auto-sync). |
| `updateFromIntercomList()` field reads | `tracker.ts:68-92` | **LOW** | Reads only `id/name/cwd/model/pid/status/lastActivity/startedAt`. Silently ignores unknown fields → **will not choke** on `isTeamsWorker`. | None. |
| "Mark not-in-list as offline" logic | `tracker.ts:85-90` | **MED (latent)** | Any session absent from the passed list is flipped to `offline`. **If this tracker is ever wired to a worker-filtered list, hidden workers will be marked offline** (or, if they were never seen, simply absent from the snapshot → undercount). | Today: **orphaned** — `updateFromIntercomList` has NO production caller in pi-plugins (only `loadPersisted` feeds the tracker; confirmed by `rg` + GitNexus: zero callers). No current impact. **When wired:** pass the *unfiltered* list to the tracker, OR explicitly accept worker absence and skip the offline-flip for workers. |
| `categorizeStatus()` | `tracker.ts:24-33` | **LOW** | Status taxonomy unaffected; a worker's status string categorizes normally. | None. |

### 5b. Other intercom-touching code in pi-plugins

| Surface | File | Risk | Why |
|---|---|---|---|
| `pi-extension` `serverMultiSession.ts:272`, `session-registry.ts:168` (`listSessions()`) | `profile/packages/pi-extension/` | **NONE** | This is pi-extension's OWN internal multi-session registry (`SessionContext[]`), **unrelated to pi-intercom's `SessionInfo`**. Name collision only. Not a consumer of the intercom protocol. |
| curator-signal probe | `openspec/.../t0-probe.ts:52,59` | **NONE** | Archived openspec probe; imports `IntercomClient` to connect to the live broker. Permissive validators → unaffected. Doc/archive only, not shipped. |
| `flow/intentions/intercom-unified-pubsub.md`, `flow/d2/plugins/pi-intercom.d2` | docs | **NONE** | Documentation/diagrams. Update diagrams if they enumerate `SessionInfo` fields (cosmetic). |

**Conclusion (angle b):** The one real cross-repo consumer (`session-status`) will neither choke on the new field nor break today (it is orphaned). The only latent risk is the offline-flip semantics *if/when* it is wired to a filtered list — flag for that future wiring, not for this change.

---

## 6. Semantics risk — "does any code assume list = all reachable peers?"

| Assumption site | Verdict |
|---|---|
| **Broadcast** (broker → all sockets) | Workers still broadcast/receive presence. No code in this repo listens to those events. ✅ Not broken. |
| **Duplicate-name detection** (`duplicateSessionNames`) | Operates on full `listSessions()` result. **Safe as long as the filter stays display-only** (list case + overlay). If filter leaks into `listSessions()`, workers are silently dropped from dup detection. ⚠️ |
| **Addressability** (send/ask/reply) | Decoupled: `resolveSessionTarget ?? to` + broker `findSessions` over the live map. Workers stay reachable by exact id/name even when hidden from list, **provided the broker `list` stays complete**. ✅ (intended) |
| **session-status snapshot** | Orphaned today. When wired, a filtered list would undercount/flap. Latent only. ⚠️ |
| **`status` action count** | Counts unfiltered; cosmetic mismatch with displayed list. Low. |

**Net:** No code currently treats "list = all reachable peers" in a way that breaks messaging. The danger is purely **implementation discipline**: keep the filter in the display layer (list case + overlay), never in `listSessions()` or the broker.

---

## 7. Test files — what actually needs updating

| File | Risk | Verdict |
|---|---|---|
| `intercom.integration.test.ts` | **MED** | Register payloads (`:198-216`) build session objects with the 6 required fields — **no change needed** for the optional field. Helpers `waitForSessionByName/Status/Model` (`:265-288`) iterate sessions and ignore unknown fields. **No existing assertion checks list sort order or field count**, so the additive field alone breaks nothing. **However:** NEW tests are required (Wave 2) for: worker filtering, lastActivity-desc sort, full-id rendering, cwd filter, env-based marking. Any future test that registers a `PI_TEAMS_WORKER=1` session and asserts it appears in `list` will need the filtered expectation. |
| `reply-tracker.test.ts` | **LOW** | Constructs `from`-like objects (`:8-15`) with only required fields; optional field not required. **Unaffected.** |
| `test/inline-message.test.ts` | **LOW** | Constructs `from: SessionInfo` (`:14-22`) with required fields only. Optional field not required. `InlineMessageComponent` is unrelated to list rendering, so unaffected unless "full id" is (incorrectly) extended to inline messages. **Unaffected by the field; verify full-id scope is list-only.** |
| `broker/spawn.test.ts` | **NONE** | Tests broker **spawn mechanics** (`getBrokerLaunchSpec`, Windows launcher, spawn options). **Zero relation** to `SessionInfo`/register/list. **Will NOT need updating** (corrects the task's assumption). |
| `broker/paths.test.ts` | **NONE** | Tests **socket path resolution** (`getBrokerSocketPath`, named-pipe vs `broker.sock`). **Zero relation** to the protocol. **Will NOT need updating** (corrects the task's assumption). |

**New tests to author (Wave 2):** (1) register with `PI_TEAMS_WORKER=1` → hidden from `list` but present in `listSessions()`/addressable by id; (2) `list` sorted by `lastActivity` desc; (3) full id shown; (4) `cwd` filter param; (5) overlay also hides workers; (6) old-client (no field) + new broker still interoperates.

---

## Backward-Compat Verdict

| Direction | Result | Notes |
|---|---|---|
| **New client → OLD broker** | ✅ **Interop** | Old broker's `isSessionRegistration` is permissive → accepts the extra `isTeamsWorker`; spread `{...session,id}` carries it; `list`/`presence_update`/`session_joined` forward it. New client's `isSessionInfo` accepts. Client-side worker filter still works (field present in payload). **Caveat:** if cwd filter were implemented broker-side, old broker would ignore `cwd` and return all → client must filter anyway (hence recommend client-side cwd filter). |
| **OLD client → NEW broker** | ✅ **Interop** | Old client omits the field; new broker validator treats it as optional → accepts; `info` has no field (undefined). New broker forwards info without field. `session.isTeamsWorker` is falsy → **old clients will SEE worker sessions in their list** (no filtering). This is acceptable degradation, not a break: old clients simply don't know to hide workers. |
| **Protocol wire** | ✅ **No break** | The change is purely additive: one optional field on an already-permissive struct, plus optional client-side display behavior. No message type added/removed, no required field added, no enum value changed. |

**Overall:** ✅✅ Both directions interoperate. The change is safe to ship incrementally; no flag-day upgrade is required. The only observable effect for old clients is that worker sessions remain visible in their list until they upgrade — expected and harmless.

---

## HIGH-risk items (must be handled by Wave 2)

1. **`resolveSessionTarget` addressability** (index.ts:786) — if the worker filter leaks into `listSessions()` or the broker `list` handler, send/ask/reply to workers BY NAME breaks and `duplicateSessionNames` silently drops workers. **Mitigation:** filter is display-only (list case + overlay); never in `listSessions()` or broker.
2. **`openIntercomOverlay` Alt+M picker** (index.ts:1715) — currently shows ALL sessions; without applying the same worker filter it will display workers that `intercom list` hides → inconsistent UX + accidental "message a worker" surface. **Mitigation:** apply identical filter in the overlay (and `SessionListOverlay`).
3. **(Design-coupled) broker `list` handler must stay complete** (broker.ts:167) — the entire "hidden but addressable" semantic, dup detection, and session-status future-wiring all depend on the broker returning the full set. Do not implement the filter here.

## MED-risk items (should be handled)

4. **`listSessions()` cwd filter** (client.ts:440) — implement client-side in index.ts to avoid a wire-protocol change and stay compatible with old brokers.
5. **`formatSessionListRow` full-id change** (index.ts:392) + README:339 — breaks any string assertion; update both.
6. **session-status offline-flip** (pi-plugins tracker.ts:85) — latent; only matters when that orphaned tracker is wired to a (possibly filtered) list. Flag, don't block.
7. **`status` action count** (index.ts:1666) — counts unfiltered; cosmetic mismatch with the filtered `list`.
