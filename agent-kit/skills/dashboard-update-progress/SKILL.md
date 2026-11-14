---
name: dashboard-update-progress
description: Report task status, percent complete, milestones and short activity entries to the Agents Project Dashboard instead of long chat narration. Use when a task starts, is blocked, changes phase or finishes, and when the project's published progress changes.
---

# Report progress to the dashboard

The dashboard shows what the project publishes and never computes progress itself. Publish facts, not estimates
dressed up as measurements. `$APD_CLI` is the path to `apd.mjs` (PowerShell: `$env:APD_CLI`).

## Task records

- New task, published once with a stable id:
  `node "$APD_CLI" publish --section <tasksSection> --id <ID> --json '{"recordType":"task","title":"...","status":"planned"}'`
- Status changes with a short note (one call; a retried call does not duplicate the note):
  `node "$APD_CLI" update <ID> --status in-progress --percent 40 --note "Parser done; wiring the UI" --by <agent-name>`
- Blocked: `--status blocked --note "Waiting on question LNT-Q-042"`.
- Statuses must be in the project's workflow: see `recordTypes.task` in `node "$APD_CLI" capabilities`.
- Use `--percent` only when it reflects something countable (checklist items, tests). Otherwise leave it out.

## Activity events

One line per notable event (build, test run, merge, release). Ids must be unique and stable, for example
`<task>-EV-<n>`:

```sh
node "$APD_CLI" event LNT-EV-118 --action test --summary "41 passed, 1 failed (sync.cursor)" --status warning --record LNT-TASK-001
```

Events are immutable: the same id with different content is rejected (`409 id-conflict`).

## Project progress

Only when the project's own measure changes:
`node "$APD_CLI" progress --percent 62 --label "Release 1.0 readiness" --method "Share of checklist items done"`,
or `--file progress.json` with a `breakdown`.

## Keep chat short

After publishing, one chat line is enough ("Updated LNT-TASK-001: in testing, 85%"). Report a failed dashboard call
plainly. Exit code 3 means unreachable: the update is queued; run `node "$APD_CLI" flush` later.
