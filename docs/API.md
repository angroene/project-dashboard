# HTTP API

Types: `src/shared/api.ts` (responses) and `src/shared/schemas.ts` (request bodies). All under `/api`.

**Rules for every call**
- POST requests must send `X-PCC-Request: 1` (and `Content-Type: application/json` unless multipart).
  A cross-origin `Origin` header is rejected (403).
- When auth is on, every endpoint except `/api/session`, `/api/auth/*` needs the session cookie or an
  `Authorization: Bearer <token>` header (401 otherwise). Bearer tokens are the operator token (full access) or scoped
  agent tokens ([AGENT_INTEGRATION.md](AGENT_INTEGRATION.md#authentication)); an agent token gets `403 forbidden`
  outside its scopes and `404` for projects it may not use.
- Errors: `{ error, message, fieldErrors?, details? }` with 4xx/5xx. `fieldErrors` = `[{fieldId, message}]`.
- Clients only ever see ids and API URLs, never filesystem paths.

## Session

| Method | Path | Notes |
|---|---|---|
| GET | `/api/session` | `SessionInfo`: authRequired, authenticated, productName, upload limits |
| POST | `/api/auth/login` | `{token}` → sets HttpOnly cookie; 401 wrong; 429 after repeated failures |
| POST | `/api/auth/logout` | clears the session |

## Read

| Method | Path | Returns |
|---|---|---|
| GET | `/api/projects` | `ProjectsResponse` — cards from the in-memory index (O(projects)) incl. broken projects as unavailable |
| GET | `/api/projects/:projectId` | `ProjectCard` |
| GET | `/api/projects/:projectId/navigation` | `NavigationResponse` — validated section tree with badge counts |
| GET | `/api/projects/:projectId/sections/:sectionId/records` | `RecordPage` (summaries only). Query: `limit` (≤200), `cursor`, `status` (comma list; record status or question UI state such as `needs-response`), `q` (text), `sort` (`updated-desc`, `updated-asc`, `priority`, `title`, `order`), `unread=1`, `field.<id>=a,b` (tracked-field value is one of a, b; `true`/`false` for checkboxes, empty = not set). A main/page tab returns the records of all its cards. `needsResponseCount` is present when the section has answerable questions. Also returns the card's `fieldDefs`, `fieldCounts` (per filterable field, over all records), `templates` and `canComment`; summaries carry `fields`, `external` and `occurrence` when set. |
| GET | `/api/projects/:projectId/records/:recordId` | `RecordDetail` (body, attachments with availability, links, history, answer schema incl. defaults, submitted answer, `revision`, `fieldDefs`, `canComment`) — read from disk on demand |
| GET | `/api/projects/:projectId/templates` | `{templates: TemplateSummary[]}` — recurring templates with state, schedule, `lastDate` and `error` |
| GET | `/api/projects/:projectId/progress` | `ProgressResponse` — published values only; `overallPercent: null` = Not reported |
| GET | `/api/projects/:projectId/activity` | `ActivityPage`. Query: `cursor`, `limit` (≤100), `unread=1` |
| GET | `/api/projects/:projectId/attention` | `AttentionResponse` — questions needing a response (by due date) and unread records |
| GET | `/api/projects/:projectId/attachments/:attachmentId` | the file. Images/PDF/plain text inline, everything else as download. |
| GET | `/api/diagnostics` | `DiagnosticsResponse` — invalid manifests/records, duplicates, index timings |
| GET | `/api/updates` | Server-Sent Events: `invalidate` (`InvalidateEvent`: projectId, scopes, recordIds) and `ping` every 25 s |

## Write

| Method | Path | Body → Result |
|---|---|---|
| POST | `/api/projects/:projectId/questions/:id/answers` | `SubmitAnswerRequest {questionRevision, answers[], idempotencyKey}` → 201 `SubmitAnswerResponse`; 200 with `replayed: true` for the same key; 409 `stale-revision` / `already-answered` / `not-open`; 422 `validation` with `fieldErrors` |
| POST | `/api/projects/:projectId/uploads` | multipart: optional text field `questionId` **before** the files, then file part(s) → 201 `UploadResponse`; 422 `upload-rejected` (type not allowed, content does not match extension, too large) |
| POST | `/api/projects/:projectId/records/mark-read` | `{recordIds?, activityIds?, allActivity?}` → `MarkReadResponse` |
| POST | `/api/projects/:projectId/export/xlsx` | `{questionIds}` → `.xlsx` download |
| POST | `/api/projects/:projectId/import/xlsx/preview` | multipart field `file` (.xlsx ≤ 5 MB) → `ImportPreview` (kept 30 min in memory) |
| POST | `/api/projects/:projectId/import/xlsx/commit` | `{previewId, questionIds}` → `ImportCommitResponse` (per question ok/message; repeat-safe) |
| POST | `/api/projects/:projectId/download/zip/preflight` | `{recordIds?, attachmentIds?}` → `ZipPreflight` (available + missing) |
| POST | `/api/projects/:projectId/download/zip` | same body → `.zip` with files under `<recordId>/` and `manifest.json` |
| POST | `/api/projects/:projectId/records/:recordId/user-update` | `UserRecordUpdate {fields?, comment?, attach?: [{uploadId, title?}], ifRevision?}` → `{recordId, sectionId, revision, unchanged}`. The dashboard user's own changes: fields the user may edit, comments and files (cards with the `comment` action, else 403 `not-allowed`). Each change is added to `history` with `by: "user"`. 403 `field-not-editable`; 409 `revision-mismatch` (record changed since `ifRevision`), `id-conflict` (upload belongs to a question's answer); 422 `validation`. Operator only. |
| POST | `/api/projects/:projectId/templates/:templateId/state` | `{state: "active" \| "paused" \| "disabled"}` → `TemplateSummary`; writes the template file. 404 unknown; 409 when the template file is invalid. Operator only. |
| POST | `/api/admin/reindex` | rebuild the whole index |

## Publish (producers and agents)

For projects with `"publishing": {"enabled": true}` in `project.json`; otherwise `403 publishing-disabled`. Guide,
CLI and examples: [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md). Paths are under `/api/projects/:projectId`.

| Method | Path | Body → Result |
|---|---|---|
| GET | `/capabilities` | → `{apiVersion, projectId, caller, publishing: {enabled, sections: [{id, title, path}]}, recordTypes: {type: [{id, label, category}]}, answerTypes, priorities, queueStates, uploads}` |
| GET | `/records/:recordId/source` | → `{recordId, sectionId, revision, record}` (the stored JSON) |
| PUT | `/records/:recordId` | `{sectionId, record, ifRevision?}` → 201 `{recordId, sectionId, revision, created: true}` or 200 (`unchanged: true` when identical). `record.id`, `schemaVersion` and `updatedAt` are filled in when missing. Attachments may be `{uploadId, title?}`. 404 unknown section; 422 `not-a-card` / `validation` (with `fieldErrors`, including statuses outside the project's workflow); 403 `section-not-allowed`; 409 `id-conflict` (id used in another section, an id that differs from an existing one only in letter case, or attachment id used elsewhere), `revision-mismatch`, `revision-required` (answered question revision with a changed answer schema); 403 `field-not-editable` when the record would change a user-only field; 422 for unknown keys and for attachment roots not declared in `artifactRoots`. Replacing an existing record keeps what the dashboard user added: their history entries (comments, field changes) and attachments are written back exactly as stored, whatever the write contains for them, and every tracked field the write leaves out keeps its value (`null` clears one). History beyond 500 entries drops the oldest non-user entries first. 403 `reserved-actor` for a new history entry or attachment whose `by` is not printable ASCII or starts with "user" (letters and digits, any case); unchanged echoes of stored entries pass. Unknown keys and field values identical to the stored file (older or hand-edited records) pass |
| PATCH | `/records/:recordId` | `{status?, statusLabel?, summary?, percent?, priority?, notifyUser?, history?: {at?, text, by?}, fields?, external?, ifRevision?}` (`null` removes `statusLabel`/`percent` and clears a field) → `{recordId, sectionId, revision, unchanged}`; sets `updatedAt`; a history entry with the same `at` and `text` is not added twice; each changed field adds a history entry by the token name; `external` replaces the list; unknown fields 400; 403 `field-not-editable` for user-only fields; 403 `reserved-actor` for a `history.by` that is not printable ASCII or starts with "user"; 422 for values that do not fit the card's field definitions (stored values whose definition was removed are kept and never block an update) |
| PUT | `/activity/:eventId` | activity event (`at` defaults to now) → 201 created, 200 `unchanged` for an identical replay, 409 `id-conflict` for different content; 422 for an unknown `recordId` |
| PUT | `/progress` | `{progress, ifRevision?}` → `{revision, unchanged}`; validated as `progress.json` |

### AnswerValue (one per field)

```json
{ "fieldId": "response", "kind": "choice", "optionIds": ["a"], "otherText": "…", "explanation": "…" }
{ "fieldId": "response", "kind": "text", "text": "…" }
{ "fieldId": "response", "kind": "approval", "decision": "approve" | "reject", "rationale": "…" }
{ "fieldId": "response", "kind": "files", "attachmentIds": ["UPL-…"], "comment": "…" }
```
Non-composite questions have one field with id `response`. The Other option id is `__other`.

## Queue (consumer side)

Contract, guarantees and a runnable walkthrough: [QUEUE.md](QUEUE.md). Same protocol as `scripts/queue.ts`; see ADR 0003.
Paths are under `/api/projects/:projectId`.

| Method | Path | Body or query → Result |
|---|---|---|
| GET | `/queue` | query `state` (`pending` `processing` `processed` `failed`), `limit` (1 to 5000, default 500), `after` (answer id), optional `questionId` or `taskId` (the question's `taskId`) → `{items: [{answerId, state, questionId, questionRevision, submittedAt}], next?}`, oldest first |
| GET | `/queue/:answerId` | → full `AnswerEnvelope` (state, attempts, lease, audit); 404 if unknown or from another project |
| POST | `/queue/claim` | `{owner, leaseSeconds?, answerId?}` → claimed `AnswerEnvelope`; 204 when nothing is pending; with `answerId`, 409 `not-pending` unless that answer is pending |
| POST | `/queue/:answerId/complete` | `{owner, note?}` → envelope in `processed`; 409 `not-owner` / `wrong-state` |
| POST | `/queue/:answerId/fail` | `{owner, reason, retryable?}` → envelope in `failed`, or back in `pending` when retryable |
| POST | `/queue/recover` | → `{recovered: answerId[]}` (expired leases back to pending; also done automatically every 60 s and on every claim) |

`leaseSeconds` is 10 to 86,400 (default 600). `owner` matches `^[A-Za-z0-9._:@-]{1,120}$`.

The dashboard runs no consumer: submitted answers show as "Submitted · Awaiting pickup" until one claims them.

## Authorization, CSRF and limits

- **Authorization:** loopback servers need no login. Otherwise the server requires a token: `POST /api/auth/login`
  sets an HttpOnly, SameSite=Strict session cookie; send it on every later call (`curl -c jar -b jar`). See
  [SECURITY_MODEL.md](SECURITY_MODEL.md).
- **CSRF:** every non-GET request needs `X-PCC-Request: 1`; a cross-origin `Origin` is rejected (403 `csrf`).
- **Rate limiting:** only failed logins are limited: after 5 failures from one address the server answers 429 with an
  exponentially growing wait (up to 5 minutes). There is no general request rate limit.
- **Other limits:** JSON bodies up to 1 MB; uploads 20 MB and 10 files by default; Excel imports 5 MB and 5000 rows;
  at most 50 concurrent live-update (SSE) connections (503 beyond that; the UI falls back to polling).
- **Error shape:** `{error, message, fieldErrors?, details?}`. Common `error` codes: `bad-request` (400),
  `unauthorized` (401), `csrf` / `forbidden` / `publishing-disabled` / `section-not-allowed` (403), `not-found` (404), `stale-revision` / `already-answered` / `not-open` /
  `not-pending` / `not-owner` / `wrong-state` / `id-conflict` / `revision-mismatch` / `revision-required` (409), `too-large` (413), `validation` / `upload-rejected` / `not-a-card` (422),
  `rate-limited` (429), `internal` (500) and `busy` (503; details are in the server log, never in the response).
