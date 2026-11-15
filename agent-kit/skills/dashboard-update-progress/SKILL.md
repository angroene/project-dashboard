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

## Find and update tracked records

Cards can define tracked fields (for example "Reviewed", "Decision", "Checks passed") and records can reference work in
another system. Find records with a server-side filter instead of reading files:

```sh
node "$APD_CLI" list --section reviews --field checks=false --limit 20
node "$APD_CLI" update LNT-REV-001 --field checks=true --if-revision <revision> --by <agent-name>
node "$APD_CLI" update LNT-REV-001 --external refs.json   # [{"system":"code review","id":"PR-17","status":"merged",...}]
```

- `list` shows each field's `editableBy` (in `fieldDefs`). Fields only the owner may change are refused
  (`403 field-not-editable`); never try to set the owner's "Reviewed" or "Decision" for them.
- `--field id=none` clears a value. `--if-revision` (the `revision` from `node "$APD_CLI" source <ID>`) refuses the write if someone changed
  the record meanwhile (`409 revision-mismatch`): re-read, then decide.
- An external reference's `status` is what that system reported, kept apart from the dashboard's own fields. Set it
  only from the source system, never from a dashboard field.
- Prefer `update` for changes. Republishing a whole record (`publish`) keeps the owner's comments, attachments and
  every field you leave out; it can never write history or attachments as `user`. `--by` names must be printable
  ASCII and must not start with "user".
- Recurring records are created by the server (`node "$APD_CLI" templates` lists them); do not publish daily copies
  yourself.

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
