# Onboarding prompt

A prompt you paste into an agent chat **in your own project** to connect that project to an Agents Project Dashboard.
There are two versions: a short one for a quick start and a longer, safer one. Both cover two paths:

1. **Connect to an existing server** (preferred).
2. **Install and run a new server** from Git, only when you ask for it.

What the prompt relies on (so you know what the agent can and cannot do):

- A project is a folder on the server: `<dataRoot>/projects/<folder>/project.json` plus `sections/.../section.json`
  ([PROJECT_FORMAT.md](PROJECT_FORMAT.md)). It can only be created by someone who can write into the server's data
  root (or, with Docker, copy a folder into the data volume), or registered by the operator with
  `extraProjectRoots`. **The HTTP API cannot create projects or sections**; it only publishes records, events and
  progress into projects that exist and have `"publishing": {"enabled": true}`.
- Agents on other machines use the publish API with a scoped token. The token is created by the operator
  (`npm run agent-token`); the server stores only its SHA-256, so a lost token cannot be recovered, only replaced.
- Automatic skill installation is described only for the runtimes that were verified: Claude Code and Codex CLI
  ([SKILLS.md](SKILLS.md)). Any other runtime: the CLI and the Markdown skills work for any agent that can run a shell
  command, but that is unverified.

The expected outputs below were checked against a local server (loopback, `local-network` login mode, a scoped agent
token) with a fictional project; ids and revisions differ on your machine.

## Quick-start version

```text
Connect this project to an Agents Project Dashboard. Follow the dashboard's own docs (README.md,
docs/ONBOARDING_PROMPT.md, docs/SKILLS.md, docs/AGENT_INTEGRATION.md in the dashboard repository) and these rules:

- Ask me for anything you need and do not know: the dashboard URL, the project id and display name, which agent
  runtime this is, where the token file is. Never guess them and never invent defaults.
- Ask before any commit, service installation, network exposure, or deleting anything. Follow this project's own
  Git/VCS policy.
- Never print, echo, paste or commit a token. Tokens live only in a file outside this repository (mode 600).
- Append to CLAUDE.md or AGENTS.md; never overwrite or reorder it.

Steps: (1) check the server answers (GET <url>/api/session); (2) make sure the project folder exists on the server
with publishing enabled (I may need to create it, you cannot via the API); (3) ask me for a scoped agent token file;
(4) install the apd CLI and the four dashboard skills for this runtime as docs/SKILLS.md says; (5) append the
dashboard section to CLAUDE.md or AGENTS.md; (6) run the smoke test from docs/ONBOARDING_PROMPT.md: ask a question,
wait while I answer it in the dashboard, pick it up with apd pending / claim / complete, update progress, report an
issue; (7) tell me what to delete or close afterwards and ask before doing it.
Only if I explicitly ask you to install a new server: follow "Path 2" in docs/ONBOARDING_PROMPT.md.
```

## Expanded safe version

Copy the whole block. Replace nothing in it: the agent asks you for every value.

````text
You are connecting this project to an Agents Project Dashboard: a self-hosted server where agents publish questions,
tasks, issues, reviews and progress, and the owner answers. Work in small, checked steps.

## Rules for the whole task

