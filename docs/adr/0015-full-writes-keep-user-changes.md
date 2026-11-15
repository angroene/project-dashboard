# ADR 0015 — Full record writes keep the user's changes

**Status:** Accepted · **Date:** 2026-11-15 · Amends ADR 0009 and ADR 0012

## Context

Agents publish a record with `PUT /records/:id` (`apd publish`, `apd ask`), and republishing the same id is the normal
way to update it. Since ADR 0012 the dashboard user also writes to records: tracked-field values, comments and
attachments, recorded in the record's history. A full write replaced the stored file with the agent's JSON, so an
agent republishing from its own copy silently deleted the user's comments, attachments, field values and change
history. History entries were free text, so an agent could also write entries under the user's name (`by: "user"`).

Record ids are also file names. On case-insensitive file systems (Windows, default macOS) `R1` and `r1` are one file,
so a write of `r1` replaced `R1` without any of the checks for an existing record.

## Decision

- **The user's parts survive a full write.** When `PUT` replaces an existing record, the server keeps every history
  entry with `by: "user"` that the write left out (merged by time), every attachment with `by: "user"`, and every
  tracked-field value the write does not name. `null` for a field clears it. Fields only the user may change still
  refuse a different value (`403 field-not-editable`).
- **The user's entries are written back unchanged.** History entries and attachments with `by: "user"` are restored
  exactly as stored after every full write, so a client can neither drop nor re-attribute them (matched by `at` and
  `text`, attachments by `id`). Trimming history to 500 entries drops the oldest non-user entries first.
- **"user" is reserved.** A new history entry or attachment from a client whose `by` is not printable ASCII or whose
  letters and digits start with "user" (any case) is refused (`403 reserved-actor`) on `PUT` and `PATCH`, which also
  rules out look-alikes ("User (dashboard)", zero-width or Cyrillic characters). Unchanged echoes of stored entries
  pass. Attachments the user adds through `user-update` carry `by: "user"` (new optional key in the record format).
- **Case variants are refused.** A new record or activity event whose id differs from an existing one only in letter
  case is refused (`409 id-conflict`), on every platform, so data behaves the same when it moves between systems.
- **Published records are checked strictly.** Unknown keys (anywhere in the record) and attachment roots not declared
  in `artifactRoots` are refused (`422`), except keys and tracked-field values identical to the stored file, so reading
  an older or hand-edited record and publishing it back works. Files on disk are still read leniently, and a stored tracked-field value whose
  definition was removed is kept and ignored by later updates, so an edited `section.json` never blocks a record.

## Consequences

- An agent can safely republish from its own copy; to remove something the user added, the user does it.
- Agents that relied on clearing fields by leaving them out must send `null`.
- Clients that sent extra keys now get `422`; the examples and the CLI send none.

## Rejected alternatives

- **Require `ifRevision` for every replacement:** breaks the documented "publish the same id again" workflow and still
  loses the user's changes whenever the agent re-reads and overwrites without merging.
- **Move user data to a separate file:** a second file per record for one feature; the user's changes are part of the
  record's story and belong in its history.
- **Trust `by` and leave attribution to the agent:** the history is an audit trail; it must not be forgeable by a
  publish-scope token.
- **Store lowercase file names:** renames existing files and changes ids users see; refusing the clash is enough.
