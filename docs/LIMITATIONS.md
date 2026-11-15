# Known limitations

- **No answer consumer runs inside the dashboard.** Answers wait in `communications/answers/pending/` until something
  claims them (queue API, `scripts/queue.ts`, or the `apd` CLI and skills in `agent-kit/`). The UI shows "Submitted,
  awaiting pickup". The dashboard cannot push a message into a running agent session; agents check the queue at work
  boundaries, optionally reminded by a session-start hook ([SKILLS.md](SKILLS.md)).
- **Agent kit validation.** The CLI and API are covered by automated tests and a demo. All four skills were run in
  Claude Code (Haiku) and Codex CLI on Windows with one model each; other runtimes, models and operating systems
  were not tried. Agents can still pick the wrong record type or skip a flag; check the first runs.
- **Publishing and local writers.** A local producer and the publish API writing the same record at the same moment
  are not coordinated (last write wins); API writers can detect it with `ifRevision`. Agent tokens do not expire;
  revoke by editing the token file and restarting.
- **At-least-once delivery.** Consumers must be idempotent ([QUEUE.md](QUEUE.md)). Leases cannot be renewed; choose a
  lease longer than the job.
- **One answer per question revision.** To let a user answer again, the producer bumps `questionRevision` or a consumer
  fails the answer. Users cannot edit a submitted answer.
- **Single shared human access level.** One operator identity per server (`auth.user`); read and unread state is per
  that identity. Sessions are in memory (a restart signs everyone out). No user accounts; per-project limits exist
  only for scoped agent tokens.
- **Transport security is deployment work.** Remote use needs HTTPS; the server enforces it at startup (built-in TLS
  or a proxy), unless `allowInsecureRemote` is set. Only failed logins are rate limited.
- **Login-free access is by address only.** `local-network` trusts configured IP ranges (and `disabled` trusts
  everyone); there is no per-user identity, and clients let in without login have operator access, beyond agent token
  scopes. Behind Docker's port proxy the client address can be the bridge gateway, which makes `local-network`
  unusable there. Tested with injected addresses and on loopback; real LAN, VPN and proxy setups were not tested.
- **Docker is tested on Linux hosts only** (amd64 and arm64). macOS and Windows hosts are untested. No image is
  published; build it locally (`deploy/apd-deploy.sh up`).
- **Uploads are not virus-scanned.** Type is checked by extension allowlist and content signature, size is capped,
  files are stored under opaque names and never executed; Office files are served as downloads only.
- **Cross-machine projects.** The server only reads folders it can see. There is no sync between machines; mount shared
  storage or use the HTTP API.
- **Excel.** File-upload fields cannot be answered in Excel (reported as `needs-dashboard`). Sheet protection is a
  hint, not security. Import previews live in memory for 30 minutes and are lost on restart.
- **Search** is a plain substring match on id, title and summary within one section; bodies are not searched.
- **File watching.** Recursive `fs.watch` works on Windows and Linux; network shares and some container mounts may not
  deliver events, so a 60 second stat reconciliation applies and changes there can take up to a minute.
- **What the dashboard writes.** It never edits manifests, question contents or a record's `status`. It writes answer
  files, read state, the user's tracked-field values, comments and attachments on records of cards that allow them
  (ADR 0012), occurrence records of recurring templates, and a template's `state` when it is paused or resumed.
- **One server per data folder.** Record updates are serialised inside one server process. A second server on the
  same data root refuses to start (writer lock `.apd-writer.lock`, refreshed every 10 s; a lock older than 30 s is
  taken over; ADR 0016). Extra project roots (`extraProjectRoots`) are not locked: never point two servers at the same one.
- **Recurring templates are daily only.** No weekly, monthly or cron schedules. Missed days beyond `catchUpDays` are
  skipped, not created. The schedule is checked every `recurrenceSeconds` (60), so a day can appear up to a minute
  after its time.
- **External references are not refreshed.** The dashboard never contacts other systems; a reported status is as old as
  its `statusAt`.
- **Tracked fields** are limited to checkbox, choice, text and date, 20 per card. Changes are attributed to the token
  name or to "user" (one operator identity). Names agents put in `by` must be printable ASCII and must not start with
  "user". `apd update --field id=true` always sends a boolean; to store the text
  "true" in a text field use the API.
- **Browsers.** The automated end-to-end walk uses one Chromium-based browser. Phones, screen readers and other
  browsers were not systematically tested.
- **Status workflows replace, not merge.** A project that declares a workflow for a record type must list every status
  it uses ([ADR 0008](adr/0008-configurable-status-workflows.md)). Question statuses are not configurable.
- **Dependency override.** `package.json` overrides the Excel library's `unzipper` version so that no dependency without
  a license is installed; remove it once the Excel library updates ([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)).

## Extension points

These are seams that exist; nothing beyond them is built:

- The queue API, the publish API and the `apd` CLI are the integration surface for any producer or consumer (agent
  runtimes, CI jobs, chat bots); see [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md).
- The `/api/updates` event stream tells a client what changed, which a notifier could subscribe to.
- Display types, icons and actions are closed lists in the schemas; adding one is a schema change plus a UI mapping.
- New record types need a schema, a default workflow and a UI mapping; `generic` covers most needs today.
