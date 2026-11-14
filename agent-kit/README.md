# Agent kit

Tools for connecting coding agents and scripts to an Agents Project Dashboard.

| Path | What |
|---|---|
| [`cli/apd.mjs`](cli/apd.mjs) | Single-file CLI (Node 22+, no dependencies): discover, publish, upload, list pending answers, claim, complete, fail, offline outbox |
| [`skills/`](skills/) | Four portable skills: ask a question, process answers, update progress, report issues |
| [`claude-code/`](claude-code/) | Optional `CLAUDE.md` section and a session-start hook example |
| [`codex/`](codex/) | Optional `AGENTS.md` section (not validated in Codex) |
| [`examples/`](examples/) | JSON inputs for `apd ask/publish/progress --file` |

Quick check against a local server started from the examples (`docs/GETTING_STARTED.md`):

```sh
export APD_CLI=$PWD/agent-kit/cli/apd.mjs APD_URL=http://127.0.0.1:8790 APD_PROJECT=lantern-web-app
node "$APD_CLI" capabilities
node "$APD_CLI" ask --section questions --id LNT-Q-100 --file agent-kit/examples/question-choice.json
node "$APD_CLI" pending --task LNT-TASK-001
```

Documentation: [docs/AGENT_INTEGRATION.md](../docs/AGENT_INTEGRATION.md) (API, CLI, auth, queue, offline behaviour)
and [docs/SKILLS.md](../docs/SKILLS.md) (catalogue, installation, limits).
