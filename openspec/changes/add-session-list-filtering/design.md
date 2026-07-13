## Context

`pi-intercom` lets local pi sessions discover and message each other through a
broker (`broker/broker.ts`) and a client extension (`index.ts`). Sessions register
a `SessionInfo` (`types.ts`) and the `intercom({ action: "list" })` tool renders the
peers a user can talk to.

Today that list is noisy and lossy:
- `pi-agent-teams` leaders spawn worker sessions that each register a
  `SessionInfo`. The user's list fills with transient workers.
- The list is unsorted (broker returns sessions in registration order).
- Each row shows only the first 8 characters of the session id via
  `shortSessionId` (`index.ts:357`), so a caller cannot copy a full id to use with
  `send`/`ask`.
- There is no way to narrow the list to "sessions in this project".

Current code anchors (all file:approx-line):
- `types.ts:1` — `SessionInfo` interface (no marker field today).
- `types.ts:14` — `ClientMessage.register` carries `Omit<SessionInfo, "id">`;
  `BrokerMessage` variants `sessions` / `message` / `presence_update` /
  `session_joined` all embed a full `SessionInfo`.
- `broker/broker.ts:73` — `isSessionRegistration()` validates the register payload (rejects missing/mistyped `cwd`/`model`/`pid`/`startedAt`/`lastActivity`; `name`/`status` optional).
- `broker/broker.ts` (register handler, ~line 150) — stores
  `{ ...clientMessage.session, id }`; the `list` handler (~line 176) returns
  `s.info` for every session; `send`/broadcast embed `fromSession.info`.
- `index.ts:541` — `buildRegistration()` returns `Omit<SessionInfo, "id">`.
- `index.ts:357` — `shortSessionId()` (`sessionId.slice(0, 8)`).
- `index.ts:392` — `formatSessionListRow()` renders
  `• ${name} (${shortSessionId(session.id)}) — ${cwd} (${model})[tags]`.
- `index.ts:1359` — `list` action handler (splits current vs other, renders rows).
- `index.ts:1326` — tool parameter schema (`action`, `to`, `message`,
  `attachments`, `replyTo`).

Source of trust for "is this a teams worker?": the environment variable
`PI_TEAMS_WORKER=1`, set by the `pi-agent-teams` leader at spawn
(`leader.ts:667`). The intercom package must not import or know about the teams
package; it only reads this one environment variable at registration time.

## Goals / Non-Goals

**Goals:**
- Hide teams-worker sessions from the default `list` output.
- Sort the list by last activity, most recent first.
- Show the full session id in list rows.
- Allow narrowing the list by `cwd`.
- Keep the package generic — no hard dependency on `pi-agent-teams` concepts.
- Non-breaking broker protocol.

**Non-Goals:**
- No new message types; no broker-side filtering of `send`/`list` beyond carrying
  the new field.
- No persistence or restart-survival of the marker (a session is worker-classified
  once, at registration, from its env).
- No fuzzy/normalized cwd matching (exact string compare only).
- No changes to how workers *send* messages — they remain fully addressable by id
  or name; only the *list* hides them by default.

## Decisions

### D1 — Marker field: `kind?: string` on `SessionInfo`

Add an optional `kind?: string` to `SessionInfo` (`types.ts:1`). When
`process.env.PI_TEAMS_WORKER === "1"`, `buildRegistration()` (`index.ts:541`) sets
`kind: "teams-worker"`. Otherwise `kind` is omitted/`undefined`.

**Why a generic `kind` over `hidden?: boolean`:**
- `kind` carries the *reason* a session is background; a boolean loses that. A
  future UI can show "3 workers hidden" or group by role, which a boolean cannot.
- `kind` is extensible: subagents, detached runners, daemons, etc. can each
  declare their own `kind` and be hidden by the *same* rule with no further
  `SessionInfo` change.
- The package stays decoupled from "teams": the string `"teams-worker"` appears in
  exactly one place (`buildRegistration`). Nothing else in intercom references
  teams.

**Why a single `kind` over `kind` + `hidden`:** one field, one source of truth.
Visibility is derived from `kind`, never stored separately, so it can never drift.

Alternatives considered:
- `hidden?: boolean` — rejected: lossy, not extensible, no semantic grouping.
- `source?: "user" | "teams-worker" | ...` union — rejected: would need a package
  update for every new source; an open `string` is more robust for a library.

### D2 — Hide rule: hide any session whose `kind` is set; `all` flag opts in

The `list` handler (`index.ts:1359`) computes the visible "other sessions" as
those with a falsy `kind`, **unless** the new optional `all` param is `true`, in
which case all peers are shown. `all: true` is the non-lossy complement to
"by default".

```ts
const visible = params.all === true
  ? otherSessions
  : otherSessions.filter(s => !s.kind);
```

**Assumption (noted per escalation guidance):** "hide if `kind` is set" treats
*every* declared kind as a background role. This holds for all kinds introduced by
this change (`teams-worker`). If a future kind should remain visible by default
(e.g. `kind: "primary"`), the rule switches from "hide if set" to "hide if kind is
in a known background set". See Open Questions.

### D3 — Sort: client-side, `lastActivity` descending

