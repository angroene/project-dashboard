---
name: dashboard-ask-question
description: Publish a question for the project owner on the Agents Project Dashboard (choice, free text, approval or file upload) when a decision blocks or shapes your work, then continue with unblocked work. Use instead of asking in chat when the project has a dashboard configured (APD_URL and APD_PROJECT set).
---

# Ask the owner a question on the dashboard

Use when you need a decision, approval, missing information or a file from the owner and the project uses the
Agents Project Dashboard. The owner answers in the dashboard (or in Excel); you pick the answer up later with the
`dashboard-process-answers` skill. Do not wait idle for it.

`$APD_CLI` is the path to `apd.mjs` (PowerShell: `$env:APD_CLI`).

## Before asking

1. Once per session: `node "$APD_CLI" capabilities`. It lists the sections you may publish into
   (`publishing.sections`), the answer types and the upload limits. Exit code 3 means the dashboard is unreachable:
   ask in chat instead (one short message) and say the dashboard was offline.
2. Pick the section from `publishing.sections` whose title fits questions. Never guess a folder path.
3. Pick a stable id derived from the work, for example `<PREFIX>-Q-<task>-<n>`. Publishing the same id again updates
   the question; never reuse an id for a different question. An id that differs from an existing one only in letter
   case is refused (`409 id-conflict`).

## Write the question

It must be answerable without reading your chat:

- `title`: the question itself, one sentence.
- `summary`: one or two lines of context. Longer context goes in `bodyMarkdown` (Markdown, no HTML).
- `taskId`: the task record the question belongs to, if any. It lets you find the answer by task later.
- `answerSchema`, the narrowest type that fits:
  - `single-choice` or `multiple-choice` with `options` `[{id, label, description?}]`; add `allowOther` or
    `allowExplanation` when useful. Put your recommendation first and say so in its `description`.
  - `free-text` (`maxLength`), `approval` (approve or reject, `requireRationaleOnReject`),
    `file-upload` (`allowedMimeTypes`, `maxFiles`), or `composite` with several `fields`.
- `default` (optional) in `single-choice`, `multiple-choice`, `free-text` or `approval`: pre-selected in the form and
  labelled as a suggestion. It must be a valid answer. It is never an answer by itself: nothing reaches the queue until
  the owner submits, so never act on a default.
- `dueAt` (ISO time with offset) only for a real deadline. `notifyUser: true` flags it as an update.

```sh
node "$APD_CLI" ask --section <sectionId> --id LNT-Q-042 --json '{
  "title": "Which conflict rule should sync use?",
  "summary": "Two devices edited the same note offline.",
  "taskId": "LNT-TASK-001",
  "answerSchema": { "type": "single-choice",
    "options": [ { "id": "keep-both", "label": "Keep both copies", "description": "Recommended: no data loss" },
                 { "id": "last-write", "label": "Last write wins" } ],
    "allowExplanation": true }
}'
```

For long JSON write a file and pass `--file q.json`. Success prints `{"recordId","revision","created"}`.

## After asking

- Note the question id with your current task, then continue with work that does not depend on the answer.
- If all remaining work is blocked, say so in one short chat line naming the question id.
- To change an already answered question, raise `questionRevision`. The server refuses a changed `answerSchema` on
  an answered revision (`409 revision-required`).
- Republishing the same id keeps the owner's comments and attachments, and every tracked field you leave out; send
  `null` for a field to clear it.

## Errors

- Exit 1: the server rejected the call; stderr has the reason (for example `422 validation` with `fieldErrors`).
  Fix the input and retry.
- Exit 3: unreachable. The CLI queued the call in its outbox; run `node "$APD_CLI" flush` later.

Reference: `docs/AGENT_INTEGRATION.md` in the dashboard repository.