1. Ask, don't guess. Before you start, ask me for anything essential you do not know:
   - the dashboard URL (for example http://127.0.0.1:8790 or an https address) and, for HTTPS with a self-signed
     certificate, the path of the certificate file;
   - the project id (letters, digits, . _ -), a display name, and whether the project already exists on the server;
   - which agent runtime you are (Claude Code, Codex CLI, or another) and its version;
   - a stable agent name for this session (used as APD_OWNER and shown in record history; it must not start with
     "user");
   - where the token file is or should be (outside this repository).
   If a value is missing, stop that step and ask. Keep working on steps that do not need it.
2. Follow this project's Git/VCS policy. Ask before any commit, push, service installation, firewall or network
   exposure change, or any step that deletes or overwrites files. Never use force options.
3. Secrets: never print, echo, log, paste or commit a token, also not in a test command. Read it only through
   APD_TOKEN_FILE. Keep the token file outside this repository and outside the dashboard's data folder, readable only
   by me (chmod 600 on Linux/macOS; on Windows a folder under my user profile).
4. Instruction files: read CLAUDE.md / AGENTS.md first, then append a new section. Never replace, reorder or reformat
   existing content. If a dashboard section is already there, do not add a second one: show me the difference and ask.
5. This folder may be shared by several agent sessions. Put per-session values (APD_PROJECT, APD_OWNER,
   APD_TOKEN_FILE) in this session's environment, not in shared files, and do not change anything that belongs to
   another session (their sections, token files, outbox folders).
6. Use only the documented means: the apd CLI (agent-kit/cli/apd.mjs), the four skills, the HTTP API, and the files
   the docs describe. Never write records, answers or read state into the server's data folder by hand.
7. Report honestly: show the real command output for every check; if a step fails, say which and why. Never claim a
   step worked when you did not see it work.

## Path 1: connect to an existing server (default)

1. Reach the server. `curl -s <URL>/api/session` must return JSON with "productName". On HTTPS with a self-signed
   certificate use `curl --cacert <cert.pem>` and later run node with NODE_EXTRA_CA_CERTS=<cert.pem>.
2. The project. Projects are folders on the server; the API cannot create them. If the project does not exist yet,
   prepare these files and ask me (or the operator) to place them under <dataRoot>/projects/<project-id>/ on the
   server (with Docker: `docker compose cp <folder> dashboard:/data/projects/<project-id>`):
   - project.json: {"schemaVersion": 1, "id": "<project-id>", "displayName": "<name>",
     "publishing": {"enabled": true}}
   - sections/inbox/section.json: {"schemaVersion": 1, "id": "inbox", "displayType": "expandable-card",
     "title": "Questions", "defaultOpen": true, "actions": ["copy", "open-detail", "respond", "mark-read"]}
   - sections/work/section.json: {"schemaVersion": 1, "id": "work", "displayType": "expandable-card",
     "title": "Work", "actions": ["copy", "open-detail", "comment", "mark-read"]}
   The server picks a new folder up within seconds, without a restart. Check: GET <URL>/api/diagnostics lists no
   entry for this project. (More layouts: docs/PROJECT_FORMAT.md and docs/ITEM_TYPES.md.)
3. The token. Ask the operator for a scoped agent token for this project, created on the server side with
     npm run -s agent-token -- <agent-name> <token-file> --projects <project-id> --scopes read,publish,consume
   The token goes only into <token-file>; the printed JSON entry (name, sha256, projects, scopes) goes into the
   server's agent token file (with Docker: secrets/agent_tokens.json), then the server is restarted
   (`deploy/apd-deploy.sh restart` with Docker). I copy the token file to this machine myself. If the server runs on
   this machine in `local-network` mode, the CLI also works without a token; ask me which I want.
4. Install the CLI and skills for this runtime, as docs/SKILLS.md in the dashboard repository says:
   - Copy agent-kit/cli/apd.mjs to a stable place (for example ~/.local/share/apd/apd.mjs; needs Node 22+).
   - Claude Code: copy the four folders from agent-kit/skills/ into this project's .claude/skills/ (or
     ~/.claude/skills/ for all projects). Do not overwrite a skill that already exists; tell me instead.
   - Codex CLI: copy the four folders into skills/ next to AGENTS.md (the AGENTS.md section uses those paths).
   - Any other runtime: say that installation is unverified for it, copy the skills next to the instruction file,
     and point the instruction file at them.