Sort in the `list` handler, not the broker, so the broker stays a dumb registry
and different clients may order differently:

```ts
const sorted = [...visible].sort((a, b) => b.lastActivity - a.lastActivity);
```

The current session is rendered in its own "Current session" section and is not
sorted. Sort is stable (Array.prototype.sort is stable in V8/Bun).

**Why client-side:** the broker is shared infra; ordering is a presentation
concern. Keeping the broker unsorted avoids a protocol change for ordering.

### D4 — Full session id in list rows

`formatSessionListRow()` (`index.ts:392`) renders `session.id` directly instead of
`shortSessionId(session.id)`. Row shape becomes:
`• ${name} (${session.id}) — ${cwd} (${model})[tags]`.

`shortSessionId()` (`index.ts:357`) is **kept** — it is still used by
`formatSessionLabel()` (`index.ts:387`) for presence disambiguation when two
sessions share a name. Only the *list rows* switch to the full id.

### D5 — Optional `cwd` filter

New optional tool param `cwd` (`index.ts:1326`). In the `list` handler, when
provided, the visible-other-sessions set is additionally filtered by exact string
equality on `session.cwd`:

```ts
const scoped = params.cwd ? visible.filter(s => s.cwd === params.cwd) : visible;
```

Applied to "other sessions" only; the current session is always shown. Exact match
is deliberate (predictable; matches how the broker stores cwd). See Trade-offs.

### D6 — Broker protocol delta: additive optional field, no new message types

`kind?` is added to `SessionInfo`. Because every broker message that carries
session identity embeds a full `SessionInfo` (`sessions`, `message.from`,
`presence_update.session`, `session_joined.session`), the field propagates with
**zero message-type changes**.

`isSessionRegistration()` (`broker/broker.ts:73`) gains one validation clause:
```ts
if (session.kind !== undefined && typeof session.kind !== "string") return false;
```
This rejects malformed types. Because the register handler stores
`{ ...clientMessage.session, id }` and never strips unknown keys, and because the
existing validator does **not** reject extra fields, `kind` already flows end-to-end
even against an unpatched broker. The validator change is for correctness only.

**Backward compatibility:**
- Old client → new broker: `kind` absent → `undefined` → never hidden → shown. Safe.
- New client → old broker: `kind` is an unknown extra field, allowed by the
  validator, preserved by the spread, propagated in broadcasts. Safe.

## Where each requirement lives (trace)

| # | Requirement | Code location (file:approx-line) | Mechanism |
|---|-------------|----------------------------------|-----------|
| 1 | Hide teams-worker by default | `index.ts:541` (buildRegistration reads `PI_TEAMS_WORKER`), `index.ts:1359` (list hides `kind`-set sessions), `types.ts:1` (`kind?`), `broker/broker.ts:73` (validator) | env → `kind` field → client-side filter |
| 2 | Sort by lastActivity desc | `index.ts:1359` (list handler) | client-side stable sort |
| 3 | Full session id in rows | `index.ts:392` (formatSessionListRow) | render `session.id` |
| 4 | Optional cwd filter | `index.ts:1326` (param schema), `index.ts:1359` (handler) | exact-match filter on `session.cwd` |

**Source of trust** for the hide trigger: `process.env.PI_TEAMS_WORKER === "1`,
set by the `pi-agent-teams` leader at spawn (`leader.ts:667`).

## Risks / Trade-offs

- **All declared kinds are treated as background (D2).** → Mitigation: documented
  as an assumption; the rule is a single filter expression, trivial to change to a
  known-set later. No data migration because the field is derived, not stored
  separately.
- **Exact `cwd` match misses symlinks/case variants (D5).** → Mitigation:
  deliberate, predictable behavior; matches broker storage. A normalization layer
  is out of scope and would itself introduce ambiguity (which canonical form?).
  Callers can pass the exact cwd they want; the current-session cwd is already
  shown.
- **Full id makes rows wider (D4).** → Mitigation: the id is the actionable token
  for `send`/`ask`; truncation forced an extra round-trip. TUI wraps long lines;
  no layout change required.
- **`all` flag widens attack surface on list?** → No: `list` is a local
  discovery tool, not privileged. `all` only changes *display*, never delivery.

## Migration Plan

1. Ship `types.ts` + `broker/broker.ts` + `index.ts` together (single release).
   Mixed versions are safe per D6, but a coordinated release avoids the brief
   window where a new client's `kind` is silently ignored by an unpatched broker's
  *validator* type-check — functionally harmless, just not validated.
2. No data migration: the marker is read fresh from env on every registration.
3. No config change required. `PI_TEAMS_WORKER` is already set by the teams
   leader; interactive sessions simply never set it.
4. Rollback: revert the release. Sessions registered under the old code have no
   `kind` and are shown (default-safe).

## Open Questions

- Should a future visible-by-default `kind` (e.g. `"primary"`) change D2 from
  "hide if `kind` set" to "hide if `kind` in known-background-set"? Out of scope
  for this change; revisit when a second `kind` is introduced.
- Should the `cwd` filter normalize paths (resolve symlinks, lowercase on
  case-insensitive FS)? Deferred — exact match is the robust, predictable default.
