# Dashboard-first communication (optional)

A short instruction section for an agent that **already** reports to an Agents Project Dashboard (the CLI and skills
are installed and `APD_*` is set, see [docs/SKILLS.md](../docs/SKILLS.md)). It moves routine progress from chat to the
dashboard and keeps the chat short, without hiding anything urgent. It is optional; use it only with the project
owner's agreement.

## Where to put it

- Claude Code: the project's `CLAUDE.md`. Codex CLI and other runtimes that read `AGENTS.md`: the project's `AGENTS.md`.
- **Append it as its own section**, after the existing dashboard section (for example the one from
  [`claude-code/CLAUDE.snippet.md`](claude-code/CLAUDE.snippet.md) or [`codex/AGENTS.snippet.md`](codex/AGENTS.snippet.md)).
  Without a dashboard section, install the kit first; this section relies on it.
- Read the file first. Append; never replace or reorder what is there. If a section called "Dashboard-first
  communication" already exists, leave it (or update that one section with the owner's agreement); keep one such
  section per file.
- In a folder that several sessions share, the text below is the same for all of them. Values that differ per session
  (`APD_PROJECT`, `APD_OWNER`, `APD_TOKEN_FILE`) belong in each session's environment, not in this section.

## The section

Copy everything between the lines:

---

```markdown
## Dashboard-first communication

Use the dashboard as the main record of this work; keep chat short.

- When a work item is finished, publish one concise completion update for it: what changed, the result, the
  verification or test outcome, and references (files, commits or change ids, record ids). One update per work item,
  from the session that owns it; subagents and helpers report to that session instead of publishing their own.
- Publish these as they arise, each as its own record type: questions and approvals as questions; things the owner
  must do (actionable blockers) as `requiresAction` records or questions; review findings as reviews; defects and
  test failures as issues with evidence.
- In chat, give a short acknowledgement and a final status of one or two lines that points to the dashboard. Do not
  repeat routine progress in chat.
- Never move these out of chat, whatever the dashboard shows: critical errors, permission or approval prompts of the
  agent runtime, safety warnings, and loss of dashboard connectivity.
- If publishing fails, say so in one visible line, continue, and run `node "$APD_CLI" flush` later to deliver the
  queued calls. Never report something as published that was not delivered.
- Publish only through the installed CLI and skills and the project's configuration. Never write JSON files into the
  dashboard's data folder by hand and never bypass the CLI outbox or the answer queue.
```

---

The section names no model, assistant, domain or version control system; keep it that way when you adapt it.

## Minimal examples

**Claude Code** (verified runtime, see [SKILLS.md](../docs/SKILLS.md#validation)). `CLAUDE.md` after the change:

```markdown
# My project

...existing instructions, unchanged...

## Project dashboard

...the existing dashboard section, unchanged...

## Dashboard-first communication

...the section above...
```

Start a new session (or restart the running one) so the agent reads the updated `CLAUDE.md`.

**Codex CLI** (verified runtime, see [SKILLS.md](../docs/SKILLS.md#codex-and-other-runtimes)). `AGENTS.md` after the
change:

```markdown
## Project dashboard

...the existing section from agent-kit/codex/AGENTS.snippet.md, unchanged...

## Dashboard-first communication

...the section above...
```

Codex reads `AGENTS.md` when a session starts; start a new one.

**Other runtimes** that read a similar instruction file: the same text should work, but this is **unverified**.
Check the first sessions on the dashboard.

## Removing it

Delete the "Dashboard-first communication" section. Nothing else depends on it.
