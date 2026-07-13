## ADDED Requirements

### Requirement: SessionInfo carries an optional role marker

The `SessionInfo` type SHALL include an optional `kind?: string` field that names
a session's role (e.g. `"teams-worker"`). Sessions that do not declare a role MUST
leave `kind` unset (treated as a normal interactive session). The broker SHALL
accept `kind` on registration and SHALL propagate it unchanged through every
message that embeds a `SessionInfo` (`sessions`, `message`, `presence_update`,
`session_joined`). The marker is a generic role string; the intercom package MUST
NOT hard-code the concept of "teams" beyond reading the `PI_TEAMS_WORKER`
environment variable at registration time.

#### Scenario: Worker session is marked at registration
- **WHEN** a session starts with the environment variable `PI_TEAMS_WORKER` set
  to `"1"`
- **AND** the session registers with the broker
- **THEN** the registered `SessionInfo.kind` SHALL equal `"teams-worker"`

#### Scenario: Interactive session has no marker
- **WHEN** a session starts without `PI_TEAMS_WORKER` set to `"1"`
- **AND** the session registers with the broker
- **THEN** the registered `SessionInfo.kind` SHALL be absent/undefined

#### Scenario: Marker survives a malformed type
- **WHEN** a register payload includes `kind` with a non-string value
- **THEN** the broker SHALL reject the registration (it MUST NOT store an
  invalid `kind`)

#### Scenario: Old peer sees the new field
- **WHEN** a peer registers with `kind: "teams-worker"` and another older client
  lists sessions
- **THEN** the listing SHALL include that session and MAY carry the `kind` field;
  older code MUST NOT break on the presence of the field

### Requirement: Background-role sessions are hidden from the default list

The `intercom({ action: "list" })` tool SHALL hide any session whose `kind` is a
non-empty string from the "Other sessions" section, **by default**. The caller's
own current session is always shown. A background-role session remains fully
addressable by id or name via `send`/`ask` — only the *list* hides it.

#### Scenario: Worker hidden by default
- **WHEN** a session with `kind: "teams-worker"` is connected
- **AND** another session runs `intercom({ action: "list" })` with no extra flags
- **THEN** the worker MUST NOT appear in the "Other sessions" section

#### Scenario: Worker shown when caller opts in
- **WHEN** a session with `kind: "teams-worker"` is connected
- **AND** another session runs `intercom({ action: "list", all: true })`
- **THEN** the worker SHALL appear in the "Other sessions" section

#### Scenario: Current session always shown
- **WHEN** the calling session itself has `kind: "teams-worker"`
- **AND** it runs `intercom({ action: "list" })`
- **THEN** the calling session SHALL appear in the "Current session" section
  regardless of the hide rule

#### Scenario: Hidden session still receivable
- **WHEN** a worker with `kind: "teams-worker"` is hidden from a peer's list
- **AND** that peer sends a message addressed to the worker by name or id
- **THEN** the message SHALL be delivered normally

### Requirement: List is sorted by last activity, most recent first

The `intercom({ action: "list" })` tool SHALL order the "Other sessions" section
by `SessionInfo.lastActivity` in descending order (most recently active first).
The "Current session" section is not subject to this ordering.

#### Scenario: Most recent peer listed first
- **WHEN** three peer sessions A, B, C registered in that order
- **AND** C touched `lastActivity` most recently, then A, then B
- **THEN** the "Other sessions" section SHALL list C, then A, then B

#### Scenario: Ties keep stable order
- **WHEN** two peers have identical `lastActivity` timestamps
- **THEN** their relative order SHALL be stable and not flip between calls

### Requirement: List rows show the full session identifier

Every row rendered by the `list` action SHALL display the complete `SessionInfo.id`
(never a truncation), while still showing the session name, working directory,
model, and status tags.

#### Scenario: Full id is rendered
- **WHEN** a session with id `11111111-2222-3333-4444-555555555555` is listed
- **THEN** the row SHALL contain the full id `11111111-2222-3333-4444-555555555555`
- **AND** SHALL contain the session name, cwd, and model

### Requirement: Background-role sessions are hidden from the session picker overlay

The interactive session picker overlay SHALL hide any session whose `kind` is a
non-empty string, matching the `list` action's worker-hide rule exactly. The
picker (`openIntercomOverlay`, invoked via Alt+M / the `intercom` command) MUST
exclude such sessions to keep the two discovery surfaces (tool `list` and
interactive picker) consistent and to prevent an accidental "message a worker"
surface. The caller's own session is always shown. Addressability by id/name via
`send`/`ask` is unaffected (hiding is display-only; `listSessions()` and broker
`list` stay complete).

#### Scenario: Worker hidden from the picker
- **WHEN** a session with `kind: "teams-worker"` is connected
- **AND** another session opens the intercom session picker overlay
- **THEN** the worker MUST NOT appear as a selectable target in the picker

#### Scenario: Current session shown in the picker
- **WHEN** the caller's own session has `kind: "teams-worker"`
- **AND** it opens the picker
- **THEN** the caller's own session SHALL appear in the picker regardless of the
  hide rule

### Requirement: Optional working-directory filter on list

The `intercom` tool SHALL accept an optional `cwd` parameter for the `list`
action. When provided, the "Other sessions" section SHALL be restricted to peers
whose `cwd` exactly equals the given value. The current session is always shown
regardless of the `cwd` filter.

#### Scenario: cwd filter narrows the list
- **WHEN** peers exist in `/a`, `/a`, and `/b`
- **AND** the caller runs `intercom({ action: "list", cwd: "/a" })`
- **THEN** the "Other sessions" section SHALL contain only the peers in `/a`

#### Scenario: cwd filter is exact
- **WHEN** a peer's cwd is a symlink or different-cased path that is not
  byte-for-byte equal to the provided `cwd`
- **THEN** that peer SHALL NOT be matched by the filter

#### Scenario: Current session survives the cwd filter
- **WHEN** the caller runs `intercom({ action: "list", cwd: "/elsewhere" })`
  while its own cwd is elsewhere
- **THEN** the "Current session" section SHALL still be rendered

#### Scenario: Omitted cwd disables the filter
- **WHEN** the caller runs `intercom({ action: "list" })` with no `cwd`
- **THEN** no working-directory filtering SHALL be applied (other filters still
  apply)
