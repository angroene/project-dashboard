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
  every tracked field you leave out. To clear a field, name it with `null` (`"fields": {"checks": null}`), or use
  `update --field checks=none`, which sends `null`. Leaving a field out never clears it.
- `--by` names (and your token's name) must be printable ASCII and must not start with "user" in any case or
  spelling (`user-bot`, `User2`, `u.s.e.r`): that name is the dashboard owner's. The server refuses them with
  `403 reserved-actor`; pick a name such as your agent's name.
- Recurring records are created by the server (`node "$APD_CLI" templates` lists them); do not publish daily copies
  yourself.
- **Daily Yes / No settings** (a card with a `yes-no` field and a template): read today's value with
  `node "$APD_CLI" daily <templateId> --field <fieldId>` → `{"date","field","value":true,"label":"yes"}`. It is the template's
  default until the owner taps the other answer, and it resets at the template's time. Read it when you need it (at
  a work boundary); never compute the date or open record files yourself. It is not an answer: nothing to claim.

## Ask the owner to do something

When the owner must act (connect a device, approve a purchase outside the dashboard), publish or mark the record
with `requiresAction`: it then appears under **Actions** until it is done.

```sh
node "$APD_CLI" update <ID> --action true --note "Needs the test device connected" --by <agent-name>
node "$APD_CLI" update <ID> --status done --note "Device seen online" --by <agent-name>   # completes the action
```

Marking it read does not complete it. If you need the owner to confirm, ask a question with `"requiresAction": true`
instead (skill `dashboard-ask-question`); answering it completes the action.

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
