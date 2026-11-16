# Changelog

## Unreleased

### Added

- Default answers for single-choice, multiple-choice, free-text and approval questions (shown, never submitted;
  ADR 0011).
- Tracked fields on cards, comments and attachments on records, filters by field value (ADR 0012).
- External references with the source system's reported status (ADR 0013).
- Daily recurring records from templates, with pause, resume, disable and enable (ADR 0014, ADR 0017).
- `apd list`, `apd templates`, and `apd update --field / --external / --if-revision`.
- JSON Schemas for the file formats in `docs/schemas/`.
- Configurable dashboard login (ADR 0019): `required` (default), `local-network` (no login for explicitly configured
  address ranges) and `disabled` (explicit, with warnings). Forwarded client addresses are believed only from
  configured proxies (`trustedProxies`). Settings: `PCC_AUTH_MODE`, `PCC_TRUSTED_NETWORKS`, `PCC_TRUSTED_PROXIES`,
  `PCC_ALLOWED_HOSTS`, `PCC_AUTH_DISABLED_ON_NETWORK`.
- Docker Compose passes scoped agent tokens: `secrets/agent_tokens.json` is mounted as a secret (ADR 0020). The
  deploy script creates it empty when missing (also on `upgrade`, `rollback` and `restore`) and has a `restart`
  command to reload it.
- A malformed agent token list no longer quotes part of the file in the start-up error (it could contain a pasted
  token); the error is `agentTokensFile invalid: not valid JSON`.
- Record details on phones: a long code line or table scrolls inside its box instead of widening the record past
  the screen. Image attachments (PNG, JPEG, GIF, WebP) show as previews that open full size, and attachments come
  before the answer form.
- "Needs your attention" can be folded, and so can each of its groups.
- Attention groups (ADR 0021): the project overview splits what needs the user into Questions, Actions, Responses and
  Updates, each with its count, paged, and only pending items by default. "Show all" (off on every visit) adds
  answered, completed and read history without changing anything. Select items, Select all unread shown, and Mark
  selected as read (read state only; never answers or completes). Header counts open the matching group
  (`#/p/<project>?attention=<group>`). New `GET /attention/:group`; `GET /attention` adds `counts`, `totals`,
  `unreadActivity`.
- `requiresAction` on any record (ADR 0021): listed under Actions until a question is answered or another record
  reaches a done or closed status. `PATCH` accepts it; `apd update --action true|false`; `apd attention`.
- Project cards on the landing page are collapsed by default: the name (opens the project), then "N require
  attention" or a compact progress bar, or nothing. A chevron button shows the full details. New card fields
  `outstandingActions` and `requireAttention`.
- Daily Yes / No values (ADR 0022): tracked field type `yes-no` (Yes / No buttons that save on tap, also on the
  record row). With a recurring template that sets its default, the day's value is in effect from the template's
  reset time without anyone answering. `GET /templates/:templateId/current` (agent `read` scope) and
  `apd daily <template> --field <id>` return the current value, also before the scheduler has created the day.
- A floating "Back to top" button after scrolling down.

### Upgrade notes

Four changes can break existing setups. All are deliberate security or integrity changes, and there is no switch to
restore the old behaviour.

1. **Login is required by default** (ADR 0019). A server without a token file no longer starts in the old
   no-login loopback mode; it stops with `auth.mode "required" (the default) needs auth.tokenFile`.
   **Migration:**
   - Kept the old loopback-without-login setup: set `PCC_AUTH_MODE=local-network` and
     `PCC_TRUSTED_NETWORKS=127.0.0.1/32,::1/128`.
   - Used `auth.mode: "token"`: nothing to do (`token` means `required`).
   - Used `auth.mode: "none"`: it is refused; choose `local-network` with explicit ranges or, deliberately, `disabled`.
   - Behind a reverse proxy with `PCC_BEHIND_HTTPS_PROXY=1`: add `PCC_TRUSTED_PROXIES=127.0.0.1` (or the proxy's
     address). The forwarded client address is no longer believed implicitly; without this, every client appears as
     the proxy for login throttling.
   - Agent tokens no longer need token mode; they are checked in every mode.

2. **Agent names that read as the user's are refused.** A name whose letters and digits start with "user", in any
   case (`user`, `user-ci`, `User2`, `u.s.e.r`), is reserved for the dashboard user.
   - Agent token file: the server refuses to start and names the entry, for example
     `agentTokensFile invalid: tokens.1.name 'user-ci' must not start with "user" ...; rename the token`.
     **Migration:** rename the token in the token file (for example `ci-agent`; `ci-user` is fine) and restart. The
     token itself and its hash stay valid. `npm run agent-token` refuses such names when creating a token.
   - `by` in history entries and attachments (`apd update --by`, `PATCH`, `PUT`): `403 reserved-actor`.
     **Migration:** use the agent's own name. Entries already stored are kept as they are. (ADR 0015)
3. **Leaving a field out of a full write no longer clears it.** `PUT` (`apd publish`) keeps every tracked field the
   record leaves out, as well as the user's comments and attachments.
   **Migration:** to clear a field, send it with `null`: `"fields": {"checks": null}` in `apd publish`, or
   `apd update --field checks=none` (sends `null`). `PATCH` already worked this way. A user-only field cannot be
   cleared by an agent (`403 field-not-editable`). (ADR 0015)
4. **Docker Compose needs `secrets/agent_tokens.json`** (ADR 0020). Without it `docker compose up` stops because a
   secret file is missing. **Migration:** `deploy/apd-deploy.sh` creates an empty list on `up`, `upgrade`,
   `rollback`, `restore` and `restart`. Without the script, create it once:
   `echo '{ "schemaVersion": 1, "tokens": [] }' > secrets/agent_tokens.json` (readable by uid 1000, like the token).

Other changes:

- **One server per data root.** A server now takes a writer lock (`<dataRoot>/.apd-writer.lock`) and a second server
  on the same data refuses to start (ADR 0016). New setting `writerLockWaitSeconds` (default 35).
  A server that cannot start because of it waits up to that long, then names the holder.
- **Published records are validated strictly:** unknown keys and attachment roots not declared in `artifactRoots`
  give `422` (keys already in the stored file are accepted). Ids that differ from an existing record or event only in
  letter case give `409`. **Migration:** clients that send extra keys must drop them; declare any extra attachment
  root in `artifactRoots`.
- **`"enabled": false`** now turns a project off: every request for it returns `404` (ADR 0018). Agent uploads need
  `publishing.enabled`. **Migration:** a project meant to stay visible keeps `"enabled": true`; agents that upload
  need `publishing.enabled: true` in the project.
