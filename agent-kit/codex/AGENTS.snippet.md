<!-- Optional section for a project's AGENTS.md (Codex and other runtimes that read AGENTS.md).
     Run in Codex CLI 0.159 (see docs/SKILLS.md). Paths below are relative to this file: copy the skills next to it.
     Paste it only with the project owner's agreement. -->

## Project dashboard

This project reports to an Agents Project Dashboard. The CLI is `node "$APD_CLI"`; `APD_URL`, `APD_PROJECT`,
`APD_OWNER` and, for token-mode servers, `APD_TOKEN_FILE` are set in the environment. Never put the token on a command
line or in a file in the repository.

Read the matching instruction file before acting (paths relative to where the agent kit was copied):

| When | Read and follow |
|---|---|
| You need a decision, approval, information or a file from the owner | `skills/dashboard-ask-question/SKILL.md` |
| You finished a task, are about to start one, or are blocked on a question | `skills/dashboard-process-answers/SKILL.md` |
| A task starts, changes phase, is blocked or finishes | `skills/dashboard-update-progress/SKILL.md` |
| You found a defect, a test run failed, or you finished a review | `skills/dashboard-report-issue/SKILL.md` |

Rules: check for answers only at work boundaries, never in a loop; never acknowledge an answer you did not apply;
never mark a fix verified without evidence; if the dashboard is unreachable, say so in one line and continue.
