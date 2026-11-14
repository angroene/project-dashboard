---
name: dashboard-process-answers
description: Check the Agents Project Dashboard for answers the owner submitted to your questions, then claim, apply and acknowledge them safely. Use at work boundaries (after finishing a task, before starting the next, or when blocked on a question), never in a polling loop.
---

# Process answers from the dashboard

Answers wait in the dashboard's queue until a consumer claims them. Delivery is at-least-once, so make what you do
with an answer idempotent (key it on `answerId`). `$APD_CLI` is the path to `apd.mjs` (PowerShell: `$env:APD_CLI`).

## When

- After you finish the current task, before you start the next one.
- When you are blocked on a question you asked.
- At session start, if earlier questions may have been answered.

Do not interrupt a task in progress to check, and never poll in a loop. One check is one cheap call.

## Steps

1. List ids only, never the whole inbox:
   `node "$APD_CLI" pending --task <taskId>` (or `--question <id>`, or no filter for the whole project).
   Output: `{"items":[{"answerId","questionId","questionRevision","submittedAt"}]}`. No items: nothing to do.
   `--count` prints just `{"count","more"}`.
2. Claim each answer you will act on now. Pass the same `--owner <stable agent name>` to `claim`, `complete` and
   `fail` (each shell call may be a new process, so a variable set in one call is gone in the next; only the owner
   that claimed an answer may acknowledge it).
   `node "$APD_CLI" claim <answerId> --lease 900 --owner <name>`
   The lease must outlast your work on it; if you stop, the answer returns to pending when the lease expires.
   `{"claimed":false}` or `409 not-pending` means someone else has it: skip it.
3. Read `answer.answers` in the claim output. Files: `node "$APD_CLI" download <attachmentId> --out <path>`.
4. Apply the answer. If it only affects later work, record it with that task and finish your current task first.
5. Acknowledge exactly once:
   - applied: `node "$APD_CLI" complete <answerId> --owner <name> --note "<what you did, one line>"`
   - cannot apply now, maybe later: `node "$APD_CLI" fail <answerId> --owner <name> --reason "<why>" --retry`
   - cannot apply at all, the owner must answer again: `node "$APD_CLI" fail <answerId> --owner <name> --reason "<why>"`
6. Mark the question handled: `node "$APD_CLI" update <questionId> --status processed`
   (or `answered` or `closed`).

## Rules

- Claim only what you will process in this session.
- Never `complete` an answer you did not apply, and never tell the user it is done before `complete` succeeded.
- `complete` returning `409 wrong-state` after a lost connection: run `node "$APD_CLI" status <answerId>`. If it is
  `processed`, it was already acknowledged.
- Exit code 4: the outcome of claim, complete or fail is unknown. Run `status` before anything else.
- Exit code 3: unreachable. Continue other work and check again at the next boundary.
