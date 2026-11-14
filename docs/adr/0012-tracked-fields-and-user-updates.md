# ADR 0012 — Tracked fields, comments and the user's own record changes

**Status:** Accepted · **Date:** 2026-11-14 · Extends ADR 0008 and ADR 0009

## Context

Review and approval cards need several independent facts per record ("Reviewed", "Decision", "Checks passed",
"Follow-up by"), some set by the person using the dashboard and some by agents, plus comments and files. Until now the
dashboard user could only answer questions and mark records read; all other record data came from producers. A single
workflow `status` cannot hold several independent facts, and `metadata` has no definitions, types or permissions.

## Decision

- A card (`expandable-card` section) may declare up to 20 `fields`, each with an id, label, type (`checkbox`,
  `choice` with options, `text`, `date`), `editableBy` (`user`, `agent` or both) and an optional `filter` flag.
  Records hold the values in `fields`. Types are deliberately few and data-only; there is no computed field and no
  way to attach code.
- One server function, `updateRecord`, changes part of a stored record for both callers: agents through
  `PATCH /records/:id` (publish scope) and the dashboard user through `POST /records/:id/user-update` (operator only;
  not reachable with agent tokens). It checks `editableBy`, validates values against the card's definitions, writes
  atomically under the project's publish lock, honours `ifRevision`, and appends one `history` entry per changed
  field (old → new, by the token name or "user") and per comment or attached file.
- A full agent `PUT` cannot change a user-only field either, so "Reviewed" cannot be overwritten by an agent
  republishing its record.
- Comments and attachments from the user need the card's `comment` action. Files are uploaded through the existing
  upload endpoint; an upload that belongs to a question's answer cannot be attached to another record.
- Fields never change `status`; workflows (ADR 0008) stay the single source of the record's lifecycle.
- Record list pages carry the card's field definitions and per-value counts; `field.<id>=…` filters on the server so
  that neither the UI nor agents read all records.
- Invalid field values found in files are dropped with a warning; the record stays visible.

## Consequences

- The dashboard now writes record files for user changes (previously only answer files and read state). Writes use the
  same lock and atomic replace as the publish API, so agent and user changes never interleave inside one process; a
  stale `ifRevision` is refused with 409 instead of overwriting.
- History is capped at 500 entries per record (oldest dropped), as before.
- The user is recorded as "user": the product has one operator (ADR 0006); per-person names need accounts first.

## Rejected alternatives

- **Using `metadata` for these values**: no types, no options, no permissions, no filters.
- **Several workflow statuses per record**: workflows describe one lifecycle; independent facts are not states of it.
- **A separate user-changes file next to each record**: two sources for one record, merge rules on every read.
- **Letting agents edit every field**: an agent republishing a record would erase the user's review marks.
