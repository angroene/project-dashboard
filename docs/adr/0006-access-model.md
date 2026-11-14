# ADR 0006 — Access model

**Status:** Accepted for the first release · **Date:** 2026-11-13

- Bound to `127.0.0.1` (default): no login.
- Any other bind address **refuses to start** unless `auth.mode = "token"` with a token file (at least 16
  characters, read at startup, never logged). Login exchanges the token for a random session id in an
  HttpOnly, SameSite=Strict cookie (Secure when TLS is configured or `behindHttpsProxy`). Failed logins back off.
- Every POST needs `X-PCC-Request: 1` and, if an Origin header is present, the same host (CSRF guard).
- TLS: built-in (`tls.certFile/keyFile`, env `PCC_TLS_CERT`/`PCC_TLS_KEY`) or a same-host TLS reverse proxy
  (`behindHttpsProxy`, env `PCC_BEHIND_HTTPS_PROXY`). A non-loopback bind also **refuses to start without HTTPS**
  unless the config file sets `allowInsecureRemote: true`, an explicit opt-out that sends the token in clear text.
- Single user (`auth.user`, default "operator"); read state is per that user. Sessions are in memory
  (a restart signs everyone out).

**Rejected for the first release:** multi-user accounts/OAuth (no requirement yet); no auth on the LAN (unsafe).