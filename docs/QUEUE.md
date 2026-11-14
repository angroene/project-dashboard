# Questions, answers and the queue

This page is the contract between the dashboard and whatever produces questions and consumes answers: a script,
an agent, a CI job, or a person editing files by hand. Nothing here is specific to any tool.

## The flow in one picture

```text
producer                     dashboard / user                      consumer
--------                     ----------------                      --------
writes question JSON  ---->  shows it, user answers      
(you own the file)           answer is validated, written
                             to communications/answers/pending/ -> lists pending ids (API or folder)
                                                                    claims one (lease)
                                                                    does the work
                                                                    completes   -> processed/
                                                                    or fails    -> failed/ or back to pending/
producer updates the question status when it wants to (the dashboard never edits question files)
```

Producer and consumer are usually the same program, but they do not have to be.

## Who owns what

| Thing | Owner | Notes |
|---|---|---|
| Question record files (`sections/**/records/*.json`) | the producer | The dashboard only reads them. |
| Answer files (`communications/answers/<state>/*.json`) | the dashboard backend | Producers and consumers change them only through the queue API or `scripts/queue.ts`, never by hand. |
| Claim files (`communications/claims/*.json`) | the dashboard backend | One per answered question revision; the duplicate guard. |

## Answer states

| State (folder) | Meaning |
|---|---|
| `pending` | Submitted and valid, waiting for a consumer. The UI shows "Submitted, awaiting pickup". |
| `processing` | Claimed by a consumer under a time-limited lease. |
| `processed` | The consumer completed it. |
| `failed` | The consumer reported a final failure. The user can answer the question again. |

Transitions: `pending -> processing` (claim), `processing -> processed` (complete), `processing -> failed` (fail,
not retryable), `processing -> pending` (fail with `retryable: true`, or the lease expired).

The state the user sees for a question is derived from these folders; the question file is not rewritten.

## Delivery guarantees

- **At-least-once.** A consumer may see the same answer more than once (a crash after doing the work but before
  `complete`, a lease that expired during a long job). Exactly-once delivery is not provided.
- **Make your handler idempotent.** Use `answerId` (stable, unique) or the pair `questionId` + `questionRevision` as
  the idempotency key for whatever your consumer changes.
- **One answer per question revision.** The first submission creates a claim file with `O_EXCL`; a second answer for
  the same revision is rejected with `409 already-answered`. Only a `failed` answer, or a revision bump by the
  producer, allows a new answer.
- **Same idempotency key = same result.** If a browser or script retries a submit with the same `idempotencyKey`, the
  original answer is returned (`200`, `replayed: true`), not a second one.
- **Claims are exclusive** across processes: two consumers calling claim at the same moment get different answers.
- **Writes are atomic.** Answers are written to a temp file, fsynced and renamed, so a reader never sees half a file.

## Leases, failure and crash recovery

- A claim carries `lease: { owner, claimedAt, expiresAt }`. Default 600 seconds, allowed 10 to 86,400.
- Only the owner named in the lease may complete or fail the answer (`409 not-owner` otherwise).
- If a consumer dies, the lease expires and the answer returns to `pending` with an audit entry
  `lease-expired`. This happens automatically every 60 seconds and at every claim, or on demand with
  `POST /api/projects/:projectId/queue/recover`. The next claim increments `attempts`.
- Pick a lease longer than your longest job. There is no renewal call; if a job can outlive the lease, make it
  idempotent.
- Locks left behind by a crashed consumer are removed after 5 minutes.
- On startup the server also repairs answers that were staged but not yet published (crash between steps).
- A retryable failure (`retryable: true`) puts the answer back in `pending` with the reason recorded. A
  non-retryable failure moves it to `failed`; `attempts`, `result` and `audit` keep the history.

## How a consumer finds work without scanning question files

Never walk the question files looking for answered ones. Ask the queue for compact ids instead:

```text
GET /api/projects/:projectId/queue?state=pending&limit=500&after=<answerId>
-> { "items": [ { "answerId", "state", "questionId", "questionRevision", "submittedAt" } ], "next": "<answerId>" }
```

- `state`: `pending`, `processing`, `processed` or `failed`. Pass it explicitly.
- `limit`: 1 to 5000 (default 500). `after`: return ids after this one. `next` is present only when more remain.
- Items are oldest first (answer ids sort by submission time). The listing reads directory names and small claim
  files; it does not open answer or question files.
- Fetch the full answer only when you want it: `GET /api/projects/:projectId/queue/:answerId` (envelope with
  `processingState`, `attempts`, `lease`, `audit`; 404 if unknown, also 404 for an id from another project).
- Without the API, list the folder `<project>/communications/answers/pending/`: one file per answer, file name is
  the answer id. `npx tsx scripts/queue.ts <dataRoot> <projectId> list` prints all four states.

