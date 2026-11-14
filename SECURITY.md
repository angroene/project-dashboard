# Security policy

## Supported versions

Only the latest release (or the current main branch) receives security fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in a public issue or pull request. Use the repository
host's private vulnerability reporting ("Report a vulnerability" under the Security tab) if it is enabled, or contact
the maintainers by the private contact method listed on the repository page.

Include what you can: the affected version or commit, what you did, what you expected, what happened, and the impact.
A minimal reproduction using synthetic data is ideal.

**Do not post secrets in reports, issues or logs.** That includes access tokens, token files, TLS private keys, session
cookies, and real project data. If you accidentally exposed a token, rotate it (replace the token file and restart the
server) and mention only that it was rotated.

You can expect an acknowledgement, an assessment, and a coordinated fix and disclosure. This is a small project, so
timelines are best effort.

## Scope and deployment

How the dashboard is designed to be exposed, and what it does not protect against, is described in
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Running it on a network
without a token and HTTPS is a configuration problem the server refuses by default, not a vulnerability.
