## Why

When `pi-agent-teams` spawns worker sessions, those workers register with the
intercom broker just like interactive sessions. The `intercom({ action: "list" })`
output therefore fills up with transient workers, drowning out the handful of
interactive peers a user actually wants to talk to. The list is also unsorted
(showing sessions in registration order, not recency), truncates the session id
to its first 8 characters (making it impossible to copy a full id for `send`/
`ask`), and offers no way to narrow it to "sessions in this project". This change
makes the session list default to the useful subset, ordered by recency, with
identifiers that can be acted on directly.

## What Changes

- **Hide teams-worker sessions by default (PRIMARY).** A session spawned by a
  `pi-agent-teams` leader (which sets `PI_TEAMS_WORKER=1` at spawn) is marked at
  registration time so that the `list` action hides it unless the caller opts in.
  The marker is a generic field on `SessionInfo` so the intercom package is not
  hard-coupled to the concept of "teams".
- **Sort the `list` output by last activity, most recent first.** Client-side
  ordering in the `list` handler.
- **Show the full session id** in every list row (name + full id + cwd + model +
  status), replacing the 8-character `shortSessionId`.
- **Optional `cwd` filter on `list`.** A new optional `cwd` parameter restricts
  the "other sessions" section to peers sharing that working directory.
- **Optional `all` flag on `list`.** Companion to "by default": when set, hidden
  sessions are included. (This is the natural complement of "hide by default"; it
  is called out as an assumption in design.md but is required to make the default
  non-lossy.)
- **Broker protocol delta:** `SessionInfo` gains the new generic field, which
  flows through every message carrying a `SessionInfo` (`register`, `sessions`,
  `message`, `presence_update`, `session_joined`). The broker's registration
  validator accepts the new optional field. **No new message types** — purely an
  additive optional field. Non-breaking.

## Capabilities

### New Capabilities
- `session-list`: Listing the active intercom sessions — what is shown, how it is
  sorted, how it is filtered (hidden peers, cwd), and the session identifier
  format presented to the caller.

### Modified Capabilities
<!-- None — openspec/specs/ is empty (fresh init), so session-list is introduced fresh. -->

## Impact

- **`types.ts`** — `SessionInfo` gains a generic optional field (carried by
  `register`, `sessions`, `message`, `presence_update`, `session_joined`).
- **`broker/broker.ts`** — `isSessionRegistration()` validation extended to
  accept (and type-check) the new field. `list`/`send`/broadcast paths unchanged
  because they already pass `SessionInfo` through verbatim.
- **`index.ts`**
  - `buildRegistration()` (~line 541) reads `process.env.PI_TEAMS_WORKER === "1"`
    and sets the marker.
  - `formatSessionListRow()` (~line 392) renders the **full** id instead of
    `shortSessionId` (and `shortSessionId` at ~line 357 becomes unused for list
    rows, kept for presence-label disambiguation).
  - `list` action handler (~line 1359) sorts by `lastActivity` desc, applies the
    hide filter + optional `cwd` filter + optional `all` flag.
  - Tool parameter schema (~line 1326) gains optional `cwd` and `all` params.
- **No new dependencies.** No runtime config changes. No breaking protocol
  change — old clients/brokers ignore the unknown optional field.
