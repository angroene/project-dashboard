# ADR 0009 — Publishing records through the server

**Status:** Accepted · **Date:** 2026-11-14

## Context

Until now producers wrote JSON files straight into the project folder and the dashboard only read them. That works for
a process on the same machine. An agent on another host, in a container without the volume, or in a sandbox that may
not write outside its workspace cannot do that, yet it still has to publish questions, task updates, issues, reviews,
activity and progress.

## Decision

- Add producer endpoints to the existing API: `PUT /records/:recordId`, `PATCH /records/:recordId`,
  `GET /records/:recordId/source`, `PUT /activity/:eventId`, `PUT /progress`, and `GET /capabilities` for discovery.
- The server validates the full record (schema, the project's status workflow, id uniqueness across the project,
  attachment ids and paths) **before** writing, and writes the **same file** a local producer would write
  (`<card>/records/<id>.json`, `<activityDir>/<id>.json`, `<progressFile>`), atomically, then reindexes at once.
- Opt-in per project: `project.json` `"publishing": {"enabled": true, "sections": [...]}`. Clients address cards by
  section id; they never send a path.
- Writes of one project are serialised in the server so the cross-section id check and the write are one step.
- Idempotency: `PUT` is a full replace (same content = `unchanged`); `PATCH` history entries are de-duplicated on
  `at` + `text`; activity events are immutable (same id, different content = `409`). Optimistic concurrency with
  `ifRevision` (content hash).
- A question revision that already has an answer cannot change its `answerSchema`; the producer must raise
  `questionRevision` (`409 revision-required`), so a stored answer is never re-interpreted.
- Uploaded files can be attached with `{"uploadId": ...}`, reusing the existing upload storage and download route.
- One queue: answers are still consumed only through the existing queue protocol (ADR 0003).

## Consequences

- The dashboard now writes record, activity and progress files for projects that enable publishing. The previous
  rule "the dashboard never edits record files" holds for every project that does not.
- File producers and API producers can be mixed; both produce identical files. A local producer and the API writing
  the same record at the same moment are not coordinated (last rename wins); `ifRevision` detects it for API writers.
- `updatedAt` defaults to the server time, so a client clock does not matter.

## Rejected alternatives

- **A separate agent inbox or queue** (agents post messages, the dashboard converts them): a second format and a second
  lifecycle to keep consistent with the files, and two places to look when something is missing.
- **Accepting file paths from clients** (write `sections/x/records/y.json`): moves path validation to every client and
  lets a client target any folder the server can write.
- **A generic file-upload endpoint for JSON**: no validation before the write; invalid records would only show up in
  Diagnostics.
- **Requiring shared storage (NFS, sync tools) for remote agents**: fragile, platform-specific, and still gives the
  agent write access to the whole project folder.
- **Enabled by default**: would let any authenticated client modify every project's records, including projects whose
  files are owned by a local producer.
