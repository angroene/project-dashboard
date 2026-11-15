# Changelog

## Unreleased

### Added

- Default answers for single-choice, multiple-choice, free-text and approval questions (shown, never submitted;
  ADR 0011).
- Tracked fields on cards, comments and attachments on records, filters by field value (ADR 0012).
- External references with the source system's reported status (ADR 0013).
- Daily recurring records from templates, with pause, resume, disable and enable (ADR 0014, ADR 0017).
- `apd list`, `apd templates`, and `apd update --field / --external / --if-revision`.
- JSON Schemas for the file formats in `docs/schemas/`.

### Upgrade notes

- **One server per data root.** A server now takes a writer lock (`<dataRoot>/.apd-writer.lock`) and a second server
  on the same data refuses to start (ADR 0016). New setting `writerLockWaitSeconds` (default 35).
- **Token names starting with "user"** (letters and digits, any case, for example `user-ci`) are refused at start-up;
  rename them in the agent token file. History entries and attachments written by clients follow the same rule
  (ADR 0015).
- **Full record writes (`PUT`) keep the dashboard user's changes:** their history entries and attachments, and every
  tracked field the write leaves out. To clear a field, send `null` (ADR 0015).
- **Published records are validated strictly:** unknown keys and attachment roots not declared in `artifactRoots`
  give `422` (keys already in the stored file are accepted). Ids that differ from an existing record or event only in
  letter case give `409`.
- **`"enabled": false`** now turns a project off: every request for it returns `404` (ADR 0018). Agent uploads need
  `publishing.enabled`.