Typical polling loop: list `pending` every few seconds (or on the `/api/updates` event stream), claim, process,
complete.

## Consumer API

All POSTs need the header `X-PCC-Request: 1` and `Content-Type: application/json`. With token auth on, sign in first
([API.md](API.md#session)). `owner` is any label matching `^[A-Za-z0-9._:@-]{1,120}$` that identifies your consumer.

| Call | Body | Result |
|---|---|---|
| `GET /queue?state=...&limit=&after=` | | compact list, see above |
| `GET /queue/:answerId` | | full envelope |
| `POST /queue/claim` | `{ owner, leaseSeconds?, answerId? }` | the claimed envelope (`processingState: "processing"`); `204` when nothing is pending; with `answerId`, claims exactly that answer or `409 not-pending` |
| `POST /queue/:answerId/complete` | `{ owner, note? }` | envelope in `processed`; `409 not-owner`, `409 wrong-state` |
| `POST /queue/:answerId/fail` | `{ owner, reason, retryable? }` | envelope in `failed`, or in `pending` when `retryable` |
| `POST /queue/recover` | `{}` | `{ "recovered": [answerId, ...] }` |

(Paths are under `/api/projects/:projectId`.) Without a server, `scripts/queue.ts` offers `list`, `claim`,
`complete`, `fail` and `recover` directly on the files; it uses the same locking, so both can run together.

## Answer envelope

```json
{
  "schemaVersion": 1,
  "answerId": "ANS-MWFII1PR-4420D45615F9",
  "projectId": "lantern-web-app",
  "questionId": "LNT-Q-010",
  "questionRevision": 1,
  "submittedAt": "2026-11-13T21:51:52.623Z",
  "source": "dashboard",
  "submittedBy": "operator",
  "idempotencyKey": "demo-key-0001",
  "answers": [
    { "fieldId": "response", "kind": "choice", "optionIds": ["yes"], "explanation": "Drafts should never be lost." }
  ],
  "attachments": [],
  "processingState": "pending",
  "attempts": 0,
  "audit": [ { "at": "2026-11-13T21:51:52.623Z", "event": "submitted", "by": "operator", "note": "dashboard" } ]
}
```

`source` is `dashboard` or `excel-import`. After a claim the envelope also has `lease`; after complete or fail it has
`result` (`note`, or `reason` and `retryable`). `taskId` is copied from the question when present. Answer values per
type are in [API.md](API.md#answervalue-one-per-field). Uploaded files appear as attachment ids in `attachments` and
in a `files` answer value; download them with `GET /api/projects/:projectId/attachments/:attachmentId`.

## What the producer does after an answer

The dashboard never edits your question file. When you have consumed an answer you normally update the question
yourself (set `status` to `answered`, `processed` or `closed`, bump `updatedAt`), or leave it open. If the question
changes meaning, raise `questionRevision` so the old answer and old Excel rows become stale and the user can answer
again. Only a question with `status: "open"` accepts a new answer.

## Walkthrough: write a question, answer it, consume the answer

Everything below was run against the built server and the example projects. IDs and timestamps differ on every run.
Assumes Node 22 or newer and a bash-like shell (on Windows use Git Bash or WSL; PowerShell users translate the
quoting).

**1. Start the server on a temporary copy of the examples** (the server writes into its data root, so never point
it at the checked-in folder):

```sh
npm ci
npm run build
export DATA=$(mktemp -d)
cp -r examples/. "$DATA"/
PCC_DATA_ROOT="$DATA" PCC_PORT=8821 PCC_WEB_ROOT=dist/web npm start
```

Leave it running and open a second terminal. Set the same variables there (`export DATA=...` with the same path, plus
the two below):

```sh
export B=http://127.0.0.1:8821/api/projects/lantern-web-app
export H='-H X-PCC-Request:1 -H Content-Type:application/json'
curl -s http://127.0.0.1:8821/api/diagnostics     # expect "diagnostics":[]
```

**2. Producer: write a question.** Write to a hidden temp name, then rename, so the dashboard never reads a partial file:

```sh
D="$DATA/projects/lantern-web-app/sections/build/planning/questions/records"
cat > "$D/.LNT-Q-010.tmp" <<'EOF'
{
  "schemaVersion": 1,
  "id": "LNT-Q-010",
  "recordType": "question",
  "title": "Should autosave also run when the tab is in the background?",
  "status": "open",
  "requiresResponse": true,
  "questionRevision": 1,
  "updatedAt": "2026-11-13T12:00:00Z",
  "notifyUser": true,
  "answerSchema": {
    "type": "single-choice",
    "options": [
      { "id": "yes", "label": "Yes, always" },
      { "id": "no", "label": "No, only when the tab is visible" }
    ],
    "allowOther": false,
    "allowExplanation": true
  }
}
EOF
mv "$D/.LNT-Q-010.tmp" "$D/LNT-Q-010.json"
```

**3. See it appear** (the file watcher needs about a second). Open `http://127.0.0.1:8821/`, project "Lantern",
Build, Planning, "Questions for the owner", or ask the API:

```sh
sleep 2
curl -s "$B/sections/questions/records?status=needs-response&limit=1"
```

The newest question comes first; its summary has `"id":"LNT-Q-010"` and `"question":{"uiState":"needs-response",...}`.

**4. User: submit the answer.** This is what the dashboard form sends. A script can do the same (the
`idempotencyKey` is any 8 to 80 characters of `A-Z a-z 0-9 _ -` that you generate once per attempt):

```sh
curl -s -X POST $H $B/questions/LNT-Q-010/answers -d '{
  "questionRevision": 1,
  "idempotencyKey": "demo-key-0001",
  "answers": [ { "fieldId": "response", "kind": "choice", "optionIds": ["yes"], "explanation": "Drafts should never be lost." } ]
}'
```

```json
{"answerId":"ANS-MWFII1PR-4420D45615F9","processingState":"pending","replayed":false}
```

Sending the same request again returns HTTP 200 with `"replayed":true`. A wrong `questionRevision` returns
`409 stale-revision`; an unknown option returns `422 validation` with `fieldErrors`.

**5. Consumer: list pending answer ids, then fetch one.**

```sh
curl -s "$B/queue?state=pending"
```

```json
{"items":[{"answerId":"ANS-MWFII1PR-4420D45615F9","state":"pending","questionId":"LNT-Q-010","questionRevision":1,"submittedAt":"2026-11-13T21:51:52.623Z"}]}
```

```sh
export A=ANS-MWFII1PR-4420D45615F9     # use the id from your own run
curl -s $B/queue/$A                    # full envelope, processingState "pending"
ls "$DATA/projects/lantern-web-app/communications/answers/pending"    # the same id, as a file
```

**6. Claim it.** Omit `answerId` to take the oldest pending answer instead.

```sh
curl -s -X POST $H $B/queue/claim -d "{\"owner\":\"demo-worker\",\"leaseSeconds\":60,\"answerId\":\"$A\"}"
```

The result is the envelope with `"processingState":"processing"`, `"attempts":1` and a `lease` of
`{owner, claimedAt, expiresAt}`. Claiming the same answer again gives
`{"error":"not-pending","message":"answer ... is not pending"}`; claiming with nothing pending gives HTTP 204.

**7. Complete it** (or fail it, below):

```sh
curl -s -X POST $H $B/queue/$A/complete -d '{"owner":"demo-worker","note":"applied"}'
```

The envelope now has `"processingState":"processed"`, `"result":{"at":"...","note":"applied"}` and an audit trail
`submitted, claimed, processed`. Completing with another owner returns `409 not-owner`; completing twice returns
`409 wrong-state`.

```sh
curl -s "$B/queue?state=processed"
curl -s $B/records/LNT-Q-010          # "question":{"uiState":"processed", ... "answerId":"ANS-..."}
```

In the browser the question now reads Processed. The question file itself is untouched; step 8 is the producer's
choice.

**8. Producer: close the loop.** Edit the question file (still through a temp file and rename), set
`"status": "processed"` and a new `updatedAt`, or raise `questionRevision` to ask again.

**Failure and retry.** Submit an answer to `LNT-Q-003` (free text) and fail it:

```sh
curl -s -X POST $H $B/questions/LNT-Q-003/answers -d '{"questionRevision":1,"idempotencyKey":"demo-key-0002","answers":[{"fieldId":"response","kind":"text","text":"Mention keyboard shortcuts."}]}'
curl -s -X POST $H $B/queue/claim -d '{"owner":"demo-worker"}'                       # attempts 1
export A2=<answerId from the submit response>
curl -s -X POST $H $B/queue/$A2/fail -d '{"owner":"demo-worker","reason":"target repo locked","retryable":true}'
```

The answer returns to `pending` with `"result":{"reason":"target repo locked","retryable":true}`. Claiming again
gives `attempts: 2`. A final failure:

```sh
curl -s -X POST $H $B/queue/$A2/fail -d '{"owner":"demo-worker","reason":"cannot apply","retryable":false}'
curl -s "$B/queue?state=failed"       # lists $A2
curl -s -X POST $H $B/queue/recover -d '{}'     # {"recovered":[]} when no lease has expired
```

**Without the HTTP API.** The same queue on the files:

```sh
npx tsx scripts/queue.ts "$DATA" lantern-web-app list
```

```json
{ "pending": [], "processing": [], "processed": ["ANS-..."], "failed": ["ANS-..."] }
```

**Clean up.** Stop the server with Ctrl+C and delete `$DATA`.
