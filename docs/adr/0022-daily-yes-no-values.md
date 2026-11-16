# ADR 0022 — Daily Yes / No values

**Status:** Proposed · **Date:** 2026-11-16 · Builds on ADR 0011, ADR 0012, ADR 0014, ADR 0017

## Context

Some projects need a daily yes/no setting from the user that agents follow, for example "Available tonight?". The
user wants a default that is in effect without doing anything, one tap to change today's value, and a fresh default
the next day. Recurring questions (ADR 0014) cannot do this: their defaults are shown, never answered (ADR 0011), so
an untouched day has no answer, and agents would have to treat "no answer" as the default themselves.

## Decision

- A **`yes-no` tracked field type** (ADR 0012): stored as `true`/`false`, shown as two toggle buttons that save on tap,
  in the record detail and on the record row. The configured default is the template's `record.fields` value, so each
  day's record starts with it. A tap is an ordinary user field update: one record, history entry, revision.
- The daily reset is the template's `schedule.time` in its `timezone`, through the existing scheduler. No second
  scheduler, timer or store.
- **`GET /templates/:templateId/current`** (agent `read` scope) returns the current day's date, record id and field
  values. The current day is today once the template time has passed, else yesterday (the rule `dueDates` uses). If
  that day's record does not exist yet, the values are the template's defaults. Agents therefore read the right value
  from exactly the reset time, also when the scheduler has not run yet (start-up, interval, paused template), without
  telling defaults from explicit choices. `apd daily <template> --field <id>` wraps it.
- Opt-in: nothing changes for recurring questions, which keep ADR 0011 semantics.

## Consequences

- History is the set of daily records; earlier days are never rewritten. Changing the default affects new days only.
- The user's choice is not in the answer queue. Agents read it when they need it; there is nothing to claim.
- A paused template reports its default for the current day. Pausing is "stop creating records", not "no value".

## Rejected alternatives

- **Auto-submitting a question's default at the reset time:** makes decisions for the user in the queue, which
  ADR 0011 rejects, and needs a second writer.
- **A per-card "current value" stored outside records:** a second store with its own history and concurrency rules.
- **Computing the value in the agent** (find today's file, fall back to the template): every agent would reimplement
  time-zone and DST rules, and scan folders.
- **A `checkbox` with a different look:** "unchecked" reads as "not set", not as "No"; a separate type makes the two
  answers explicit in the UI, the API labels (`yes`/`no`) and filters.
