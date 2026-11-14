# ADR 0014 — Recurring records from templates

**Status:** Accepted · **Date:** 2026-11-14 · Extends ADR 0002

## Context

Some cards need a new record every day (a check-in question, a daily review). Without server support an agent must be
running at the right time in the right time zone, and two agents or a restart can create duplicates or gaps.

## Decision

- A card's `templates/<id>.json` holds a template: `state` (`active`, `paused`, `disabled`), a `daily` schedule with
  local `time`, IANA `timezone`, `startDate`, optional `endDate` and `catchUpDays` (0–31), and the `record` each day
  starts from. Only daily recurrence is supported; the schema has a `frequency` field so other frequencies can be added
  without changing existing files.
- Each occurrence is an ordinary record in the same card with id `<template id>-<YYYY-MM-DD>` (local date) and
  `occurrence: {templateId, date}`. Nothing else in the system treats occurrences differently.
- A day is due once the local wall-clock time in the template's time zone reaches `time`. Comparing local dates and
  times (not adding 24 hours) makes daylight-saving days behave predictably: a skipped time is reached when the clock
  jumps past it, a repeated time on its first occurrence; either way the date's id is created once.
- **Exactly once:** the record is written to a temp file and hard-linked into place, which fails if the file exists
  (also across processes and servers sharing the data). Runs are serialised with the project's publish lock. A cursor
  per template (last handled date, `user-state/.recurrence.json`, ignored by the watcher) keeps deleted occurrences
  from coming back. When hard links are not available, exclusive create (`O_EXCL`) is the fallback.
- **Missed days:** only days within `catchUpDays` before today are created after downtime or a pause; older ones are
  skipped. This bounds the burst after long downtime and makes the result independent of how long the server was off.
- Each occurrence is validated like a published record before it is written; a failing day is reported on the template
  and retried next time; the cursor does not move past it.
- The scheduler runs at start-up and every `recurrenceSeconds` (default 60; 0 = off) inside the server; no agent,
  cron job or external service is needed. Pause and resume rewrite the template's `state` (operator only).
- Defaults in the template's answer schema are shown, never answered (ADR 0011).

## Consequences

- One record file per day per template; history is the set of occurrence files, which the scheduler never edits.
- A template edit applies to future occurrences only.
- Occurrence ids are tied to the template id: renaming a template starts a new series.

## Rejected alternatives

- **Cron expressions**: far more surface (and edge cases) than "daily at a local time"; no requirement for more yet.
- **Lazy creation when someone opens the card**: records would not exist for agents or counts until someone looked.
- **Creating all missed days since `startDate`**: an old template or long downtime would create hundreds of records.
- **A database or lock server for exactly-once**: the dashboard is file-based; atomic exclusive file creation gives
  the same guarantee for one data folder.
- **Scheduling in UTC offsets**: a fixed offset shifts the local time twice a year.
