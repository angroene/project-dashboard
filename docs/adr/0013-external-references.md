# ADR 0013 — External references are reported data, not dashboard state

**Status:** Accepted · **Date:** 2026-11-14

## Context

Records often correspond to work items elsewhere: a change request, a ticket, a build, a commit on a branch. Users
want to see that link and the other system's status next to the record. The dashboard must stay generic (no
integration with any particular tool) and must not confuse a status someone else reported with its own workflow state.

## Decision

- Records accept `external`: up to 20 references `{system, id, title?, url?, ref?, status?, statusAt?}`. `system` is
  free text naming the other system; `ref` holds a branch, revision or change reference. Unknown keys are rejected.
- `url` must be `http(s)`; the UI opens it in a new tab with `rel="noopener noreferrer"`. All text is rendered as text.
- `status`/`statusAt` are shown as "\<system\> reports \<status\>" and are never combined with the record's `status`
  or tracked fields.
- References are maintained by producers: agents replace the list with `PATCH {external}` (`apd update --external`).
  The dashboard never contacts the other system.

## Consequences

- A reference can be stale; `statusAt` makes its age visible. Keeping it current is the producer's job.
- No credentials for other systems are ever needed by the dashboard.

## Rejected alternatives

- **Built-in connectors that poll other systems**: tool-specific code, credentials and network access in the server;
  out of scope for a generic, file-based dashboard.
- **Reusing `links`**: links have no system, id, revision or status, so a reported status would end up in titles.
- **Mapping external statuses onto the workflow**: mixes another system's opinion with the dashboard's own state.
