# Project format

A project is a folder of plain JSON files. The dashboard discovers projects, validates every file, and renders
navigation from the section manifests. There is no shared registry file: each project owns its folder.

The runtime schemas are `src/shared/schemas.ts` (zod). They are the authoritative contract; this page is the readable
version. Every file carries `"schemaVersion": 1`. Two complete, working projects are in [`examples/`](../examples/README.md).

## Where projects live

```text
<dataRoot>/
  projects/
    <projectFolder>/        one folder per project; the folder name is free, project.json "id" is what counts
      project.json
      ...
```

- Every sub-folder of `<dataRoot>/projects/` that does not start with `.` is a project candidate.
- The operator can also register project folders that live elsewhere with `extraProjectRoots` in the server
  configuration ([DEPLOYMENT.md](DEPLOYMENT.md)). Each entry is itself a project folder. Projects cannot register
  themselves; only the server operator can.
- New folders are picked up automatically (file watcher, plus a 60 second safety-net reconciliation). No restart.
- A broken project is shown as unavailable and never affects others. Two projects with the same `id`: the first one
  wins and the second is reported as a duplicate.

## Folder layout of one project

```text
<project>/
  project.json                     required: ProjectManifest
  progress.json                    optional: published progress (path set by "progressFile")
  sections/                        section tree (path set by "rootSection")
    <folder>/section.json
      <folder>/section.json
        <folder>/section.json      an expandable-card
          records/<anything>.json  records live here, only inside expandable-card folders
          templates/<id>.json      optional recurring templates (see "Recurring templates")
  attachments/                     files that records reference (path set by "allowedAttachmentRoot")
  <artifactRoot>/...               optional read-only roots listed in "artifactRoots"
  activity/events/<id>.json        activity events (path set by "activityDir")
  communications/                  BACKEND-OWNED: answer queue (see QUEUE.md)
  user-state/                      BACKEND-OWNED: read state, recurring-template bookkeeping
```

- A sub-folder **without** `section.json` is ignored. Use it for notes or scratch files.
- Every path in a manifest is relative to the project folder. Absolute paths, drive letters, UNC paths and `..`
  segments are rejected, and symlinks that point outside the project are rejected as well.
- Files whose names start with `.` are ignored. Producers should write `.<name>.tmp` and rename it to `<name>.json`
  when they finish, so the dashboard never reads a half-written file.

## project.json

