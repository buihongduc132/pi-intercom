## 1. Protocol & type foundation

- [ ] 1.1 Add optional `kind?: string` to the `SessionInfo` interface in `types.ts` (carried by `register`, `sessions`, `message`, `presence_update`, `session_joined` automatically — no new message types).
- [ ] 1.2 Extend `isSessionRegistration()` in `broker/broker.ts` (~line 73) to type-check the new field: reject when `kind` is present but not a string. Confirm the register handler's `{ ...clientMessage.session, id }` spread already propagates `kind` into stored `info` and all broadcasts.
- [ ] 1.3 Verify mixed-version safety: an old client (no `kind`) registers and lists without breakage; a new client's `kind` survives an unpatched broker (extra-field-tolerant validator).

## 2. Registration marker

- [ ] 2.1 In `buildRegistration()` (`index.ts:~541`), set `kind: "teams-worker"` when `process.env.PI_TEAMS_WORKER === "1"`; omit `kind` otherwise. Ensure no other code path references the string "teams".

## 3. List rendering & filtering

- [ ] 3.1 In `formatSessionListRow()` (`index.ts:~392`), render the **full** `session.id` instead of `shortSessionId(session.id)`. Keep name + cwd + model + status tags.
- [ ] 3.2 In the `list` action handler (`index.ts:~1359`), sort the "Other sessions" set by `lastActivity` descending (most recent first), stable. Do not sort the "Current session" section.
- [ ] 3.3 In the `list` handler, hide sessions whose `kind` is a non-empty string from the default "Other sessions" set; keep the caller's current session always visible.
- [ ] 3.4 In the `list` handler, honor an optional `all` flag that disables the hide filter (shows hidden peers) without affecting sort or cwd filter.
- [ ] 3.5 In the `list` handler, honor an optional `cwd` param that restricts "Other sessions" to exact-match peers; current session still shown when `cwd` is set.
- [ ] 3.6 Leave `shortSessionId()` (`index.ts:~357`) in place — still used by `formatSessionLabel()` for presence disambiguation.
- [ ] 3.7 **(impact-analysis HIGH-risk gap)** Apply the identical worker-hide filter in `openIntercomOverlay()` (`index.ts:~1715`): filter `allSessions` to exclude `kind`-set peers BEFORE passing to `SessionListOverlay`. Keep the current session always shown. This closes the inconsistency where `intercom list` hides workers but the Alt+M picker shows them. **Do NOT push the filter into `listSessions()` or the broker `list` handler** — that would break `resolveSessionTarget` (send/ask/reply to workers by name) and `duplicateSessionNames`. Display-only.

## 4. Tool parameter schema

- [ ] 4.1 Add optional `cwd: Type.Optional(Type.String(...))` to the `intercom` tool parameters (`index.ts:~1326`) with a description clarifying it filters the list to a working directory.
- [ ] 4.2 Add optional `all: Type.Optional(Type.Boolean(...))` to the `intercom` tool parameters, described as "include background-role (hidden) sessions in the list".

## 5. Tests & verification

- [ ] 5.1 Add/update unit/integration tests covering: worker registers with `kind: "teams-worker"` (and interactive registers without `kind`); broker rejects a non-string `kind`.
- [ ] 5.2 Add list-handler tests: worker hidden by default; `all: true` shows it; current session always shown; hidden worker still receives `send`; sort order is most-recent-first with stable ties; `cwd` filter narrows and is exact; full id appears in rows.
- [ ] 5.3 Run the existing test suite (`npm test` / the integration test file) and confirm no regressions.
- [ ] 5.4 Manual smoke: spawn a session with `PI_TEAMS_WORKER=1` and an interactive session; confirm the interactive session's `list` hides the worker and `list all: true` reveals it.