5. Set this session's environment. Linux/macOS (bash/zsh):
     export APD_CLI=~/.local/share/apd/apd.mjs APD_URL=<URL> APD_PROJECT=<project-id> \
            APD_OWNER=<agent-name> APD_TOKEN_FILE=<token-file>
   Windows PowerShell:
     $env:APD_CLI="$HOME\.local\share\apd\apd.mjs"; $env:APD_URL="<URL>"; $env:APD_PROJECT="<project-id>"
     $env:APD_OWNER="<agent-name>"; $env:APD_TOKEN_FILE="<token-file>"
   Ask me where these should be set permanently (shell profile, the runtime's settings, a launcher script); do not
   edit those files without asking.
6. Append the dashboard section to the instruction file: agent-kit/claude-code/CLAUDE.snippet.md for Claude Code,
   agent-kit/codex/AGENTS.snippet.md for Codex CLI (rule 4). Optional, only if I agree:
   agent-kit/DASHBOARD_FIRST.md as a further section after it.
7. Smoke test. Run each command, show me its output, and compare it with the expected line. Use ids that cannot
   clash with real work (here <P> is a short prefix I agree to, for example SMOKE).
   a. node "$APD_CLI" capabilities
      expect one JSON line with "apiVersion":1, your project id, "caller":{"kind":"agent","name":"<agent-name>",...}
      and "publishing":{"enabled":true,"sections":[...]} listing inbox and work.
   b. node "$APD_CLI" ask --section inbox --id <P>-Q-001 --json '{"title":"Smoke test: pick one","answerSchema":{"type":"single-choice","options":[{"id":"a","label":"Option A"},{"id":"b","label":"Option B"}]}}'
      expect {"recordId":"<P>-Q-001","sectionId":"inbox","revision":"...","created":true,"unchanged":false}
      (PowerShell: put the JSON in a file and use --file <file> instead of --json.)
   c. node "$APD_CLI" attention      expect "questions":1 (or one more than before)
   d. Ask me to open the dashboard, find "Smoke test: pick one" in the Questions card, choose an option and press
      Submit. It then shows as submitted and awaiting pickup. Wait for my confirmation; do not answer it yourself.
   e. node "$APD_CLI" pending
      expect {"items":[{"answerId":"ANS-...","state":"pending","questionId":"<P>-Q-001",...}]}
   f. node "$APD_CLI" claim <answerId> --lease 300
      expect {"claimed":true,"answer":{... "answers":[{"fieldId":"response","kind":"choice","optionIds":["a"]}] ...}}
   g. node "$APD_CLI" complete <answerId> --note "Smoke test applied"
      expect the answer with "processingState":"processed"
   h. node "$APD_CLI" update <P>-Q-001 --status processed --note "Smoke test done" --by <agent-name>
      expect {"recordId":"<P>-Q-001",...,"unchanged":false}
   i. node "$APD_CLI" publish --section work --id <P>-T-001 --json '{"recordType":"task","title":"Smoke test task","status":"in-progress","percent":10}'
      then node "$APD_CLI" update <P>-T-001 --percent 50 --note "Halfway" --by <agent-name>
      and  node "$APD_CLI" progress --percent 25 --label "Smoke test"
      expect "created":true, then "unchanged":false, then {"revision":"...","unchanged":false}
   j. node "$APD_CLI" publish --section work --id <P>-I-001 --json '{"recordType":"issue","title":"Smoke test issue","status":"open","severity":"minor"}'
      expect "created":true
   k. node "$APD_CLI" pending --count      expect {"count":0,"more":false}
   Ask me to confirm in the dashboard that the question shows as processed, the task at 50 %, the progress at 25 %
   and the issue in the Work card.
8. Clean up. The API cannot delete records. Propose, and do only after I agree: close the test records
   (update <P>-T-001 --status cancelled, update <P>-I-001 --status wont-fix, update <P>-Q-001 --status closed), or
   ask the operator to delete their files from the project's sections/*/records/ folders on the server. Answers stay
   in the queue's processed/ folder as an audit trail. Overall progress: set the real value, or
   `progress --percent none` for "Not reported".
9. Future sessions. Skills and instruction files are read when a session starts: tell me to start a new session (or
   restart this one). At the start of each new session, first run `node "$APD_CLI" pending` so no answer that
   arrived in between is missed; answers wait safely in the queue until a consumer completes them.

## Path 2: install and run a new server (only when I explicitly ask)

Do not start this path unless I asked for a new server. Ask me first, and do not choose for me:
- where to put the code, and where the data root goes (outside the code folder and outside this repository);
- clean start (empty data root with a projects/ folder) or demo start (a copy of the dashboard's examples/ folder);
- login mode: `required` (default; a token file), `local-network` (no login only for address ranges I name, for
  example 127.0.0.1/32,::1/128 for this machine), or `disabled` (not recommended);
- port (default 8790) and bind address (default 127.0.0.1 = this machine only; anything else needs a token and HTTPS
  and is a network exposure: ask);
- Node or Docker. Docker uses deploy/apd-deploy.sh on Linux and macOS (Windows: WSL or Docker Desktop with bash,
  untested).

Node (all platforms):
  git clone <repository-url> agents-project-dashboard && cd agents-project-dashboard
  npm ci && npm run build
  clean start:  mkdir -p <dataRoot>/projects        (PowerShell: New-Item -ItemType Directory -Force <dataRoot>\projects)
  demo start:   cp -r examples <dataRoot>            (PowerShell: Copy-Item -Recurse examples <dataRoot>)
  Linux/macOS:  PCC_DATA_ROOT=<dataRoot> PCC_WEB_ROOT=dist/web PCC_PORT=<port> \
                PCC_AUTH_MODE=local-network PCC_TRUSTED_NETWORKS=127.0.0.1/32,::1/128 npm start
  PowerShell:   $env:PCC_DATA_ROOT="<dataRoot>"; $env:PCC_WEB_ROOT="dist/web"; $env:PCC_PORT="<port>"
                $env:PCC_AUTH_MODE="local-network"; $env:PCC_TRUSTED_NETWORKS="127.0.0.1/32,::1/128"; npm start
  For `required` mode use PCC_AUTH_TOKEN_FILE=<token file> instead of the two local-network settings (create the
  token as docs/DEPLOYMENT.md "Authentication token" shows). For agent tokens add
  PCC_AGENT_TOKENS_FILE=<agent token list> ({"schemaVersion": 1, "tokens": []} to start with).
  Check: curl -s http://127.0.0.1:<port>/api/projects returns {"productName":...,"projects":[]...} on a clean start;
  /api/diagnostics returns "diagnostics":[]. Never point PCC_DATA_ROOT at the checked-in examples/ folder.
  Ask before making it a service (systemd, launchd, a Windows task); docs/DEPLOYMENT.md has examples.

Docker (Linux/macOS):
  deploy/apd-deploy.sh up            clean start, or: deploy/apd-deploy.sh up --demo  (adds the missing examples)
  deploy/apd-deploy.sh health --auth
  The script creates the operator token, an empty agent token list (secrets/agent_tokens.json) and a self-signed
  certificate, and publishes on 127.0.0.1 only. Changing PCC_BIND exposes it to the network: ask first.

Then continue with Path 1.

## Troubleshooting

- apd exit 2 / "usage or local configuration error": APD_PROJECT or APD_TOKEN_FILE missing or unreadable.
- exit 3 "server unreachable ... queued for 'apd flush'": wrong URL or server down. The call is in the outbox; run
  `node "$APD_CLI" flush` once the server is back. Say so in one line; do not retry in a loop.
- 401 unauthorized: the token is not in the server's agent token list, or the server was not restarted after it was
  added.
- 404 for the project: the project folder is missing or invalid (see /api/diagnostics), or the token is not scoped
  to this project.
- 403 publishing-disabled: project.json lacks "publishing": {"enabled": true}. 403 section-not-allowed: the card is
  not in publishing.sections. 422 not-a-card: the section id is a tab, not a card.
- Self-signed HTTPS errors: set NODE_EXTRA_CA_CERTS=<cert.pem> for node.
- More: docs/GETTING_STARTED.md (Troubleshooting) and docs/AGENT_INTEGRATION.md.

## Rollback

Ask before each step: remove the appended section(s) from CLAUDE.md / AGENTS.md; remove the copied skill folders and
apd.mjs; delete the local token file and ask the operator to remove its entry from the agent token list and restart;
delete the local .apd-outbox folder after `apd outbox` shows it empty; ask the operator whether to remove the project
folder from the server (this deletes its records and answers). For Path 2: stop the server (Ctrl+C, or
`deploy/apd-deploy.sh down`); the data root or volume stays until I decide to delete it.
````

## Notes for the developer

- The prompt deliberately makes the agent stop and ask. A run that never asks you anything is a sign it guessed.
- Agent tokens are always checked, in every login mode. In `local-network` mode a client inside the trusted ranges
  has full access without a token, so a token only restricts agents outside those ranges
  ([DEPLOYMENT.md](DEPLOYMENT.md#login-modes)).
- `npm run -s agent-token` (with `-s`) keeps npm's own banner off stdout, so the printed entry is plain JSON.
