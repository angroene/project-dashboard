# Known limitations

- **No answer consumer is included.** Answers wait in `communications/answers/pending/` until something claims them
  through the queue API or `scripts/queue.ts`. The UI shows "Submitted, awaiting pickup". Agent skills, hooks and
  runtime notifications for any particular tool are not part of this release.
- **At-least-once delivery.** Consumers must be idempotent ([QUEUE.md](QUEUE.md)). Leases cannot be renewed; choose a
  lease longer than the job.
- **One answer per question revision.** To let a user answer again, the producer bumps `questionRevision` or a consumer
  fails the answer. Users cannot edit a submitted answer.
- **Single shared access level.** One operator identity per server (`auth.user`); read and unread state is per that
  identity. Sessions are in memory (a restart signs everyone out). No accounts, no per-project permissions.
- **Transport security is deployment work.** Remote use needs a token and HTTPS; the server enforces both at startup
  (built-in TLS or a same-host proxy), unless `allowInsecureRemote` is set. A proxy on another host is not supported
  as a trusted proxy. Only failed logins are rate limited.
- **Docker is verified on linux/arm64 only**, not yet on amd64. No image is published; build it locally.
- **Uploads are not virus-scanned.** Type is checked by extension allowlist and content signature, size is capped,
  files are stored under opaque names and never executed; Office files are served as downloads only.
- **Cross-machine projects.** The server only reads folders it can see. There is no sync between machines; mount shared
  storage or use the HTTP API.
- **Excel.** File-upload fields cannot be answered in Excel (reported as `needs-dashboard`). Sheet protection is a
  hint, not security. Import previews live in memory for 30 minutes and are lost on restart.
- **Search** is a plain substring match on id, title and summary within one section; bodies are not searched.
- **File watching.** Recursive `fs.watch` works on Windows and Linux; network shares and some container mounts may not
  deliver events, so a 60 second stat reconciliation applies and changes there can take up to a minute.
- **Records and manifests are read-only for the dashboard.** It never edits question records or manifests; status
  changes made by users happen only through answers and read state.
- **Browsers.** The automated end-to-end walk uses one Chromium-based browser. Phones, screen readers and other
  browsers were not systematically tested.
- **Status workflows replace, not merge.** A project that declares a workflow for a record type must list every status
  it uses ([ADR 0008](adr/0008-configurable-status-workflows.md)). Question statuses are not configurable.
- **Dependency licenses.** One transitive dependency of the Excel library (`buffers`) declares no license
  ([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)).

## Extension points for later phases

These are seams that exist; nothing beyond them is built:

- The queue API and `scripts/queue.ts` are the integration surface for any consumer (agent runtimes, CI jobs, chat bots).
- The `/api/updates` event stream tells a client what changed, which a notifier could subscribe to.
- Display types, icons and actions are closed lists in the schemas; adding one is a schema change plus a UI mapping.
- New record types need a schema, a default workflow and a UI mapping; `generic` covers most needs today.
