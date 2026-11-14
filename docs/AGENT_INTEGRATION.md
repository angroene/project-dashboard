# Agent integration

How coding agents, CI jobs and scripts talk to the dashboard: discover a project, publish questions, tasks, issues,
reviews, activity and progress, and pick up the owner's answers. Everything here is plain HTTP plus one optional
single-file CLI. Nothing depends on a particular agent runtime, model, VCS or host.

- HTTP reference: [API.md](API.md). Queue guarantees: [QUEUE.md](QUEUE.md). File formats: [PROJECT_FORMAT.md](PROJECT_FORMAT.md).
- Skills that tell an agent *when* to call these tools: [SKILLS.md](SKILLS.md).
- Decisions: [ADR 0009](adr/0009-agent-publishing-api.md) (publishing through the server),
  [ADR 0010](adr/0010-scoped-agent-tokens.md) (scoped tokens).

## Two ways to produce data

| | Files (local producer) | HTTP publish API |
|---|---|---|
| Who | a process that can write into the project folder | any authorised client, on any host |
| How | write `.<name>.tmp`, rename to `<name>.json` ([PROJECT_FORMAT.md](PROJECT_FORMAT.md)) | `PUT`/`PATCH` calls below, or `apd` |
| Validation | by the dashboard when it reads the file; bad files show in Diagnostics | before anything is written; bad input gets `422` |
| Needs | filesystem access | `"publishing": { "enabled": true }` in `project.json` |

Both produce the **same files**: the server writes exactly what a local producer would write, so a project can mix
both, and switching between them needs no migration. Answers are always consumed through the queue
([QUEUE.md](QUEUE.md)), from the API or `scripts/queue.ts`.

## Contract inventory

What an agent needs, and what provides it. Rows marked *agent API* were added for agents; everything else existed and is
reused unchanged.