```json
{
  "schemaVersion": 1,
  "id": "lantern-web-app",
  "displayName": "Lantern (example web app)",
  "description": "A fictional note-taking web app",
  "enabled": true,
  "order": 10,
  "rootSection": "sections",
  "progressFile": "progress.json",
  "allowedAttachmentRoot": "attachments",
  "artifactRoots": ["docs/design"],
  "activityDir": "activity/events",
  "theme": { "accent": "indigo" },
  "progressStaleAfterDays": 30,
  "workflows": {}
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `schemaVersion` | yes | | Must be `1`. |
| `id` | yes | | Letters, digits, `.` `_` `-`; 1 to 128 characters; must start with a letter or digit. Unique across the server. |
| `displayName` | yes | | 1 to 120 characters. Shown in the project selector. |
| `description` | no | `""` | Up to 500 characters. |
| `enabled` | no | `true` | |
| `order` | no | `100` | Lower comes first in the project list. |
| `rootSection` | no | `sections` | Folder holding the section tree. |
| `progressFile` | no | `progress.json` | |
| `allowedAttachmentRoot` | no | `attachments` | Folder attachments and uploads live in. |
| `artifactRoots` | no | `[]` | Up to 16 extra read-only folders (for example generated reports). |
| `activityDir` | no | `activity/events` | |
| `theme.accent` | no | `indigo` | `indigo teal amber rose violet slate`. |
| `progressStaleAfterDays` | no | never stale | 1 to 365. Shows published progress as stale after that many days. |
| `workflows` | no | `{}` | Per-record-type status vocabularies, see [Status workflows](#status-workflows). |
| `publishing` | no | `{"enabled": false}` | Lets authorised API clients write records, activity and progress for this project. `sections` (optional) lists the card ids open for record writes. See [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md#enabling-publishing-for-a-project). |

## Sections and display types

Every `section.json` declares one of three display types. The titles, order and icons come from the JSON; no React
code changes when a project renames or rearranges them.

| Display type | What it is |
|---|---|
| `main-tab` | Top-level tab. May show built-in panels (`views`) and hold page tabs or cards. |
| `page-tab` | A page inside a main tab (or a top-level tab when used at the root). May show panels and hold cards. |
| `expandable-card` | A collapsible card. Holds records (`records/*.json`) and nothing else. |

```json
{
  "schemaVersion": 1,
  "id": "questions",
  "displayType": "expandable-card",
  "title": "Questions for the owner",
  "description": "",
  "order": 20,
  "icon": "question",
  "visible": true,
  "defaultOpen": true,
  "views": [],
  "actions": ["copy", "open-detail", "respond", "export-xlsx", "import-xlsx", "mark-read"],
  "filters": { "statuses": ["open"], "defaultStatus": "open", "sort": "updated-desc" },
  "pageSize": 25
}
```

| Field | Notes |
|---|---|
| `id` | Lower-case slug (`a-z 0-9 -`, up to 64 characters), **unique within the whole project**, not just within the parent. |
| `displayType` | `main-tab`, `page-tab` or `expandable-card`. |
| `title` | 1 to 80 characters. |
| `order` | Ascending; ties are broken by folder name. Default 100. |
| `icon` | One of `folder gamepad map book chart question bug review check flag clock file image code wrench star inbox list box bolt`. |
| `visible` | `false` hides the section from navigation. |
| `defaultOpen` | Cards only: start expanded. |
| `views` | Main and page tabs: built-in panels shown before the children. Any of `progress`, `activity`, `attention`, `records`. |
| `actions` | Subset of `copy download bulk-download export-xlsx import-xlsx respond upload mark-read open-detail comment`. Default `["copy","open-detail"]`. `comment` lets the dashboard user add comments and files to the card's records. The backend still decides what is allowed. |
| `filters` | `statuses` (up to 20 status ids offered as filters), `defaultStatus`, `sort`. Sections with answerable questions also get a "Needs response" chip; `"defaultStatus": "needs-response"` opens the section on it. |
| `sort` | `updated-desc` (default), `updated-asc`, `priority`, `title`, `order`. |
| `pageSize` | 5 to 200, default 25. |
| `fields` | Cards only: up to 20 tracked fields, see [Tracked fields](#tracked-fields). Default none. |

### Tracked fields

A card can define independent, typed values that every record in it carries, for example "Reviewed" next to
"Decision" next to "Checks passed". Each field is changed on its own, by the dashboard user, by agents, or both; every
change is written to the record's `history` with who made it and the old and new value.

```json
"fields": [
  { "id": "reviewed", "label": "Reviewed", "type": "checkbox", "editableBy": ["user"], "filter": true },
  { "id": "decision", "label": "Decision", "type": "choice", "editableBy": ["user"], "filter": true,
    "options": [{ "id": "approve", "label": "Approve" }, { "id": "changes", "label": "Request changes" }] },
  { "id": "checks", "label": "Checks passed", "type": "checkbox", "editableBy": ["agent"] },
  { "id": "followUp", "label": "Follow-up by", "type": "date" }
]
```

| Key | Notes |
|---|---|
| `id` | Letter first, then letters, digits, `_` or `-` (max 40). Unique within the card. |
| `label` | 1 to 60 characters. `help` (optional) up to 300. |
| `type` | `checkbox` (value `true`/`false`), `choice` (value = an option id; needs `options`, 1 to 30 `{id, label}`), `text` (up to 2000 characters), `date` (`YYYY-MM-DD`). |
| `editableBy` | `["user"]`, `["agent"]` or both (default). The server refuses a change from anyone else. An agent's full record write (PUT) cannot change a user-only field either. |
| `filter` | `checkbox` and `choice` fields only: show a filter for the field above the card's records. |

Records keep the values in `fields` (`{ "reviewed": true, "decision": "approve" }`); a missing key or `null` means
"not set". Fields are separate from the workflow `status`: setting "Decision" does not move the record through the
workflow. A value in a record file that does not match the card's definition is ignored with a warning diagnostic.
The definitions are data only; there is no way to attach code or scripts to a field.

### Nesting rules

| Parent | Allowed children |
|---|---|
| root (`sections/`) | `main-tab`, **or** `page-tab`, **or** `expandable-card` |
| `main-tab` | `page-tab`, **or** `expandable-card` |
| `page-tab` | `expandable-card` |
| `expandable-card` | none (records only) |

- All children of one parent share one display type. If they are mixed, the majority type is kept and the others are
  reported in diagnostics.
- Maximum depth is 3 levels.
- Projects pick their own arrangement. Both example projects show different ones:
  `main-tab -> page-tab -> card` (Lantern) and cards directly at the root (Tidepool).

### Ordering

Sections sort by `order`, then by folder name. Records sort by the section's `filters.sort`; with `order` selected the
record's own `order` number is used, then `updatedAt`. Projects sort by `order` then `displayName`.

## progress.json

```json
{
  "schemaVersion": 1,
  "overallPercent": 55,
  "label": "Release 1.0 readiness",
  "method": "Share of release checklist items done",
  "updatedAt": "2026-11-10T09:00:00Z",
  "breakdown": [
    { "id": "editor", "title": "Editor", "percent": 80, "detail": "Core editing works", "weight": 3 },
    { "id": "docs", "title": "Documentation", "percent": null }
  ]
}
```

- The project **publishes** progress; the dashboard never computes a percentage. `overallPercent: null`, a missing
  field or a missing file all show **Not reported**.
- Percentages are 0 to 100. `breakdown` has up to 100 entries; `weight` is informational.
- With `progressStaleAfterDays` set, an old `updatedAt` marks the progress as stale.
- The file is rewritten only when the project's progress changes, not for every notification. Write it atomically.

## Notifications and read state

Two independent counts appear on the project card:

- **Awaiting response**: questions that need an answer (`requiresResponse: true`, `status: "open"`, no answer yet for
  the current revision).
- **Unread updates**: activity events and records with `"notifyUser": true` that the user has not marked read.
  Changing a record's `updatedAt` makes it unread again. Opening a project or record never marks anything read.

Read state is stored by the backend under `user-state/`; producers never write it. See
[ADR 0007](adr/0007-unread-definition.md).

## Records

Records are JSON files in an expandable-card's `records/` folder. Common envelope:

```json
{
  "schemaVersion": 1,
  "id": "LNT-TASK-001",
  "recordType": "task",
  "title": "Autosave drafts every 5 seconds",
  "summary": "Short line shown in the list",
  "status": "in-progress",
  "statusLabel": "Coding",
  "priority": "high",
  "order": 3,
  "createdAt": "2026-11-10T09:00:00+01:00",
  "updatedAt": "2026-11-12T16:00:00Z",
  "bodyMarkdown": "Loaded only when the record is expanded.",
  "attachments": [{ "id": "LNT-TASK-001-log", "title": "Log", "path": "documents/run.txt", "mimeType": "text/plain" }],
  "links": [{ "title": "Build", "url": "https://example.invalid/build/1" }],
  "linkedRecords": ["LNT-Q-001"],
  "metadata": { "build": "118", "retries": 2 },
  "history": [{ "at": "2026-11-10T09:00:00Z", "text": "Created", "by": "dev-1" }],
  "notifyUser": false,
  "percent": 40
}
```

Required: `schemaVersion`, `id`, `recordType`, `title`, `status`, `updatedAt`.

- `recordType`: `question`, `task`, `issue`, `review`, `progress`, `activity`, `document`, `generic`.
- `priority`: `critical high medium low none` (default `none`).
- `status`: machine value, a lower-case slug (see workflows). `statusLabel` (up to 60 characters) overrides the label.
- `bodyMarkdown`: up to 200,000 characters; rendered as sanitised Markdown, never as raw HTML. Only `http(s)` links.
- `metadata`: string (up to 2000 characters), number or boolean values; keys up to 60 characters.
- Timestamps are ISO 8601 **with an offset**: `2026-11-12T16:00:00Z` or `2026-11-12T16:00:00+01:00`.
- `fields`: values of the card's [tracked fields](#tracked-fields).
- `external`: up to 20 [external references](#external-references).
- `occurrence`: set by the server on records made from a [recurring template](#recurring-templates); do not write it.
- Type-specific optional fields: `task.assignee`; `issue.severity`, `issue.area`.
- Size limits: title 300 characters, summary 1000, 50 attachments, 50 links, 500 history entries.
- A record file larger than the safe read limit is rejected with a diagnostic.

### External references

A record can point at work items in other systems: a change request, a ticket, a build, a commit. The dashboard only
shows them; it never contacts the other system.

```json
"external": [
  { "system": "code review", "id": "PR-17", "title": "Sync API notes", "url": "https://code.example.org/lantern/pull/17",
    "ref": "feature/sync-notes@3f9c2e1", "status": "open", "statusAt": "2026-11-10T07:55:00Z" }
]
```

`system` (1 to 40 characters) and `id` (1 to 120) are required. `url` must be `http(s)`; it opens in a new tab without
referrer. `ref` holds a branch, revision or change reference (up to 200). `status` (up to 60) and `statusAt` are what
the other system reported and when; the dashboard labels them "\<system\> reports …" and never mixes them with the
record's own `status`. No other keys are allowed. Keeping the references current is the producer's job (an agent or
script that reads the other system); nothing refreshes them automatically.

### Four kinds of state, kept apart

| What | Where it lives | Who sets it |
|---|---|---|
| A **default** answer | `answerSchema` … `default` | The question's author. Only pre-fills the form; it is never an answer. |
| A **submitted response** | The answer queue (`communications/`) | The user, by pressing Submit (or importing Excel). The only thing agents consume. |
| A **manually updated status** | The record's `status`, or a tracked field | A producer or agent (`status`, agent fields) or the dashboard user (user fields), each change in `history`. |
| A **reported external status** | `external[].status` with `statusAt` | Copied from the other system by a producer; shown as that system's report. |

### Stable IDs

Record ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and are **unique per project across all sections**.
Derive them from the source system (ticket number, test name), never from the title or list position: answers,
read state and Excel rows refer to ids, so an id that changes orphans them.

### Status workflows

Each non-question record type has a status vocabulary. Every status belongs to one **category**, which drives counts
and colours for any vocabulary:

| Category | Meaning | Counted as |
|---|---|---|
| `open` | not started | |
| `active` | being worked on | active |
| `waiting` | waiting on someone or something | |
| `blocked` | cannot proceed | blocked |
| `done` | finished | |
| `closed` | finished without completing (cancelled, duplicate, superseded) | |

Built-in defaults (`DEFAULT_WORKFLOWS` in `src/shared/schemas.ts`):

| Record type | Default statuses |
|---|---|
| `task` | planned, in-progress, in-testing, blocked, done, cancelled |
| `issue` | open, reopened, in-progress, in-testing, awaiting-verification, answered, blocked, fixed, verified, wont-fix, duplicate |
| `review` | needs-review, in-review, changes-requested, approved, rejected, done |
| `progress` | published, draft |
| `activity` | info, success, warning, failure |
| `document` | draft, proposed, accepted, published, superseded, deprecated |
| `generic` | open, active, waiting, blocked, done, closed |

A project replaces a default by declaring `workflows.<recordType>` in `project.json`. The declaration **replaces**
the default for that type, it is not merged:

```json
"workflows": {
  "issue": {
    "unknownStatus": "strict",
    "statuses": [
      { "id": "observed", "label": "Observed", "category": "open" },
      { "id": "investigating", "label": "Investigating", "category": "active" },
      { "id": "awaiting-data", "label": "Awaiting data", "category": "waiting", "tone": "info" },
      { "id": "confirmed", "label": "Confirmed", "category": "done", "tone": "ok" },
      { "id": "dismissed", "label": "Dismissed", "category": "closed" }
    ]
  }
}
```

- Allowed types: `task issue review progress activity document generic`.
- `statuses`: 1 to 64 entries, ids unique, lower-case slugs. `tone` is optional: `neutral info ok warn danger`.
- `unknownStatus`: `warn` (default) shows a record with an unlisted status as `open` and adds a warning to
  diagnostics; `strict` ignores the record and reports an error.
- **Question statuses are fixed**: `open answered processed closed withdrawn`. The answer queue depends on them.
- Rationale and rejected alternatives: [ADR 0008](adr/0008-configurable-status-workflows.md).

### Question records

```json
{
  "schemaVersion": 1,
  "id": "LNT-Q-001",
  "recordType": "question",
  "title": "Where should notes be stored for sync?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "taskId": "LNT-TASK-001",
  "dueAt": "2026-11-20T18:00:00Z",
  "updatedAt": "2026-11-10T09:00:00Z",
  "answerSchema": {
    "type": "single-choice",
    "options": [
      { "id": "file-per-note", "label": "One file per note", "description": "Simple to back up" },
      { "id": "single-db", "label": "A single database file" }
    ],
    "allowOther": true,
    "allowExplanation": true,
    "required": true
  }
}
```

- `requiresResponse: true` needs an `answerSchema`; `false` makes an informational record with no form.
- The dashboard **never edits question files**. Producers own `status`. The state the user sees (needs response,
  submitted, processing, processed, failed) is derived from the answer queue ([QUEUE.md](QUEUE.md)). After consuming an
  answer, a producer typically sets `status` to `answered`, `processed` or `closed` and bumps `updatedAt`.
- Only a question with `status: "open"` accepts an answer.
- Bump `questionRevision` whenever the question changes meaning. Answers and Excel rows for an older revision are
  rejected as stale. A revised question can be answered again.

Answer schema types:

| `type` | Fields (defaults) |
|---|---|
| `single-choice` | `options[]` (1 to 50, each `id`, `label`, optional `description`), `allowOther` (false), `allowExplanation` (false), `required` (true) |
| `multiple-choice` | as `single-choice` plus `minSelected` (1), `maxSelected` |
| `free-text` | `required` (true), `minLength` (1), `maxLength` (5000, max 20000), `multiline` (true), `placeholder` |
| `approval` | `required` (true), `allowRationale` (true), `requireRationaleOnReject` (false) |
| `file-upload` | `required` (true), `minFiles` (1), `maxFiles` (5, max 20), `allowedMimeTypes` (subset of the server allowlist), `allowComment` (true) |
| `composite` | `fields[]` (1 to 20): each `{id, label, help?}` plus one of the plain types above |

#### Default answers

`single-choice` (`"default": "<option id>"`), `multiple-choice` (`"default": ["<option id>", …]`), `free-text`
(`"default": "<text>"`) and `approval` (`"default": "approve"` or `"reject"`; use `approval` for yes/no questions) may
set a `default`. Composite fields take it per field. File uploads have no default.

- The form opens with the default selected and says "Suggested default: …". The user can change it.
- **A default is never an answer.** Nothing is sent until the user presses Submit; the question keeps needing a
  response, the queue stays empty, and Excel import treats an empty cell as no answer. What the user submits is stored
  as given, so the queue never needs to know whether it matched the default.
- The server checks each default with the same rules as a submitted answer (known options, `maxSelected` and
  `minSelected`, `maxLength`, a reason when rejecting requires one). A record with an invalid default is rejected by the
  publish API (422) and, as a file, ignored with an error diagnostic.
- Questions without `default` behave exactly as before.

Answers use one value per field. A non-composite question has one field with id `response`; composite questions use
their own field ids. The "Other" choice is the option id `__other` with `otherText`. The exact answer JSON is in
[API.md](API.md#answervalue-one-per-field).

### Recurring templates

A file in a card's `templates/` folder makes the server create one ordinary record per day in that card, without any
agent running:

```json
{
  "schemaVersion": 1,
  "id": "field-log",
  "title": "Daily field log",
  "state": "active",
  "schedule": { "frequency": "daily", "time": "07:00", "timezone": "Pacific/Honolulu",
                "startDate": "2026-11-01", "endDate": "2027-03-31", "catchUpDays": 1 },
  "record": { "recordType": "question", "title": "Field log {date}", "status": "open", "requiresResponse": true,
              "questionRevision": 1, "answerSchema": { "type": "approval", "default": "approve" } }
}
```

| Key | Notes |
|---|---|
| `id` | Record-id characters, at most 117, unique per project. Occurrences get the id `<id>-<YYYY-MM-DD>`. |
| `state` | `active` (default), `paused` or `disabled`; only `active` creates records. Pause and resume from the card's "Recurring templates" list or `POST …/templates/:id/state`. |
| `schedule.frequency` | `daily` (the only frequency in this release). |
| `schedule.time`, `timezone` | Local time `HH:MM` (default `00:00`) in an IANA time zone. A day's record is created once the local clock reaches that time. |
| `startDate`, `endDate` | Local dates, inclusive; `endDate` optional. |
| `catchUpDays` | 0 to 31 (default 0): after downtime or a pause, also create this many missed earlier days. Older missed days are skipped. |
| `record` | The record each day starts from, without `id` (the server sets `id`, `occurrence`, `createdAt`, `updatedAt`). `{date}` in `title`, `summary` and `bodyMarkdown` becomes the local date. Without a `title`, it is "\<template title\> \<date\>". |

Behaviour that can be relied on:

- **Exactly once per day.** The record file is created atomically and only if it does not exist, so restarts, repeated
  checks and several servers on the same data never create a second copy. On a daylight-saving change the day is still
  created once: a skipped local time is reached when the clock jumps past it, a repeated one the first time.
- **History is kept.** The scheduler never edits or deletes an occurrence. It remembers the last date it handled
  (`user-state/.recurrence.json`), so an occurrence someone deleted is not recreated.
- **Defaults stay defaults.** An occurrence is an ordinary unanswered record; its question defaults are only shown.
- **Errors are visible.** An invalid template (unknown time zone, `endDate` before `startDate`, an `id` in `record`) is
  a diagnostic and creates nothing. If a day's record fails validation (for example an unknown status), the template
  shows the error, nothing is written, and the day is tried again on the next check.
- The server checks templates every `recurrenceSeconds` (default 60) and at start-up; `0` turns the scheduler off.

### Attachments and artifact roots

A record attachment is `{ id, title?, path, root?, mimeType? }`.

- `root` omitted or `"attachments"`: `path` is relative to the project's `allowedAttachmentRoot`.
- `root` equal to one of the project's `artifactRoots`: `path` is relative to that folder. Artifact roots are
  read-only and must lie inside the project folder.
- Attachment ids are unique per project. The browser downloads by id through the API and never sees file-system paths.
- A missing file is shown as unavailable; it does not break the record.
- Images, PDF and plain text open inline; everything else downloads. Office files are only ever served as downloads.
- Files uploaded by users as answers are stored under `<allowedAttachmentRoot>/answers/` with opaque names.

### Activity events

`activity/events/<id>.json`, one file per event so writers never rewrite a shared list:

```json
{
  "schemaVersion": 1,
  "id": "LNT-EV-001",
  "at": "2026-11-10T08:31:00Z",
  "area": "Build",
  "action": "build",
  "source": "ci",
  "summary": "Build 118 passed",
  "status": "success",
  "recordId": "LNT-TASK-001"
}
```

`status` is `info`, `success`, `warning` or `failure`. `recordId` optionally links the event to a record.

## Validation errors

Nothing is silently accepted. Problems appear in **Diagnostics** in the UI and in `GET /api/diagnostics`
(`{level, projectId, path, message}` with project-relative paths). A bad file affects only itself.

| Message (abridged) | Meaning | Effect |
|---|---|---|
| `project.json invalid: ...` | Manifest failed the schema (also a malformed `workflows` block) | Project unavailable |
| `project.json path '...' rejected` | A manifest path was absolute, contained `..` or escaped through a symlink | Project unavailable |
| `duplicate project id '...'` | Another project already uses the id | Second project unavailable |
| `section.json invalid: ...` | Section manifest failed the schema | Section ignored |
| `duplicate section id '...'` | Section ids must be unique per project | Second section ignored |
| `<type> not allowed inside <parent>` | Breaks the nesting rules | Section ignored |
| `nesting deeper than 3` | Too deep | Section ignored |
| `mixed child types under one parent` | Siblings of different display types | Minority types ignored |
| `expandable-card cannot contain sections` | A card has a child section folder | Child ignored |
| `records/ is only read inside expandable-card sections` | Records in a tab folder | Warning, records not read |
| `duplicate record id '...'` | Record ids are unique per project | Second record ignored |
| `duplicate attachment id '...'` | Attachment ids are unique per project | Attachment ignored |
| `status '...' is not in this project's <type> workflow` | Status not listed | `warn`: shown as open with a warning; `strict`: record ignored |
| JSON parse or schema errors with the field path | Malformed record | Record ignored |
| `unsupported schemaVersion` style schema errors | Only version 1 exists | File ignored |
