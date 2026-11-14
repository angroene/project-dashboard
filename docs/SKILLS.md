# Agent skills

Four portable skills in [`agent-kit/skills/`](../agent-kit/skills/) tell a coding agent **when and why** to use the
dashboard. The deterministic work (validation, writes, queue claims, retries, offline queueing) is done by the server
and the `apd` CLI ([AGENT_INTEGRATION.md](AGENT_INTEGRATION.md)), not by the skills.

| Skill | Triggers on | Does |
|---|---|---|
| [`dashboard-ask-question`](../agent-kit/skills/dashboard-ask-question/SKILL.md) | a decision, approval, missing information or file needed from the owner | publishes a question with the narrowest answer type, links it to the task, continues unblocked work |
| [`dashboard-process-answers`](../agent-kit/skills/dashboard-process-answers/SKILL.md) | a work boundary (task finished, next task, blocked) | lists pending answer ids, claims, applies, completes or fails, marks the question handled |
| [`dashboard-update-progress`](../agent-kit/skills/dashboard-update-progress/SKILL.md) | a task starts, is blocked, changes phase or finishes; project progress changes | updates task status, percent and notes, publishes events and project progress |
| [`dashboard-report-issue`](../agent-kit/skills/dashboard-report-issue/SKILL.md) | a defect, a failing test run, a finished review | uploads evidence, publishes issues and reviews with severity and reproducibility, keeps statuses honest |

Each skill is a `SKILL.md` with a short `name` and `description` (the only part an agent runtime loads up front) and
instructions that load when the skill is used. They contain no project names, paths or tokens.

## Install for Claude Code

Nothing is installed automatically, and nothing here edits an existing `CLAUDE.md`, settings file, hook or skill.
Apply these steps only in a project whose owner agreed to it.

1. Copy the CLI somewhere stable, e.g. `~/.local/share/apd/apd.mjs` (one file, Node 22+).
2. Copy the four skill folders into the project's `.claude/skills/` (this project only) or `~/.claude/skills/`
   (all your projects). Skills with the same name already there are not overwritten by this step if you copy with
   `cp -rn` (POSIX) or check first.
3. Provide the environment to the agent session, e.g. in the shell that starts Claude Code:

   ```sh
   export APD_CLI=~/.local/share/apd/apd.mjs
   export APD_URL=http://127.0.0.1:8790      # or your HTTPS address
   export APD_PROJECT=<project id>
   export APD_OWNER=<stable agent name>
   export APD_TOKEN_FILE=<token file>        # token-mode servers only
   ```

4. Allow the CLI in the permission prompt when first asked, or add `Bash(node:*)` (or a narrower pattern) yourself.
5. Optional: paste [`agent-kit/claude-code/CLAUDE.snippet.md`](../agent-kit/claude-code/CLAUDE.snippet.md) into the
   project's `CLAUDE.md` to say when the dashboard should be used instead of chat.
6. Optional: a session-start hint. [`agent-kit/claude-code/settings.hook.example.json`](../agent-kit/claude-code/settings.hook.example.json)
   runs `apd hint` when a session starts; it prints one sentence only when answers are waiting and nothing otherwise,
   never fails the session and never loops. Merge it into your settings by hand.

## Codex and other runtimes

The skills are plain Markdown and the CLI is plain Node, so any agent that can run a shell command can use them.
[`agent-kit/codex/AGENTS.snippet.md`](../agent-kit/codex/AGENTS.snippet.md) is an `AGENTS.md` section for Codex-style
runtimes that read `AGENTS.md`; it points the agent at the same skill files and CLI. Its paths (`skills/...`) are
relative to the folder holding `AGENTS.md`: copy the four skill folders into a `skills/` folder next to it, or edit
the paths.

Codex on Windows: with `-s workspace-write` and the default (elevated) Windows sandbox, every shell command failed in a
non-interactive run because the sandbox helper needs an elevation prompt. `-c 'windows.sandbox="unelevated"'` with
`-s workspace-write` worked: Node ran and reached a loopback dashboard without extra network settings. Do not use
`--dangerously-bypass-approvals-and-sandbox` for this.

## What the skills do not do

- They do not run a background poller and cannot push a message into a running session. The agent checks the queue
  at work boundaries; the optional hook only adds a hint at session start.
- They do not decide project policy (who approves what, which statuses mean done, chat verbosity). Those belong to the
  project's own instructions.
- They never mark a fix verified without evidence, and never acknowledge an answer that was not applied.

## Validation

- The CLI, the server endpoints and the full agent loop are covered by automated tests (`test/cli.test.ts`,
  `test/agent-api.test.ts`) and by `npm run demo:agent`.
- All four skills were run in real agent sessions against a loopback dashboard with a token-mode server, a scoped
  agent token and the example data, each from a plain task description (the skill was not named):
  - Claude Code 2.1.325 (`claude -p --model haiku`, tools limited to `Bash(node:*)`, `Read`, `Skill`): it selected each
    skill itself. It asked a question linked to a task; claimed, applied and completed the answer and set the question
    to `processed`; updated a task (status, percent, note), published an activity event and project progress; and
    reported issues with an uploaded log file.
  - Codex CLI 0.159.2 (`codex exec`, default model, `-s workspace-write`, unelevated Windows sandbox, the
    `AGENTS.md` section): the same four workflows, plus a review record with status `changes-requested`.
  - Every result was checked through the API and in the browser.
- Agent behaviour seen in those runs: one Claude Code run published a review finding as an issue instead of a review
  record, and one run passed `--owner` to `claim` but not to `complete` (the server refused the acknowledgement until
  it was retried with the owner; the skill now says to pass `--owner` on every queue call). Models differ; check the
  first runs in a new project.
- The session-start hook example was run the same way: with one answer pending, the hint sentence appeared in the
  session context; with the server unreachable, the session started normally and the context had no hint.

## Examples

Ready-to-edit JSON for `--file`: [`agent-kit/examples/`](../agent-kit/examples/) (choice, approval and file-upload
questions, an issue with evidence, a review, progress with a breakdown).