| Agent operation | Endpoint (under `/api/projects/:projectId`) | CLI |
|---|---|---|
| Discover projects | `GET /api/projects` (filtered to the token's projects) | `apd projects` |
| Discover sections, statuses, answer types, limits | `GET /capabilities` *agent API* | `apd capabilities` |
| Publish or replace a question, task, issue, review, document | `PUT /records/:recordId` *agent API* | `apd ask`, `apd publish` |
| Change status, percent, summary, add a history note | `PATCH /records/:recordId` *agent API* | `apd update` |
| Set agent-editable tracked fields, replace external references | `PATCH /records/:recordId` (`fields`, `external`) | `apd update --field id=value --external refs.json` |
| Find records by status, text or field value (summaries, paged) | `GET /sections/:sectionId/records?status=&q=&field.<id>=` | `apd list` |
| See recurring templates and their state | `GET /templates` | `apd templates` |
| Read a record as stored, with its revision | `GET /records/:recordId/source` *agent API* | `apd source` |
| Publish an activity event | `PUT /activity/:eventId` *agent API* | `apd event` |
| Publish project progress | `PUT /progress` *agent API* | `apd progress` |
| Upload evidence or a file for a record | `POST /uploads` | `apd upload` |
| List pending answer ids only | `GET /queue?state=pending[&taskId=][&questionId=]` (filters: *agent API*) | `apd pending`, `apd hint` |
| Read one answer | `GET /queue/:answerId` | `apd answer`, `apd status` |
| Download an answer's file | `GET /attachments/:attachmentId` | `apd download` |
| Claim, complete, fail or requeue an answer | `POST /queue/claim`, `/queue/:id/complete`, `/queue/:id/fail` | `apd claim`, `complete`, `fail [--retry]` |
| Recover expired leases | `POST /queue/recover` (also automatic every 60 s) | |

There is one queue and one record format. The publish API writes the existing formats; it adds no agent-specific
record type, answer format or second queue.

## Data contract (version 1)

`GET /capabilities` returns `apiVersion: 1`. Every file carries `schemaVersion: 1`. The record envelope, field limits
and answer schema types are in [PROJECT_FORMAT.md](PROJECT_FORMAT.md#records); the zod schemas in
`src/shared/schemas.ts` are authoritative.

| Concept | Field(s) |
|---|---|
| Project identity | `projectId` in every URL; `project.json` `id` |
| Work area | `sectionId`: an expandable-card section id from `capabilities.publishing.sections` (logical id, never a path) |
| Record identity | `id`, unique per project, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, chosen by the producer and stable |
| Type | `recordType`: `question task issue review progress activity document generic` |
| Status | `status` from the project's workflow for that type (`capabilities.recordTypes`); questions use fixed statuses |
| Priority, severity | `priority` (`critical high medium low none`); `severity`, `area` on issues |
| Timestamps | `createdAt`, `updatedAt` (ISO 8601 with offset; `updatedAt` defaults to the server time) |
| Content | `title`, `summary`, `bodyMarkdown`, `metadata`, `links`, `linkedRecords`, `history` |
| Question | `requiresResponse`, `answerSchema` (`single-choice multiple-choice free-text approval file-upload composite`), `questionRevision`, `taskId`, `dueAt` |
| Attachments | `{id, path, root?, title?}`, or `{uploadId, title?}` for a file uploaded through the API |
| Revision | `revision`: first 16 hex characters of the SHA-256 of the stored file; send it back as `ifRevision` |
| Idempotency | `PUT` of the same content is `unchanged`; `PATCH` history entries de-duplicate on `at` + `text`; events are immutable; answers use `idempotencyKey` |
| Answer lifecycle | `pending -> processing -> processed`, or `failed`, or back to `pending` ([QUEUE.md](QUEUE.md#answer-states)) |

Status labels and workflows are configured per project ([PROJECT_FORMAT.md](PROJECT_FORMAT.md#status-workflows)).
Nothing in the API maps statuses for a particular project.

## Enabling publishing for a project

```json
"publishing": { "enabled": true, "sections": ["questions", "tasks", "issues", "reviews"] }
```

- Off by default. Without it every write call returns `403 publishing-disabled`.
- `sections` limits record writes to those card ids (omit it to allow every card). A card outside the list gives
  `403 section-not-allowed`; a tab gives `422 not-a-card`.
- Activity events go to the project's `activityDir`, progress to its `progressFile`. Clients never send paths.
- The example project `lantern-web-app` has publishing on; `tidepool-notebook` has it off.

## Authentication

| Server mode | What a client sends |
|---|---|
| Loopback, no token (default `127.0.0.1`) | nothing; every local process has full access |
| Token mode (required for any other bind) | `Authorization: Bearer <token>`: the operator token (full access) or a **scoped agent token** |

Browser sessions (cookie after `POST /api/auth/login`) keep working. Every non-GET request also needs
`X-PCC-Request: 1`, bearer or not.

### Scoped agent tokens

The operator lists agent tokens in a JSON file and points `agentTokensFile` (or `PCC_AGENT_TOKENS_FILE`) at it.
The file holds **hashes only**:

```json
{
  "schemaVersion": 1,
  "tokens": [
    { "name": "lantern-agent", "sha256": "<64 hex>", "projects": ["lantern-web-app"], "scopes": ["read", "publish", "consume"] }
  ]
}
```

Create a token (the token goes only into the file you name, created with mode 600; stdout gets the entry above):

```sh
npm run agent-token -- lantern-agent ./lantern-agent.token --projects lantern-web-app --scopes read,publish,consume
```

| Scope | Allows |
|---|---|
| `read` | project list, project, capabilities, navigation, records, record source, progress, activity, attention, attachments, queue list and answers |
| `publish` | `PUT`/`PATCH` records, `PUT` activity, `PUT` progress, `POST` uploads |
| `consume` | queue claim, complete, fail, recover |

- `projects` lists project ids, or `"*"` for all. Another project's URLs answer `404`, as if it did not exist.
- Never allowed for agent tokens: submitting answers, Excel import/export, ZIP downloads, marking read, diagnostics,
  reindex and the live-update stream. Those are the owner's (`403 forbidden`).
- Wrong bearer tokens count as failed logins (429 after 5). Restart the server after editing the token file.
- `agentTokensFile` requires token mode; the server refuses to start otherwise, with a malformed file, or when an agent
  token equals the operator token.
- Revoke a token by removing its entry and restarting.

## The `apd` CLI

`agent-kit/cli/apd.mjs`: one file, no dependencies, Node 22 or newer. Copy it wherever the agent runs.

```sh
export APD_URL=https://dashboard.example.internal:8790   # default http://127.0.0.1:8790
export APD_PROJECT=lantern-web-app
export APD_TOKEN_FILE=$HOME/.config/apd/lantern.token    # omit on a loopback server without auth
export APD_OWNER=lantern-agent                            # stable consumer name for claims
node apd.mjs capabilities
```

The token is read from `APD_TOKEN_FILE` only, never from the command line, and never printed or stored in the
outbox. For a self-signed certificate start Node with `NODE_EXTRA_CA_CERTS=/path/to/cert.pem`.

| Command | Does |
|---|---|
| `projects`, `capabilities`, `templates` | discovery |
| `list --section S [--status a,b] [--field id=v,w]... [--q text] [--limit n] [--cursor c]` | one page of record summaries, filtered on the server |
| `ask --section S --id ID (--file f.json \| --json '{...}')` | publish a question (fills `recordType`, `status: open`, `requiresResponse`, `questionRevision: 1`) |
| `publish --section S --id ID (--file \| --json)` | publish any record |
| `update ID [--status] [--label] [--summary] [--percent n\|none] [--priority] [--notify] [--note text] [--by name] [--field id=value]... [--external refs.json] [--if-revision r]` | `PATCH`. `--field` values: `true`/`false` (checkbox), `none` (clear), anything else as text or option id. `--external` reads a JSON array and replaces the list. |
| `event ID --action A --summary S [--status] [--area] [--record] [--source]` | activity event |
| `progress (--file \| --percent n [--label] [--method])` | project progress |
| `upload FILE... [--question QID]` | upload, prints attachment ids |
| `source ID` | stored record and revision |
| `pending [--task T] [--question Q] [--state] [--limit] [--count]` | compact queue listing |
| `hint` | for hooks: one sentence if answers are waiting, nothing otherwise, always exit 0 |
| `answer A`, `status A` | full answer, or just its state |
| `claim [A] [--lease s]`, `complete A [--note]`, `fail A --reason R [--retry]` | queue lifecycle |
| `download ATT --out FILE [--force]` | save an attachment |
| `outbox`, `flush` | list and deliver calls queued while offline |

Output is one JSON line on stdout; errors are one JSON line on stderr (`error`, `message`, `status`, `fieldErrors`).

| Exit | Meaning |
|---|---|
| 0 | success (`claim` with nothing pending prints `{"claimed":false}`) |
| 1 | rejected by the server: fix the input, do not retry unchanged |
| 2 | usage or local configuration error |
| 3 | server unreachable or failing after retries; publish calls were queued in the outbox |
| 4 | outcome unknown: a claim, complete, fail or upload was interrupted after it was sent; check `status` |

## Tracked fields, external references and recurring records

- A card's `fields` say who may change each value (`editableBy`). Agents can set `agent` fields with `apd update
  --field`; a user-only field (for example "Reviewed") is refused with `403 field-not-editable`, also inside a full
  `publish`. Read the definitions from `apd list` (`fieldDefs`) or the section's `section.json`.
- `external` references record what another system reported (`status`, `statusAt`). Refresh them from that system;
  never copy them into the record's own `status`.
- Recurring records are created by the server from `templates/` files, not by agents. They are ordinary records:
  answer handling, `update` and the queue work the same. A question's `default` is never an answer; only answers the
  user submitted appear in `apd pending`.
- To avoid reading every record, ask the server: `apd list --section reviews --field reviewed=true --status needs-review`
  returns only matching summaries, 50 per page.

## Queue lifecycle for agents

1. `apd pending --task T` at a work boundary: ids only, nothing else is read.
2. `apd claim <answerId> --lease <seconds longer than the work>`.
3. Apply the answer idempotently (key on `answerId`). Files: `apd download`.
4. `apd complete <answerId> --note ...`, or `apd fail ... --retry` (back to pending), or `apd fail ...` (final; the
   owner can answer again). Earlier answers stay on disk in `processed/` or `failed/` with their audit trail.
5. `apd update <questionId> --status processed` so the owner sees it is handled.

If the agent dies, the lease expires and the answer returns to `pending` (`attempts` counts claims). Two consumers can
never hold the same answer: claims are exclusive across processes.

## When the dashboard is offline

- `PUT` and `PATCH` and all reads are retried with back-off (`APD_RETRIES`, default 3: 0.5 s, 1 s, 2 s).
- A publish call that still fails is written to the outbox (`APD_OUTBOX`, default `./.apd-outbox`) and the CLI exits 3.
  `apd flush` replays queued calls in order; a call the server rejects is moved to `outbox/rejected/` with the reason;
  replays are safe because publish calls are idempotent.
- Queue calls (`claim`, `complete`, `fail`) are not queued: they only make sense against the live queue. They are
  retried only when the request certainly never reached the server; otherwise the CLI exits 4 and the agent checks
  `status`. A lost `complete` is safe: the lease expires and the answer is delivered again (at-least-once).
- Answers are never lost: they are files on the server, untouched until a consumer acknowledges them.
- An agent should report a blocking dashboard outage in one short chat line, not silently assume success.

## Different hosts

The agent needs only HTTPS access to the server and a token; it never needs the project folder. Recommended setup
for an agent on another machine:

1. Server in token mode with TLS ([DEPLOYMENT.md](DEPLOYMENT.md)), reachable on the LAN or a VPN only.
2. A scoped token per agent or per project, with only the scopes it needs (`read,publish` for a reporter,
   `read,consume` for a consumer).
3. On the agent host: `apd.mjs`, the token file (mode 600), `APD_URL`, `APD_PROJECT`, and `NODE_EXTRA_CA_CERTS` for a
   self-signed certificate.

Uploads go through `POST /uploads` (size and type limits apply, see `capabilities.uploads`); records reference them
with `{"uploadId": ...}`.

## Several agents at once

- Publishing is serialised per project on the server: id uniqueness across sections is checked and written in one
  step, so two agents creating the same id in different sections get one `201` and one `409 id-conflict`.
- Use `ifRevision` from `GET /records/:id/source` when several writers may edit the same record; a stale revision
  gets `409 revision-mismatch` with the current revision.
- Queue claims are exclusive; give each consumer its own `APD_OWNER`.
- Read-only agents (`read` scope) can list pending answers but cannot claim them.

## Security notes

- Clients never send or receive filesystem paths. Records go to cards by section id; events, progress and uploads go
  to folders the project manifest declares; record attachment paths are resolved inside the project's attachment
  root and rejected if they escape it.
- The server writes only into: the project's `communications/`, `user-state/`, the attachment root's `answers/`
  folder, and, for projects that enable publishing, the allowed cards' `records/` folders, the `activityDir` and the
  `progressFile`. It never edits `project.json` or `section.json`.
- Treat agent tokens like passwords: one per agent, minimal scopes and projects, file mode 600, rotate by replacing
  the entry and restarting. Do not expose the server to the internet ([SECURITY_MODEL.md](SECURITY_MODEL.md)).
- Uploaded files are not virus-scanned.

## End-to-end demonstration

`npm run build && npm run demo:agent` runs [scripts/agent-demo.ts](../scripts/agent-demo.ts) on a temporary copy of the
example data, with token auth and a scoped agent token: the agent asks two questions with the CLI, the user answers
one with a file and one through Excel, the agent finds both by task id, claims, downloads, completes, publishes
progress, an issue with evidence, a review, an event and project progress, and after a server restart the API and
the browser show the right states. It prints one PASS/FAIL line per check. CI runs it in the browser job.
