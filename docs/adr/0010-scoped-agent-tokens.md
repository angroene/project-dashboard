# ADR 0010 — Scoped bearer tokens for agents

**Status:** Accepted · **Date:** 2026-11-14 · Extends ADR 0006 · Amended by ADR 0019 (agent tokens work and are checked in every login mode)

## Context

ADR 0006 has one operator token that grants everything. Handing that token to every agent would let any agent answer
the owner's questions, read every project and change any project. Agents also cannot easily keep a cookie session.

## Decision

- Every API call may send `Authorization: Bearer <token>`. The operator token as a bearer token has the operator's
  full access; browser cookie sessions are unchanged.
- An optional `agentTokensFile` (`PCC_AGENT_TOKENS_FILE`) lists agent tokens as SHA-256 hashes with a `name`, a list
  of `projects` (or `"*"`) and `scopes`: `read`, `publish`, `consume`. The server never stores or logs a token.
- Authorisation is an allowlist of routed endpoint patterns per scope. Everything not listed (answering questions,
  Excel, ZIP, read state, diagnostics, reindex, the live-update stream) is operator-only and returns `403`.
- A project outside the token's list answers `404`, the same as a project that does not exist, and is left out of
  `GET /api/projects`. Broken-project cards and the diagnostics count are hidden from agent tokens.
- Wrong bearer tokens count as failed logins (same back-off). `X-PCC-Request: 1` is still required on every non-GET.
- `agentTokensFile` needs token mode; the server refuses to start without it, with an invalid file, with duplicate
  names or hashes, or when an agent token equals the operator token.
- `scripts/agent-token.ts` creates a token into a new mode-600 file and prints only the hash entry.

## Consequences

- An agent can be limited to one project and to exactly the operations it needs. Uploads record the agent name
  (`agent:<name>`) as uploader.
- Tokens are long-lived; revocation is "remove the entry and restart". There is no expiry and no per-token audit log
  beyond the uploader name and the queue `owner`.

## Rejected alternatives

- **Sharing the operator token with agents**: no least privilege; an agent could answer its own questions.
- **Per-project token files inside project folders**: anyone who can write a project folder could grant themselves
  access; access control must stay with the operator.
- **OAuth or user accounts**: far more setup for a self-hosted tool with one owner; no requirement for it yet.
- **Storing tokens in clear text in the config**: a leaked config file would leak working credentials.
