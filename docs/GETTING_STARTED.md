# Getting started

From a clean clone to a running dashboard with a working project, then your own project.

## Prerequisites

- Node.js 22 or newer (developed on Node 24) and npm 10 or newer. Nothing else: no database, no external services.
- A modern browser. Only a Chromium-based browser (headless Edge) is used for the automated end-to-end walk.
- Optional: Docker, see [DEPLOYMENT.md](DEPLOYMENT.md) (verified on linux/arm64).

## 1. Install, build, run the examples

```sh
git clone <repository-url> agents-project-dashboard
cd agents-project-dashboard
npm ci
npm run build                          # UI to dist/web, server to dist/server
cp -r examples demo-data               # the server writes into its data root: always use a copy
# login-free for this machine only; without these two settings a token file is required (see DEPLOYMENT.md)
PCC_DATA_ROOT=demo-data PCC_WEB_ROOT=dist/web \
PCC_AUTH_MODE=local-network PCC_TRUSTED_NETWORKS=127.0.0.1/32,::1/128 npm start
```

PowerShell:

```powershell
npm ci; npm run build
Copy-Item -Recurse examples demo-data
$env:PCC_DATA_ROOT = "demo-data"; $env:PCC_WEB_ROOT = "dist/web"
$env:PCC_AUTH_MODE = "local-network"; $env:PCC_TRUSTED_NETWORKS = "127.0.0.1/32,::1/128"; npm start
```

Open **http://127.0.0.1:8790**. You should see two projects, "Lantern (example web app)" and "Tidepool Survey (example
research notebook)", with no diagnostics. Both are fictional and use different layouts, see
[examples/README.md](../examples/README.md).

The server listens on `127.0.0.1` only and needs no login in this mode. Stop it with Ctrl+C.

Check it from a second terminal:

```sh
curl -s http://127.0.0.1:8790/api/projects        # two project cards
curl -s http://127.0.0.1:8790/api/diagnostics     # "diagnostics":[]
```

(`npm ci` and `npm start` on a fresh clone are the documented path; the build and server commands were run against
the working tree while writing these docs.)

## 2. Try the full loop

[QUEUE.md](QUEUE.md#walkthrough-write-a-question-answer-it-consume-the-answer) walks through writing a question file,
answering it, and claiming the answer as a consumer, with every command and its output. Reading it first takes five
minutes and explains the whole model.

## 3. Create your own project

1. Pick a data root, for example `/srv/dashboard-data`, and create `projects/` inside it.
2. Create a project folder, for example `projects/my-app/`, with `project.json`:

   ```json
   { "schemaVersion": 1, "id": "my-app", "displayName": "My App" }
   ```

3. Add a section. The simplest layout is cards directly at the root. Create
   `projects/my-app/sections/inbox/section.json`:

   ```json
   {
     "schemaVersion": 1,
     "id": "inbox",
     "displayType": "expandable-card",
     "title": "Inbox",
     "defaultOpen": true,
     "actions": ["copy", "open-detail", "respond", "mark-read"]
   }
   ```

4. Add a record, `projects/my-app/sections/inbox/records/APP-TASK-001.json`:

   ```json
   {
     "schemaVersion": 1,
     "id": "APP-TASK-001",
     "recordType": "task",
     "title": "Write the first record",
     "status": "planned",
     "updatedAt": "2026-11-13T09:00:00Z"
   }
   ```

5. Start the server with `PCC_DATA_ROOT` pointing at your data root. A running server picks up new projects and files
   within about a second, with no restart. Mistakes are listed on the **Diagnostics** page and in
   `GET /api/diagnostics`; they affect only the file that is wrong.

Next: [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for tabs, nesting, progress, workflows and all record fields.
Keep your project data outside this repository.

## Development

```sh
npm run dev:server      # API with auto-restart on 127.0.0.1:8790 (set PCC_DATA_ROOT, and a login mode such as
                        # PCC_AUTH_MODE=local-network PCC_TRUSTED_NETWORKS=127.0.0.1/32,::1/128)
npm run dev:web         # Vite dev server on http://127.0.0.1:5173, proxies /api to the API
```

## Tests and quality checks

| Command | What it runs |
|---|---|
| `npm test` | All Vitest tests: backend integration tests and web unit tests |
| `npm run test:unit` | Web component tests (jsdom) and pure shared logic |
| `npm run test:integration` | Backend tests against real temporary folders: discovery, validation, paths and symlinks, queue, uploads, ZIP, Excel, auth, TLS |
| `npm run test:e2e` | Builds the UI and drives the real app in a headless Chromium-based browser (Edge by default; Chrome or another Chromium via `E2E_BROWSER_CHANNEL` / `E2E_BROWSER_PATH`); screenshots go to `docs/screenshots/` |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript for server and UI |
| `npm run coverage` | Vitest with V8 coverage; a report is written to `coverage/` |
| `npm run perf -- <dataRoot>` | Backend timings on a temporary copy of a data root ([PERFORMANCE.md](PERFORMANCE.md)) |
| `npm run fixtures` | Regenerate the synthetic fixture data under `fixtures/data` (used by tests and e2e) |

Tests use temporary directories and synthetic data only; they never touch a real project folder. In the working tree
at the time of writing, `npm test` ran 10 test files with 97 tests, all passing; the other commands are documented from
their definitions in `package.json` and were not all re-run for this page, so run them on your machine to confirm.

## Troubleshooting

| Problem | Fix |
|---|---|
| `startup failed: auth.mode "required" (the default) needs auth.tokenFile` | Set `PCC_AUTH_TOKEN_FILE`, or for this machine only `PCC_AUTH_MODE=local-network PCC_TRUSTED_NETWORKS=127.0.0.1/32,::1/128` ([DEPLOYMENT.md](DEPLOYMENT.md#login-modes)). |
| `startup failed: Refusing to bind ... with auth.mode "disabled"` | `disabled` on a non-loopback address needs `PCC_AUTH_DISABLED_ON_NETWORK=1`. Prefer `local-network` or `required`. |
| `startup failed: ... without HTTPS` | Non-loopback bind with a token but no TLS: set `PCC_TLS_CERT` and `PCC_TLS_KEY`, or `PCC_BEHIND_HTTPS_PROXY=1` behind a proxy. |
| Page says the UI is missing or shows only JSON | `PCC_WEB_ROOT` is not set or `npm run build` has not been run. |
| Project missing from the list | Check `GET /api/diagnostics` (invalid manifest, duplicate project id) and that the folder is directly under `<dataRoot>/projects/`. |
| A record does not appear | Diagnostics names the file and the reason; common causes are a duplicate id, a status not in a `strict` workflow, a missing `updatedAt`, or a timestamp without an offset. |
| New file not noticed | Wait one second; on network drives up to 60 seconds. `POST /api/admin/reindex` forces a rebuild. |
| `403 csrf` from a script | Add the header `X-PCC-Request: 1` to every POST. |
| `401 unauthorized` | This client must sign in (`POST /api/auth/login` with `{"token": "..."}`): the mode is `required`, or its address is outside `PCC_TRUSTED_NETWORKS`, or it reached the server by a host name not in `PCC_ALLOWED_HOSTS`. |
| Port already in use | Set `PCC_PORT`. |
| `npm run test:e2e` cannot find a browser | Install Microsoft Edge (default), or set `E2E_BROWSER_CHANNEL=chrome`, or `E2E_BROWSER_PATH` to any Chromium binary; the runner uses `playwright-core` with a system browser. |
| Tests fail with file errors on Windows or network drives | Run from a local disk; exclusive-create and rename semantics matter to the queue. |
