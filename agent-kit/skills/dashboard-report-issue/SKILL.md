---
name: dashboard-report-issue
description: Publish bugs, test failures and code review findings to the Agents Project Dashboard with severity, reproducibility and evidence files, and keep their status honest (never mark a fix verified without evidence). Use when you find a defect, finish a review, or a test run fails.
---

# Report issues, test results and review findings

`$APD_CLI` is the path to `apd.mjs` (PowerShell: `$env:APD_CLI`).

## Issue or test failure

1. Upload evidence first (logs, screenshots; allowed types are in `capabilities.uploads`):
   `node "$APD_CLI" upload trace.txt screenshot.png` prints `attachments[].attachmentId`.
2. Publish the issue with a stable id derived from the test name or ticket, never from the title:

```sh
node "$APD_CLI" publish --section <issuesSection> --id LNT-ISS-sync-cursor --json '{
  "recordType": "issue",
  "title": "Cursor stays in the discarded copy after a sync conflict",
  "status": "open", "severity": "major", "priority": "high",
  "summary": "Reproducible 3/3 with two offline devices. Fix not started.",
  "bodyMarkdown": "**Steps**\n1. ...\n\n**Expected** ...\n\n**Actual** ...",
  "attachments": [ { "uploadId": "UPL-...", "title": "Repro trace" } ],
  "linkedRecords": ["LNT-TASK-001"]
}'
```

State reproducibility in `summary` ("3/3", "once in 20 runs", "not reproduced"). Statuses come from
`recordTypes.issue` in `capabilities`; a project may define its own.

## Code review

A review is not an issue. Publish one `review` record per review into the section `capabilities` lists for reviews
(`"recordType": "review"`, status such as `changes-requested` or `approved`)
with the findings as a Markdown list in `bodyMarkdown`: severity, file and line, what is wrong. Publish a separate
`issue` for any finding that needs its own follow-up.

## Status honesty

- A fix you wrote but did not verify: `in-testing` or `awaiting-verification`, never `fixed` or `verified`.
- `verified` only with evidence: a passing test name or run, attached or quoted in a `--note`.
- Change status with `node "$APD_CLI" update <ID> --status <s> --note "<evidence>"`.
- Do not close issues you did not open unless your task says so.
- Republishing an issue with the same id keeps the owner's comments, attachments and every tracked field you leave
  out; send `null` for a field to clear it. `--by` names must not start with "user" (`403 reserved-actor`).
