# Security model

What the dashboard protects, what it trusts, and what it does not do. To report a vulnerability see
[SECURITY.md](../SECURITY.md). This is a description of the implementation, not a certification.

## Trust boundaries

| Party | Trusted to | Not trusted to |
|---|---|---|
| **Server operator** (controls config, data root, token file) | choose data roots, register extra project roots, set limits | |
| **Authenticated user** (holds the token, or anyone on loopback) | read every project on this server, submit answers, upload allowed files, download attachments, trigger a reindex | write outside the project folders; see server file paths |
| **Project files** (JSON, Markdown, attachments written by producers) | nothing: every file is parsed and validated, content is rendered as data | choose paths outside their own project, run code, inject HTML or scripts |
| **Browser content** (answers, uploads, Excel files) | nothing | |

There is **one shared access level**: whoever can sign in sees all projects on the server. There are no accounts and no
per-project permissions. If two audiences must not see each other's projects, run two server instances with separate
data roots.

## Network exposure and authentication

- Default bind is `127.0.0.1` without login. A different bind address **refuses to start** without token
  authentication and HTTPS (built-in TLS, or `PCC_BEHIND_HTTPS_PROXY` for a TLS proxy on the same machine). The
  config-file option `allowInsecureRemote` is the one explicit opt-out; it sends the token in clear text.
- The token is read from a file (at least 16 characters, never logged) and compared in constant time after hashing.
  It is exchanged for a random 256-bit session id in an HttpOnly, SameSite=Strict cookie, Secure whenever TLS or a
  declared HTTPS proxy is in use. Sessions live in memory: at most 1000, and a restart signs everyone out.
- Failed logins are throttled per client address (after 5 failures the wait doubles, up to 5 minutes). There is no
  other rate limiting; put a proxy with rate limits in front of anything internet-facing.
- Every state-changing request needs the header `X-PCC-Request: 1` and, if the browser sends an `Origin`, it must
  match the host (CSRF defence). The auth decision uses the routed path after URL decoding, so encoded paths such as
  `/%61pi/...` do not bypass it.
- The static UI shell is public (it contains no project data); every `/api` route except `/api/session` and
  `/api/auth/*` requires the session.
- Response headers: `Content-Security-Policy` (`default-src 'self'`, no inline script, `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. The UI loads nothing
  from other hosts.

## Filesystem access

- Projects are found only under `<dataRoot>/projects/` and in `extraProjectRoots`, both set by the operator. A
  project cannot register itself or another location.
- Every path in a manifest or record is relative and is resolved against the project folder. Absolute paths, drive
  letters, UNC paths, NUL bytes and `..` segments are rejected; the resolved real path must stay inside the project,
  so **symlinks and junctions that lead outside are rejected** too. Section folders that escape through a symlink are
  ignored.
- Attachments resolve inside the project's attachment root or one of its declared read-only `artifactRoots`, and the
  API addresses them by id, never by path. One project cannot read another project's files.
- API errors, diagnostics and logs use project-relative paths and error codes, not server file paths.
- The server never writes outside a project's `communications/`, `user-state/` and attachment `answers/` folders.
  Record, section and manifest files are never modified by the dashboard.
- All JSON writes are atomic (temp file, fsync, rename). Read sizes are capped, and malformed files are isolated
  and reported rather than crashing the server.

## Uploads and downloads

- Allowed types are an extension allowlist (images, PDF, Markdown, text, and Word/Excel/PowerPoint Open XML files),
  checked again by content signature. The client's declared MIME type is ignored. Executables, scripts, SVG and
  archives are rejected.
- Size and count limits apply while streaming (default 20 MB per file, 10 files). Uploaded files get opaque server
  names (`<attachmentId>.<ext>`) and a metadata sidecar with a SHA-256; original file names are sanitised and only
  used for display.
- Files are stored, never executed, and are **not virus-scanned**.
- Only images, PDF and plain text are shown inline; everything else, including all Office files, downloads. SVG files
  that a project itself provides are served in a sandboxed context with a restrictive CSP.
- ZIP downloads contain only attachments the API resolved for the project; entry names are generated from sanitised
  record ids and file names (no path separators, duplicates renamed), plus a `manifest.json`. Selections over 1 GB are
  refused.

## Content rendering

- Markdown is rendered with raw HTML skipped; only `http(s)`, relative and fragment links survive, external links open
  with `rel="noopener noreferrer"`, and remote images are not loaded (a placeholder is shown), so a record cannot
  make a viewer's browser call a third party.
- All other text is rendered as text. No record field is ever inserted as HTML.
- Schema validation caps lengths and counts of every field.

## Excel

- Exported cells are written as text strings; the export contains no formulas, so a question title like
  `=HYPERLINK(...)` is stored as literal text (checked).
- On import, formulas and error values in answer cells are rejected, the workbook's zip structure is size- and
  entry-limited before parsing (zip-bomb guard), and the workbook must come from this project (project id in a hidden
  sheet). Imports are previewed first; a row that is invalid, stale, already answered or blank never overwrites
  anything. See [EXCEL.md](EXCEL.md). Sheet protection is a usability hint, not a security control.

## Queue integrity

Answers are validated against the question's schema on the server before they are written. Claims use exclusive
file creation and a lease, only the lease owner can complete or fail an answer, and each question revision accepts one
answer. Details: [QUEUE.md](QUEUE.md), ADR 0003.

## What is not covered

- No per-user or per-project authorization, no audit of individual users beyond the operator name on answers.
- No encryption at rest and no malware scanning of uploads.
- Clear-text HTTP on a network (`allowInsecureRemote`) exposes the token and cookie.
- The token is long-lived and shared; rotate it by replacing the file and restarting.
- Anyone who can write into a project folder (producers, other processes) is trusted to produce valid data;
  invalid data is rejected or isolated, but a producer can, for example, publish misleading progress.
- Denial of service by an authenticated user (large but valid requests) is bounded by the size limits, not prevented.
- The built-in server is not hardened for the open internet.

## Known limitations

See [LIMITATIONS.md](LIMITATIONS.md). Dependency licenses: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
