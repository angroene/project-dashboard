# ADR 0021 — Attention groups and actions

**Status:** Proposed · **Date:** 2026-11-16 · Builds on ADR 0002, ADR 0007, ADR 0008

## Context

The project overview had one "Needs your attention" panel: questions awaiting a response, then every unread record.
With many records it became one long mixed list. The landing page showed every count on every project card, and
"Needs attention" was lit by unread updates too, although those need no action. Users also need a way for an agent to
ask them to *do* something (plug in a device, buy a licence) that is not a question with an answer. The record model
had no such notion.

## Decision

- **`requiresAction`** (boolean, default `false`) on every record type. An action is *outstanding* while a question
  still needs a response, or while any other record's status is not in a `done` or `closed` workflow category. It is
  completed the same way any record changes: by answering the question, or by its owner (an agent) setting a done
  status. No new status, record type or store.
- **Four attention groups**, computed on the server from existing state: Questions (awaiting an answer), Actions
  (outstanding `requiresAction`), Responses (unread questions not awaiting an answer), Updates (other unread records).
  Each pending record is in exactly one group, in that order of precedence, so counts never double up.
- `GET /attention` keeps its old fields and adds `counts` (pending) and `totals` (including history). A new
  `GET /attention/:group?all=1` pages one group with a keyset cursor (pending first, then due date and newest).
- **Show all** is view state only, off whenever the project is opened. It widens a group to answered, completed and
  read history; it never writes anything.
- **Mark selected as read** changes read state only (ADR 0007). It is offered only for unread items, and never
  answers, completes or approves anything. Selection is per group and survives background refreshes; ids that
  disappear from the list drop out of the selection.
- The project card's **`requireAttention`** = questions awaiting a response + outstanding non-question actions.
  Unread updates are informational and are not part of it. A collapsed card shows this count, else published
  progress, else nothing.

## Consequences

- Projects without `requiresAction` records see no Actions items and unchanged counts, except that "require
  attention" no longer includes unread updates.
- Counts are computed per request from the in-memory index (O(records)); fine for the documented sizes
  (docs/PERFORMANCE.md), revisit with an incremental counter if a project grows far beyond them.

## Rejected alternatives

- **A project-level rule that turns record types or statuses into actions** (for example every review in
  "needs-review"): guesses intent, and the same status can mean "waiting for someone else". The producer knows when it
  asks the user to act; a flag on the record says so directly.
- **Actions as a new record type:** an action can be a task, a review or a question; a type would force a choice and
  duplicate workflows.
- **Letting the dashboard user mark an action done:** the producer would not learn about it except through a new
  channel next to the answer queue. A question with `requiresAction` covers "confirm when done" through the queue.
- **Client-side grouping of one big list:** pagination and counts would be wrong for large projects.
