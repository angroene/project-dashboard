# ADR 0017 — Recurrence: late times, resuming, attachments

**Status:** Accepted · **Date:** 2026-11-15 · Amends ADR 0014

## Context

ADR 0014 creates a day once its local time is reached, and creates missed days only within `catchUpDays`. Three cases
behaved badly:

- With a late time (for example `23:59`) and the default `catchUpDays: 0`, a day was created only if a check happened
  between that time and midnight. With checks every 60 seconds the day could be skipped while the server ran normally.
- Resuming a paused template created the paused days within `catchUpDays`. A user who pauses to skip days (holidays)
  got them afterwards.
- A template record with attachments worked on the first day and failed every day after, because an attachment id
  belongs to one record.

## Decision

- **A day that became due between two checks of a running server is created**, also after midnight and with
  `catchUpDays: 0`. The server remembers when it last checked each project (in memory): if that was yesterday (local),
  yesterday is due. A restart is downtime, so only `catchUpDays` applies after it.
- **Resuming starts from today.** Changing a template to `active` through the API or the card moves its cursor to
  yesterday, so paused or disabled days are not created afterwards; today's occurrence follows the normal rule.
  `catchUpDays` now covers server downtime only. Editing `state` in the file by hand does not move the cursor.
- An occurrence id that differs from an existing record only in letter case is reported on the template and retried,
  never skipped silently (ADR 0015).
- **Template records cannot have attachments** (validation error on the template); shared files go in `links`.
- The card offers Pause, Resume, Disable and Enable.

## Consequences

- No day is lost to the check interval; behaviour after downtime is unchanged.
- The in-memory last-check time is per server process, which ADR 0016 makes the only writer.

## Rejected alternatives

- **Always treat yesterday as due:** a fresh template or a restart with `catchUpDays: 0` would create a day nobody
  saw come due.
- **Persist the last check time:** after downtime it would make every day since the last check look "between two
  checks" and bypass `catchUpDays`.
- **Reject late times:** the time is the user's choice; the scheduler must cope with it.
- **Suffix attachment ids per day:** copies the same file reference into hundreds of records; links do this better.
