# Item types

A catalogue of everything a project can contain: layout types, record types, question types, tracked fields, recurring
items, statuses, actions, attachments, progress and activity. Each entry says what it is for, what the dashboard shows,
what it needs, and gives a complete file you can copy.

- The full rules and limits are in [PROJECT_FORMAT.md](PROJECT_FORMAT.md); the zod schemas in `src/shared/schemas.ts`
  are authoritative.
- Every type below has a working instance in the fictional example project
  [`showcase-garden`](../examples/projects/showcase-garden) ("Sprout Commons"). Run it as described in
  [examples/README.md](../examples/README.md).
- Every JSON block marked as an example is a complete file. `test/examples-catalogue.test.ts` parses each one with
  its schema, so they stay valid.

| Part | Types |
|---|---|
| [A. Layout](#a-layout-projects-and-sections) | project, `main-tab`, `page-tab`, `expandable-card`, section views |
| [B. Records](#b-record-types) | `question`, `task`, `issue`, `review`, `progress`, `activity`, `document`, `generic` |
| [C. Questions](#c-question-and-answer-types) | `single-choice`, `multiple-choice`, `free-text`, `approval`, `file-upload`, `composite`, informational |
| [D. Tracked fields](#d-tracked-field-types) | `checkbox`, `yes-no`, `choice`, `text`, `date` |
| [E. Recurring items](#e-recurring-items) | daily templates, daily Yes / No items, daily pinned choices, recurring questions, paused templates |
| [F. Statuses and attention](#f-statuses-workflows-and-attention-groups) | workflows, categories, `requiresAction`, `notifyUser`, attention groups |
| [G. Actions](#g-actions) | `copy`, `download`, `bulk-download`, `export-xlsx`, `import-xlsx`, `upload`, `respond`, `mark-read`, `comment`, `open-detail` |
| [H. Files, progress, activity](#h-attachments-artifact-roots-progress-and-activity) | attachments, artifact roots, `progress.json`, activity events |

## A. Layout: projects and sections

### Project

**Purpose:** one folder per project, `<dataRoot>/projects/<folder>/project.json`. **Shows:** a card on the landing
page (collapsed by default: "N require attention" or a compact progress bar) and the project's workspace.
**Required:** `schemaVersion`, `id`, `displayName`. **Optional:** `description`, `enabled`, `order`, `rootSection`,
`progressFile`, `allowedAttachmentRoot`, `artifactRoots`, `activityDir`, `theme.accent`, `progressStaleAfterDays`,
`workflows`, `publishing`. Showcase: [`project.json`](../examples/projects/showcase-garden/project.json).

<!-- example: project -->
```json
{
  "schemaVersion": 1,
  "id": "orchard-planner",
  "displayName": "Orchard Planner",
  "description": "A fictional orchard project",
  "enabled": true,
  "order": 10,
  "rootSection": "sections",
  "progressFile": "progress.json",
  "allowedAttachmentRoot": "attachments",
  "artifactRoots": ["docs/reports"],
  "activityDir": "activity/events",
  "theme": { "accent": "teal" },
  "progressStaleAfterDays": 30,
  "workflows": {},
  "publishing": { "enabled": true, "sections": ["inbox", "work"] }
}
```

### Display types

Each `section.json` has one of three display types. Allowed nesting: root holds main tabs, page tabs **or** cards; a
main tab holds page tabs **or** cards; a page tab holds cards; a card holds records only. All children of one parent
share one type; at most 3 levels.

| Type | Purpose | Shows | Showcase |
|---|---|---|---|
| `main-tab` | top-level area | a tab in the top bar; its `views` panels, then its children | [`overview`](../examples/projects/showcase-garden/sections/overview/section.json), [`plan`](../examples/projects/showcase-garden/sections/plan/section.json), [`library`](../examples/projects/showcase-garden/sections/library/section.json) |
| `page-tab` | a page inside a main tab (or at the root) | a second-level tab; its `views`, then its cards | [`plan/ask`](../examples/projects/showcase-garden/sections/plan/ask/section.json), [`plan/work`](../examples/projects/showcase-garden/sections/plan/work/section.json), [`plan/daily`](../examples/projects/showcase-garden/sections/plan/daily/section.json) |
| `expandable-card` | a list of records | a collapsible card with filters, selection, actions and paging | every folder with `records/`, for example [`plan/work/tasks`](../examples/projects/showcase-garden/sections/plan/work/tasks/section.json) |

**Required** for every section: `schemaVersion`, `id` (lower-case slug, unique in the project), `displayType`,
`title`. **Optional:** `description`, `order`, `icon`, `visible` (`false` hides it, see the showcase's
[`library/archive`](../examples/projects/showcase-garden/sections/library/archive/section.json)), `defaultOpen` (cards),
`views` (tabs), `actions`, `filters`, `pageSize`, `fields` (cards).

Icons: `folder gamepad map book chart question bug review check flag clock file image code wrench star inbox list box bolt`.

### Section views

Built-in panels a main tab or page tab shows before its children, any of four:

| View | Shows |
|---|---|
| `progress` | the project's published `progress.json` ("Not reported" without one) |
| `attention` | the attention panel: Questions, Actions, Responses, Updates ([F](#attention-groups)) |
| `activity` | the activity feed from `activityDir` |
| `records` | the records of all cards under this tab in one list |

A main tab with panels only (`sections/overview/section.json`):

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "overview",
  "displayType": "main-tab",
  "title": "Overview",
  "description": "Progress, what needs you, and recent activity",
  "order": 10,
  "icon": "chart",
  "visible": true,
  "views": ["progress", "attention", "activity"]
}
```

A page tab (`sections/build/planning/section.json`):

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "planning",
  "displayType": "page-tab",
  "title": "Planning",
  "order": 10,
  "icon": "list",
  "views": ["records"]
}
```

A card with every optional key (`sections/build/planning/inbox/section.json`):

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "inbox",
  "displayType": "expandable-card",
  "title": "Inbox",
  "description": "Questions for the owner",
  "order": 20,
  "icon": "question",
  "visible": true,
  "defaultOpen": true,
  "views": [],
  "actions": ["copy", "open-detail", "respond", "export-xlsx", "import-xlsx", "mark-read"],
  "filters": { "statuses": ["needs-response", "open", "answered"], "defaultStatus": "needs-response", "sort": "priority" },
  "pageSize": 10,
  "fields": []
}
```

`filters.statuses` lists up to 20 status ids offered as filter chips; `defaultStatus` opens the card on one
(`needs-response` is the "Needs response" chip of cards with answerable questions); `sort` is `updated-desc`
(default), `updated-asc`, `priority`, `title` or `order`. `pageSize` is 5 to 200 (default 25).

## B. Record types

Records are files in a card's `records/` folder, one record per file. **Required** for every type: `schemaVersion`,
`id` (unique in the project, stable), `recordType`, `title`, `status`, `updatedAt` (ISO 8601 with offset).
**Optional** for every type: `summary`, `statusLabel`, `priority` (`critical high medium low none`), `order`,
`createdAt`, `bodyMarkdown`, `attachments`, `links`, `linkedRecords`, `metadata`, `history`, `actions`, `notifyUser`,
`requiresAction`, `percent`, `fields`, `external`. Every record shows as a row (title, status, priority, summary,
tracked fields) that expands to its detail (Markdown body, files, links, history).

| `recordType` | Purpose | Type-specific keys | Default statuses | Showcase |
|---|---|---|---|---|
| `question` | something the user answers | `requiresResponse`, `answerSchema`, `questionRevision`, `taskId`, `dueAt` | fixed: open, answered, processed, closed, withdrawn | [`plan/ask/*/records`](../examples/projects/showcase-garden/sections/plan/ask) |
| `task` | a piece of work | `assignee` | planned, in-progress, in-testing, blocked, done, cancelled | [`plan/work/tasks/records`](../examples/projects/showcase-garden/sections/plan/work/tasks/records) (custom workflow) |
| `issue` | a defect or problem | `severity`, `area` | open, reopened, in-progress, in-testing, awaiting-verification, answered, blocked, fixed, verified, wont-fix, duplicate | [`plan/work/issues/records`](../examples/projects/showcase-garden/sections/plan/work/issues/records) |
| `review` | something to review | | needs-review, in-review, changes-requested, approved, rejected, done | [`plan/work/reviews/records`](../examples/projects/showcase-garden/sections/plan/work/reviews/records) |
| `progress` | a progress note with a percentage | | published, draft | [`library/progress-notes/records`](../examples/projects/showcase-garden/sections/library/progress-notes/records) |
| `activity` | an event kept as a record | | info, success, warning, failure | [`library/activity-notes/records`](../examples/projects/showcase-garden/sections/library/activity-notes/records) |
| `document` | a document with a lifecycle | | draft, proposed, accepted, published, superseded, deprecated | [`library/documents/records`](../examples/projects/showcase-garden/sections/library/documents/records) |
| `generic` | anything else | | open, active, waiting, blocked, done, closed | [`library/notes/records`](../examples/projects/showcase-garden/sections/library/notes/records) |

A task with every common key:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-T-001",
  "recordType": "task",
  "title": "Prune the apple trees",
  "summary": "Rows 1 to 3 done",
  "status": "in-progress",
  "statusLabel": "Pruning",
  "priority": "high",
  "order": 1,
  "createdAt": "2026-11-01T09:00:00Z",
  "updatedAt": "2026-11-12T16:00:00+01:00",
  "bodyMarkdown": "Prune before the first frost. **Keep** the cuttings for the compost.",
  "attachments": [{ "id": "ORC-T-001-plan", "title": "Row plan", "path": "plans/rows.md", "mimeType": "text/markdown" }],
  "links": [{ "title": "Pruning guide", "url": "https://example.invalid/pruning" }],
  "linkedRecords": ["ORC-Q-001"],
  "metadata": { "rows": 6, "done": 3, "ladder": true },
  "history": [{ "at": "2026-11-01T09:00:00Z", "text": "Created", "by": "orchard-bot" }],
  "notifyUser": false,
  "requiresAction": false,
  "percent": 50,
  "external": [{ "system": "ticket tracker", "id": "ORC-12", "url": "https://tracker.example.org/ORC-12", "status": "open", "statusAt": "2026-11-12T08:00:00Z" }],
  "assignee": "pruning-team"
}
```

An issue:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-I-001",
  "recordType": "issue",
  "title": "Sprinkler 4 leaks",
  "status": "open",
  "priority": "medium",
  "severity": "major",
  "area": "Irrigation",
  "updatedAt": "2026-11-12T08:00:00Z",
  "notifyUser": true
}
```

A review, a progress note, an activity record, a document and a generic record:

<!-- example: record -->
```json
{ "schemaVersion": 1, "id": "ORC-R-001", "recordType": "review", "title": "Review the planting plan", "status": "needs-review", "updatedAt": "2026-11-12T08:00:00Z" }
```

<!-- example: record -->
```json
{ "schemaVersion": 1, "id": "ORC-P-001", "recordType": "progress", "title": "Pruning progress", "status": "published", "percent": 50, "updatedAt": "2026-11-12T08:00:00Z" }
```

<!-- example: record -->
```json
{ "schemaVersion": 1, "id": "ORC-A-001", "recordType": "activity", "title": "Harvest logged: 40 kg", "status": "success", "updatedAt": "2026-11-12T08:00:00Z" }
```

<!-- example: record -->
```json
{ "schemaVersion": 1, "id": "ORC-D-001", "recordType": "document", "title": "Picking rules", "status": "draft", "updatedAt": "2026-11-12T08:00:00Z", "bodyMarkdown": "1. Pick ripe fruit only." }
```

<!-- example: record -->
```json
{ "schemaVersion": 1, "id": "ORC-G-001", "recordType": "generic", "title": "Tree count", "status": "active", "updatedAt": "2026-11-12T08:00:00Z", "metadata": { "trees": 48 } }
```

External references (`external`): up to 20 `{system, id, title?, url?, ref?, status?, statusAt?}`; shown as
"\<system\> reports …", never mixed with the record's own `status`. Showcase: `SG-T-001`, `SG-I-002`, `SG-R-001`.

## C. Question and answer types

A question is a `question` record. `requiresResponse: true` (default) needs an `answerSchema`; the card shows a form
and the answer goes to the queue ([QUEUE.md](QUEUE.md)). Only `status: "open"` accepts an answer. Bump
`questionRevision` when the question changes meaning. A `default` is only pre-selected ("Suggested default: …"); it
is never submitted for the user. Showcase: [`plan/ask`](../examples/projects/showcase-garden/sections/plan/ask).

| `type` | Purpose | Options (defaults) | Showcase |
|---|---|---|---|
| `single-choice` | pick one | `options[]` (`id`, `label`, `description?`), `allowOther` (false), `allowExplanation` (false), `required` (true), `default` (an option id) | `SG-Q-001` |
| `multiple-choice` | pick several | as single choice plus `minSelected` (1), `maxSelected`, `default` (option ids) | `SG-Q-002` |
| `free-text` | type an answer | `required` (true), `minLength` (1), `maxLength` (5000), `multiline` (true), `placeholder`, `default` | `SG-Q-010` (one line), `SG-Q-011` (multiline) |
| `approval` | approve or reject; also yes/no | `required` (true), `allowRationale` (true), `requireRationaleOnReject` (false), `default` (`approve` or `reject`) | `SG-Q-012`, `SG-Q-013` |
| `file-upload` | send files | `required` (true), `minFiles` (1), `maxFiles` (5), `allowedMimeTypes` (subset of the server list), `allowComment` (true) | `SG-Q-020` |
| `composite` | several fields in one form | `fields[]`: each `{id, label, help?}` plus one plain type above | `SG-Q-021` |
| informational | a notice, no form | `requiresResponse: false`, no `answerSchema` | `SG-Q-030` |

Single choice:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-001",
  "recordType": "question",
  "title": "Which rootstock for the new row?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "taskId": "ORC-T-001",
  "dueAt": "2026-11-30T18:00:00Z",
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": {
    "type": "single-choice",
    "options": [
      { "id": "dwarf", "label": "Dwarf", "description": "Easy picking" },
      { "id": "semi", "label": "Semi-dwarf" }
    ],
    "allowOther": true,
    "allowExplanation": true,
    "required": true,
    "default": "dwarf"
  }
}
```

Multiple choice:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-002",
  "recordType": "question",
  "title": "Which varieties should we plant?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": {
    "type": "multiple-choice",
    "options": [{ "id": "a", "label": "Early red" }, { "id": "b", "label": "Late green" }, { "id": "c", "label": "Russet" }],
    "minSelected": 1,
    "maxSelected": 2,
    "default": ["a"]
  }
}
```

Free text, one line and multiline:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-003",
  "recordType": "question",
  "title": "Name for the new row?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": { "type": "free-text", "multiline": false, "minLength": 2, "maxLength": 60, "placeholder": "e.g. Sunny row", "default": "Row 7" }
}
```

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-004",
  "recordType": "question",
  "title": "Describe the damage you saw",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": { "type": "free-text", "multiline": true, "minLength": 20, "maxLength": 4000, "placeholder": "Where, how many trees, since when" }
}
```

Approval:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-005",
  "recordType": "question",
  "title": "Approve the net purchase?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": { "type": "approval", "required": true, "allowRationale": true, "requireRationaleOnReject": true, "default": "approve" }
}
```

File upload:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-006",
  "recordType": "question",
  "title": "Upload photos of the bark damage",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": { "type": "file-upload", "required": true, "minFiles": 1, "maxFiles": 3, "allowedMimeTypes": ["image/png", "image/jpeg"], "allowComment": true }
}
```

Composite (mixes plain types; each field has its own id):

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-007",
  "recordType": "question",
  "title": "Plan the picking day",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-12T09:00:00Z",
  "answerSchema": {
    "type": "composite",
    "fields": [
      { "id": "go", "label": "Hold the picking day", "type": "approval", "default": "approve" },
      { "id": "slot", "label": "Time slot", "type": "single-choice", "options": [{ "id": "am", "label": "Morning" }, { "id": "pm", "label": "Afternoon" }] },
      { "id": "crates", "label": "Crates", "type": "multiple-choice", "options": [{ "id": "small", "label": "Small" }, { "id": "large", "label": "Large" }], "minSelected": 0, "required": false },
      { "id": "notes", "label": "Notes", "type": "free-text", "required": false, "minLength": 0, "help": "Anything pickers should know" },
      { "id": "map", "label": "Map", "type": "file-upload", "required": false, "minFiles": 0, "maxFiles": 1 }
    ]
  }
}
```

Informational (no form; listed under Responses while unread):

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-Q-008",
  "recordType": "question",
  "title": "The orchard gate is closed on Sunday",
  "status": "open",
  "requiresResponse": false,
  "notifyUser": true,
  "updatedAt": "2026-11-12T09:00:00Z"
}
```

Question statuses are fixed and set by the producer: `open` (accepts an answer), `answered`, `processed`, `closed`,
`withdrawn`. The form state the user sees (needs response, submitted, processing, processed, failed) comes from the
answer queue. Showcase: `SG-Q-003` answered, `SG-Q-004` processed, `SG-Q-005` closed. Answer JSON:
[API.md](API.md#answervalue-one-per-field).

## D. Tracked field types

**Purpose:** independent typed values on every record of a card ("Reviewed", "Decision", "Available?"), each changed
on its own and logged in `history`. **Shows:** a control on each record row and in the detail; `filter: true` adds a
filter above the card. Defined in the card's `fields` (up to 20); values in each record's `fields`.

| `type` | Value | Notes |
|---|---|---|
| `checkbox` | `true` / `false` | filterable |
| `yes-no` | `true` = yes, `false` = no | Yes / No buttons that save on tap, also on the row; filterable; see [daily Yes / No](#daily-yes--no-items) |
| `choice` | an option id | needs `options` (1 to 30 `{id, label}`); filterable |
| `text` | up to 2000 characters | |
| `date` | `YYYY-MM-DD` | |

**Required:** `id`, `label`, `type` (`options` for `choice`). **Optional:** `help`, `editableBy` (`["user"]`,
`["agent"]` or both, the default), `filter`. Showcase: [`plan/work/reviews`](../examples/projects/showcase-garden/sections/plan/work/reviews/section.json)
(all but `yes-no`) and [`plan/daily/checkins`](../examples/projects/showcase-garden/sections/plan/daily/checkins/section.json) (`yes-no`).

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "reviews",
  "displayType": "expandable-card",
  "title": "Reviews",
  "actions": ["copy", "open-detail", "comment", "mark-read"],
  "fields": [
    { "id": "reviewed", "label": "Reviewed", "type": "checkbox", "editableBy": ["user"], "filter": true },
    { "id": "ready", "label": "Ready to plant?", "type": "yes-no", "editableBy": ["user"], "filter": true },
    { "id": "decision", "label": "Decision", "type": "choice", "editableBy": ["user"], "filter": true,
      "options": [{ "id": "approve", "label": "Approve" }, { "id": "changes", "label": "Request changes" }] },
    { "id": "checks", "label": "Checks passed", "type": "checkbox", "editableBy": ["agent"], "help": "Set by the planning agent" },
    { "id": "note", "label": "Note", "type": "text", "editableBy": ["user", "agent"] },
    { "id": "followUp", "label": "Follow-up by", "type": "date" }
  ]
}
```

A record in that card with values set (a missing key or `null` means not set):

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-R-002",
  "recordType": "review",
  "title": "Review the watering plan",
  "status": "approved",
  "updatedAt": "2026-11-12T08:00:00Z",
  "fields": { "reviewed": true, "ready": false, "decision": "approve", "checks": true, "note": "Fits the rota", "followUp": "2026-12-01" }
}
```

## E. Recurring items

A file in a card's `templates/` folder makes the server create one record per day (`<template id>-<YYYY-MM-DD>`) from
`record`, exactly once, without an agent. `state` is `active`, `paused` or `disabled`; pause and resume from the
card's "Recurring templates" list. **Required:** `schemaVersion`, `id`, `title`, `schedule.frequency` (`daily`),
`schedule.timezone`, `schedule.startDate`, `record`. **Optional:** `state`, `schedule.time` (`00:00`),
`schedule.endDate`, `schedule.catchUpDays` (0). `record` must not set `id`, `occurrence` or `attachments`; `{date}`
in its title, summary and body becomes the day.

### Daily Yes / No items

**Purpose:** a value that is in effect every day without anyone answering, for example "Available for the evening
check?". **Shows:** one record per day with Yes / No buttons; the template's value is the day's default; a tap saves at
once (no Submit) and changes only that day. **Needs:** a card with a `yes-no` field and an active template whose
`record.fields` sets it. Agents read today's value with `apd daily <template> --field <id>` or
`GET /api/projects/:p/templates/:t/current` (`fields` holds `true`/`false`, `labels` holds `yes`/`no`).
Showcase: [`plan/daily/checkins`](../examples/projects/showcase-garden/sections/plan/daily/checkins) with template
`evening-check` and an earlier day that kept its own value.

The card (`sections/checkins/section.json`):

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "checkins",
  "displayType": "expandable-card",
  "title": "Evening check-in",
  "defaultOpen": true,
  "pinned": true,
  "fields": [{ "id": "available", "label": "Available for the evening check?", "type": "yes-no", "editableBy": ["user"], "filter": true }]
}
```

The template (`sections/checkins/templates/evening-check.json`):

<!-- example: template -->
```json
{
  "schemaVersion": 1,
  "id": "evening-check",
  "title": "Available for the evening check?",
  "state": "active",
  "schedule": { "frequency": "daily", "time": "06:00", "timezone": "Europe/Lisbon", "startDate": "2026-11-10" },
  "record": { "recordType": "generic", "title": "Available for the evening check? {date}", "status": "open", "fields": { "available": true } }
}
```

`time` is the daily reset. Before `startDate` and after `endDate` there is no current day.

`"pinned": true` also shows the current day's row above the project's tabs, so the value can be changed from any
view ([ADR 0023](adr/0023-pinned-cards.md)); the card with earlier days stays in its tab.

### Daily pinned choice

**Purpose:** a daily question with your own answers that never has to be answered, for example "What's the plan
tonight?". **Shows:** above the project's tabs, today's row with one button per answer; the default is pressed until
someone taps another, a tap saves at once (no Submit), and every day starts from the default again at the reset time.
**Needs:** a card with `"pinned": true` and a user `choice` field (the question is its `label`, the answers its
`options`), and an active template whose `record.fields` sets the default and whose `schedule.time` is the reset.
Agents read today's answer with `apd daily <template> --field <id>` (`value` = option id, `label` = its text).
Showcase: [`plan/daily/evening-plan`](../examples/projects/showcase-garden/sections/plan/daily/evening-plan).

<!-- example: section -->
```json
{
  "schemaVersion": 1,
  "id": "evening-plan",
  "displayType": "expandable-card",
  "title": "Tonight in the garden",
  "pinned": true,
  "fields": [{ "id": "plan", "label": "What's the plan tonight?", "type": "choice", "editableBy": ["user"],
    "options": [{ "id": "water", "label": "Water the beds" }, { "id": "weed", "label": "Weed" }, { "id": "rest", "label": "Rest" }] }]
}
```

<!-- example: template -->
```json
{
  "schemaVersion": 1,
  "id": "evening-plan",
  "title": "Tonight in the garden",
  "state": "active",
  "schedule": { "frequency": "daily", "time": "00:00", "timezone": "Europe/Lisbon", "startDate": "2026-11-10" },
  "record": { "recordType": "generic", "title": "Tonight in the garden {date}", "status": "open", "fields": { "plan": "water" } }
}
```

### Recurring question

A daily question; its defaults are only shown, nothing is answered until the user submits. Showcase: `watering-log`
in [`plan/daily/daily-logs/templates`](../examples/projects/showcase-garden/sections/plan/daily/daily-logs/templates).

<!-- example: template -->
```json
{
  "schemaVersion": 1,
  "id": "watering-log",
  "title": "Watering log",
  "state": "active",
  "schedule": { "frequency": "daily", "time": "19:00", "timezone": "Europe/Lisbon", "startDate": "2026-11-10", "endDate": "2027-03-31", "catchUpDays": 1 },
  "record": {
    "recordType": "question",
    "title": "Watering log {date}",
    "status": "open",
    "requiresResponse": true,
    "questionRevision": 1,
    "answerSchema": { "type": "approval", "default": "approve" }
  }
}
```

### Paused template

Creates nothing until resumed; resuming starts from today. Showcase: `compost-reading`.

<!-- example: template -->
```json
{
  "schemaVersion": 1,
  "id": "frost-check",
  "title": "Frost check",
  "state": "paused",
  "schedule": { "frequency": "daily", "time": "07:00", "timezone": "Europe/Lisbon", "startDate": "2026-11-01" },
  "record": { "recordType": "task", "title": "Frost check {date}", "status": "planned" }
}
```

## F. Statuses, workflows and attention groups

### Workflows

Every non-question type has a status vocabulary; each status belongs to a category (`open active waiting blocked done
closed`) that drives counts and colours. `workflows.<type>` in `project.json` replaces a default; `tone` is optional
(`neutral info ok warn danger`); `unknownStatus` is `warn` (default) or `strict`. Showcase: a custom task workflow with
`waiting-on-weather` in [`project.json`](../examples/projects/showcase-garden/project.json).

<!-- example: project -->
```json
{
  "schemaVersion": 1,
  "id": "orchard-workflow",
  "displayName": "Orchard (custom task workflow)",
  "workflows": {
    "task": {
      "unknownStatus": "strict",
      "statuses": [
        { "id": "planned", "label": "Planned", "category": "open" },
        { "id": "growing", "label": "Growing", "category": "active" },
        { "id": "waiting-on-weather", "label": "Waiting on weather", "category": "waiting", "tone": "info" },
        { "id": "stuck", "label": "Stuck", "category": "blocked", "tone": "warn" },
        { "id": "done", "label": "Done", "category": "done", "tone": "ok" },
        { "id": "skipped", "label": "Skipped", "category": "closed" }
      ]
    }
  }
}
```

### Actions and updates on records

- `requiresAction: true`: the record asks the user to do something and is listed under **Actions** until a question is
  answered, or another record's status is in a `done` or `closed` category. Agents set it with
  `apd update ID --action true` and complete it with `apd update ID --status done`. Showcase: `SG-Q-013` (open action
  question), `SG-T-002` (open action task), `SG-T-003` (completed action).
- `notifyUser: true`: the record is an unread update until the user marks it read; a new `updatedAt` makes it unread
  again. Showcase: `SG-T-004`, `SG-I-001`, `SG-A-002`, `SG-Q-030`, `SG-Q-031`.

An open action:

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-T-002",
  "recordType": "task",
  "title": "Unlock the gate for the delivery",
  "status": "planned",
  "requiresAction": true,
  "priority": "high",
  "updatedAt": "2026-11-12T08:00:00Z"
}
```

### Attention groups

The `attention` view and `GET /api/projects/:p/attention/:group` list what needs the user. Each pending record is in
exactly one group; "Show all" (`?all=1`) adds answered, completed and read history. Items can be selected (or all
selected) and marked read; marking read never answers or completes anything. `apd attention` prints the counts.

| Group | Pending | Showcase |
|---|---|---|
| Questions | questions awaiting an answer, not marked `requiresAction` | `SG-Q-001`, `SG-Q-002`, `SG-Q-010` … |
| Actions | `requiresAction` records still to do | `SG-Q-013`, `SG-T-002` (and `SG-T-003` in Show all) |
| Responses | unread `notifyUser` questions that do not await an answer | `SG-Q-030`, `SG-Q-031` |
| Updates | unread `notifyUser` records of other types | `SG-T-004`, `SG-I-001`, `SG-A-002` |

Read state lives in the backend-owned `user-state/` folder; never write it.

## G. Actions

A section's `actions` (default `["copy", "open-detail"]`) lists what the card offers; a record's own `actions` can
only narrow them. The server still checks every request. Selecting records is offered when the card has `copy`,
`export-xlsx` or `bulk-download`.

| Action | What the user gets | Notes | Showcase card |
|---|---|---|---|
| `copy` | copy the selected records (or one record) as text | | every card |
| `download` | download a record's attachments | added automatically to records with attachments | `issues`, `documents` |
| `bulk-download` | download the files of the selected records as one ZIP (with a preflight of missing files) | | `files-composites`, `issues`, `documents` |
| `export-xlsx` | export the selected questions to an `.xlsx` workbook | questions only ([EXCEL.md](EXCEL.md)) | `choices`, `text-approvals` |
| `import-xlsx` | import a filled-in workbook with a preview step | stale or invalid rows are never applied | `choices`, `text-approvals` |
| `respond` | the answer form | added automatically to questions with `requiresResponse` | question cards |
| `upload` | listed for cards whose questions take files | see the note below | `files-composites` |
| `mark-read` | "Mark read" on unread records | added automatically to `notifyUser` records | `notices`, `tasks`, `activity-notes` |
| `comment` | the user adds comments and files to a record (`POST …/records/:id/user-update`) | without it the server answers 403 `not-allowed` | `tasks`, `issues`, `reviews`, `notes` |
| `open-detail` | open the record's detail | | every card |

Note: in this release the UI does not read `upload` or `open-detail`. File-upload questions take files whatever the
card lists, and every record's detail opens. Listing them states the card's intent.

## H. Attachments, artifact roots, progress and activity

### Attachments and artifact roots

A record attachment is `{id, title?, path, root?, mimeType?}`. Without `root` (or with `"attachments"`), `path` is
relative to the project's `allowedAttachmentRoot`; with `root` set to one of the project's `artifactRoots`, it is
relative to that read-only folder. Attachment ids are unique per project. The browser downloads by id; images, PDF and
plain text open inline, everything else downloads. A missing file shows as unavailable. Showcase files:
[`attachments/`](../examples/projects/showcase-garden/attachments) and the artifact root
[`docs/handbook/`](../examples/projects/showcase-garden/docs/handbook) (record `SG-D-001`).

<!-- example: record -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-D-002",
  "recordType": "document",
  "title": "Orchard handbook",
  "status": "published",
  "updatedAt": "2026-11-12T08:00:00Z",
  "attachments": [
    { "id": "ORC-D-002-map", "title": "Row map", "path": "plans/rows.md", "mimeType": "text/markdown" },
    { "id": "ORC-D-002-report", "title": "Season report", "path": "season-2026.md", "root": "docs/reports", "mimeType": "text/markdown" }
  ]
}
```

### Progress

**Purpose:** published project progress, never computed by the dashboard. **Shows:** the `progress` view and the
compact bar on the project card; "Not reported" when `overallPercent` is null or the file is missing; stale after
`progressStaleAfterDays`. **Required:** `schemaVersion`. Showcase: [`progress.json`](../examples/projects/showcase-garden/progress.json).

<!-- example: progress -->
```json
{
  "schemaVersion": 1,
  "overallPercent": 45,
  "label": "Season readiness",
  "method": "Weighted share of the season checklist",
  "updatedAt": "2026-11-14T09:00:00Z",
  "breakdown": [
    { "id": "trees", "title": "Trees", "percent": 70, "detail": "Pruning on schedule", "weight": 3, "updatedAt": "2026-11-14T09:00:00Z" },
    { "id": "signs", "title": "Signage", "percent": null }
  ]
}
```

### Activity events

**Purpose:** a feed of what happened, one file per event in `activityDir` (default `activity/events/<id>.json`).
**Shows:** the `activity` view; new events count as unread updates. **Required:** `schemaVersion`, `id`, `at`,
`action`, `summary`. **Optional:** `area`, `source`, `status` (`info` default, `success`, `warning`, `failure`),
`recordId`. Showcase: [`activity/events/`](../examples/projects/showcase-garden/activity/events) (one of each status).

<!-- example: activity -->
```json
{
  "schemaVersion": 1,
  "id": "ORC-EV-001",
  "at": "2026-11-14T06:45:00Z",
  "area": "Irrigation",
  "action": "test",
  "source": "orchard-bot",
  "summary": "Sprinkler test failed: valve 2 did not open",
  "status": "failure",
  "recordId": "ORC-I-001"
}
```
