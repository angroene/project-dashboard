<!-- Optional section for a project's CLAUDE.md. Paste it only with the project owner's agreement; adjust ids. -->

## Project dashboard

This project reports to an Agents Project Dashboard (`APD_URL`, project `APD_PROJECT`; CLI at `$APD_CLI`).

- Questions for the owner go to the dashboard (skill `dashboard-ask-question`), not into chat. Keep working on
  anything the answer does not block.
- At work boundaries (task finished, before the next task, or when blocked) check for answers once (skill
  `dashboard-process-answers`). Never poll in a loop.
- Report task status, test results, issues and reviews on the dashboard (skills `dashboard-update-progress`,
  `dashboard-report-issue`); keep the chat summary to one or two lines.
- If the dashboard is unreachable, say so in one line, keep working, and run `node "$APD_CLI" flush` later.
