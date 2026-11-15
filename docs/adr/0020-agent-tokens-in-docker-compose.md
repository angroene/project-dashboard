# ADR 0020 — Scoped agent tokens in the Docker Compose deployment

**Status:** Proposed · **Date:** 2026-11-15 · Builds on ADR 0010, ADR 0019

## Context

The server reads scoped agent tokens from `agentTokensFile` (`PCC_AGENT_TOKENS_FILE`). The Compose file and the
deploy script did not pass that setting, and the image's file system is read-only. A Docker deployment therefore had
no way to give an agent a scoped token. Agents could only use the operator token (full access to every project) or
reach the server login-free from a trusted network, which bypasses scopes as well (ADR 0019). Scoped tokens are the
only way to limit an agent to its own projects, so the gap affected every Docker deployment with agents.

## Decision

- Compose always mounts `${APD_SECRETS_DIR}/agent_tokens.json` as the secret `pcc_agent_tokens` and sets
  `PCC_AGENT_TOKENS_FILE=/run/secrets/pcc_agent_tokens`. The file format is unchanged: hashes only, and
  `{ "schemaVersion": 1, "tokens": [] }` is a valid empty list.
- `deploy/apd-deploy.sh` creates that empty list when it is missing, and never overwrites it. Every command that starts
  the container (`up`, `upgrade`, `rollback`, `restore`, `restart`) does this, so an instance set up before this change
  keeps working after `upgrade`. The file gets the same permissions as the access token: mode 600, or group 1000 and
  mode 640 when the operator is not uid 1000.
- A new `restart` command recreates the container with the current settings and secrets. The server reads the token
  list only at start, so a change takes effect after a restart.
- A token list that is not valid JSON stops start-up with `agentTokensFile invalid: not valid JSON`. The parser's own
  message is not repeated, because it quotes part of the file, and an operator may have pasted a raw token there.

## Rejected alternatives

- **Optional secret, only when the file exists.** Compose has no optional secrets. Achieving this would need a second
  Compose file or generated Compose content, which means two code paths and a setting that is easy to forget.
- **Token list in the data volume.** It would end up in backups and restores, mixing secrets with project data;
  the deployment docs keep secrets outside the data root.
- **Environment variable holding the list.** Visible in `docker inspect` and process listings, and awkward to edit.
- **Reloading the list without a restart.** That is new server behavior; a restart is enough for the rare change.

## Consequences

- Plain `docker compose up` without the script needs the file once. This is listed in the changelog's upgrade notes.
- The deploy test covers creation, permissions, an unknown token refused, a listed token limited to its project,
  removal after restart, a malformed list (start refused, content not logged), Compose without the file (refused),
  and creation on `upgrade` of an older instance. Unit tests cover the empty list, a missing file, malformed content
  and `PCC_AGENT_TOKENS_FILE`.
