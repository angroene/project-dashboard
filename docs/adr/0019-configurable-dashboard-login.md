# ADR 0019 — Configurable dashboard login

**Status:** Accepted · **Date:** 2026-11-15 · Amends ADR 0006, ADR 0010

## Context

ADR 0006 had two modes: no login on a loopback bind (the default) and a shared token for any other bind. Operators
asked for login-free use on a trusted LAN, and for a deliberate no-login setup. Three problems with the old design
stood in the way:

- No login was the default, so a configuration mistake ended in an open dashboard.
- Scoped agent tokens needed token mode; without it they were rejected at start-up.
- `behindHttpsProxy` silently trusted `X-Forwarded-For` from `127.0.0.1`, an inferred proxy.

## Decision

- **Three modes in `auth.mode` (`PCC_AUTH_MODE`):**
  - `required`: everyone signs in. This is the default, and it needs a token file.
  - `local-network`: clients whose address is in `auth.trustedNetworks` need no login; everyone else signs in
    (when a token file exists).
  - `disabled`: nobody signs in.

  `token` stays accepted as the former name of `required`. `none` is refused with a message naming the replacements.
- **Nothing is inferred.**
  - `local-network` needs explicit CIDR ranges.
  - A range that admits every address (`/0`) is refused; that is `disabled`.
  - Ranges given in another mode are refused rather than ignored.
- **Client address.**
  - The client address is the TCP peer's.
  - Forwarded headers are believed only from addresses in `trustedProxies` (Fastify `trustProxy` with that list).
    In that case the right-most untrusted address counts, so a client cannot prepend a forged one.
  - `behindHttpsProxy` now only marks the cookie Secure.
- **Host check for login-free access.** The `Host` header must be an IP address, `localhost`, or a name in
  `auth.allowedHosts`. This stops DNS-rebinding pages, which would otherwise be "local" clients.
- **`disabled` is a deliberate choice.** It is never the default and is announced in four places:
  - a prominent block in the start-up log;
  - a warning on every page;
  - a second opt-in, `auth.disabledOnNetwork`, for a non-loopback bind;
  - a typed confirmation in the deploy script.
- **Bearer tokens are checked in every mode.** An agent token keeps its projects and scopes, and an unknown token gets
  `401` instead of being treated as anonymous. `agentTokensFile` works in every mode.
- **Unchanged in every mode:** the CSRF guard, validation, project isolation, upload limits and the HTTPS rule for
  non-loopback binds.
- The same guard decides every `/api` route. A test enumerates the server's registered routes, so a new route
  cannot escape it.

## Consequences

- A plain `npm start` without settings refuses to start until the operator chooses: a token file, or
  `local-network` with `127.0.0.1/32,::1/128` for the old loopback behaviour.
- Setups behind a proxy must list the proxy in `trustedProxies`. Otherwise every client appears as the proxy, for
  login throttling and for `local-network`.
- Clients let in without login have operator access, so scopes restrict only agents that must authenticate. This is
  documented as a limit of the login-free modes.
- In Docker, Docker's port proxy can make clients appear with the bridge gateway's address. The documentation says
  never to trust Docker's ranges.

## Rejected alternatives

- **Detect the local subnet automatically:** VPNs, guest networks and containers make "local" unpredictable, and a
  silent guess would widen access.
- **Trust `X-Forwarded-For` whenever `behindHttpsProxy` is set:** any client could claim a trusted address.
- **Keep `none` as an alias of `disabled`:** an old loopback config would silently become "login-free from anywhere"
  once the bind address changes. Refusing makes the operator choose.
- **Ignore an unknown bearer token in login-free modes:** a typo would pass as operator access in logs and tests,
  hiding the mistake.
- **Per-route opt-in to login-free access:** one guard for all routes is simpler to verify.
