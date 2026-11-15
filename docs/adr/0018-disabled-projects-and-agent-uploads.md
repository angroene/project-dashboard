# ADR 0018 — Disabled projects and agent uploads

**Status:** Accepted · **Date:** 2026-11-15 · Amends ADR 0009

## Context

`"enabled": false` in `project.json` hid a project from the list, but every route still served and wrote it by id.
Agent tokens could upload files into a project whose publishing was off, although the documentation says every agent
write needs publishing.

## Decision

- A disabled project is off: it is not listed, every request for it returns `404`, and its recurring templates do not
  run. Its files are still indexed, so diagnostics show problems before it is enabled again.
- `POST /uploads` with an agent token requires `publishing.enabled` (`403 publishing-disabled`). The dashboard user's
  own uploads (answers, comments) do not.

## Consequences

- Turning a project off is a single switch that also stops agents and the scheduler.
- Agents see the same rule for every write.

## Rejected alternatives

- **Keep `enabled` as "hidden only"** and document it: a switch called "enabled" that leaves the project fully usable
  surprises operators.
- **Require publishing for all uploads:** the user could no longer answer file-upload questions in projects that do
  not let agents publish.
