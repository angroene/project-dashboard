# Deployment

You decide where the dashboard runs. The same code and the same data format serve three setups. They are **not**
equivalent in security or persistence, so read the section for the one you pick.

| Setup | Good for | Reachable from | Needs |
|---|---|---|---|
| [Local](#local-loopback) | one developer, one machine | this machine only | Node 22+ |
| [Docker / Compose](#docker-and-docker-compose) | repeatable install, isolation | loopback by default | Docker, a token, a TLS certificate |
| [Self-hosted server](#self-hosted-server) | a team or remote agents | the network you choose | token auth plus HTTPS |

Verification status in this repository: **local mode is tested. Docker files were built and run on linux/arm64 (see below). The reverse-proxy and systemd snippets are examples that were not executed.** Built-in HTTPS and token login
were run locally on a loopback port with a self-signed certificate.

The dashboard does not synchronise folders between computers. Agents on another machine need either shared
storage (a network mount of the data root) or the authenticated HTTP API. Local mode is never reachable from
another computer by default.

## Configuration

Settings come from an optional JSON file (`pcc.config.json` in the working directory, or the path in `PCC_CONFIG`),
overridden by environment variables. Secrets are never stored in the config: the token is read from a file.

| Environment variable | Config key | Default | Meaning |
|---|---|---|---|
| `PCC_DATA_ROOT` | `dataRoot` | required | Folder containing `projects/`. |
| `PCC_HOST` | `host` | `127.0.0.1` | Bind address. |
| `PCC_PORT` | `port` | `8790` | Port. |
| `PCC_WEB_ROOT` | `webRoot` | none | Built UI folder (`dist/web`). Without it only the API is served. |
| `PCC_AUTH_TOKEN_FILE` | `auth.tokenFile` (and `auth.mode: "token"`) | none | File with the access token. Turns token auth on. |
| `PCC_TLS_CERT`, `PCC_TLS_KEY` | `tls.certFile`, `tls.keyFile` | none | PEM files for built-in HTTPS. Both are required together. |
| `PCC_BEHIND_HTTPS_PROXY` | `behindHttpsProxy` | `false` | `1` or `true` when a TLS-terminating proxy on the same machine forwards to the app. Marks the cookie Secure and trusts that proxy. |
| `PCC_CONFIG` | | `./pcc.config.json` | Path of the JSON config. |
| | `extraProjectRoots` | `[]` | Absolute paths of extra project folders registered by the operator. |
| | `productName` | `Agents Project Dashboard` | Title shown in the UI. |
| | `auth.user` | `operator` | Name recorded on answers and used for read state. |
| | `auth.sessionHours` | `720` | Login lifetime, 1 to 2160. |
| | `allowInsecureRemote` | `false` | Config file only. Allows a non-loopback bind without HTTPS (clear-text token). Do not use on an untrusted network. |
| | `uploads.maxBytes`, `uploads.maxFiles`, `uploads.allowedMimeTypes` | 20 MB, 10, built-in list | Upload limits; the MIME list can only narrow the built-in one. |
| | `xlsx.maxBytes`, `xlsx.maxRows` | 5 MB, 5000 | Excel import limits. |
| | `watch`, `reconcileSeconds` | `true`, `60` | File watching and the stat-based safety net (`0` disables the latter). |
| | `logLevel` | `info` | `fatal error warn info debug silent`. |

Example `pcc.config.json`:

```json
{
  "dataRoot": "/srv/dashboard-data",
  "host": "127.0.0.1",
  "port": 8790,
  "webRoot": "dist/web",
  "auth": { "mode": "token", "tokenFile": "/etc/dashboard/token", "user": "operator", "sessionHours": 720 },
  "uploads": { "maxBytes": 20971520, "maxFiles": 10 }
}
```

**Startup rules (enforced, not advisory).** The server refuses to start when:

- the host is not loopback (`127.0.0.1`, `::1`, `localhost`) and token auth is off;
- the host is not loopback and there is neither built-in TLS nor `behindHttpsProxy` (unless `allowInsecureRemote`);
- the token file is missing or the token is shorter than 16 characters;
- a TLS file is missing, or only one of cert and key is set.

## Local (loopback)

```sh
npm ci
npm run build
mkdir -p ./my-data/projects            # or any folder; copy a project into projects/
PCC_DATA_ROOT=./my-data PCC_WEB_ROOT=dist/web npm start
# http://127.0.0.1:8790
```

- Loopback needs no login: anyone with a shell on the machine can use it. That is the trust boundary.
- The server writes into the data root (answers, uploads, read state), so use a copy of the examples, never the
  checked-in `examples/` folder.
- Stop with Ctrl+C (SIGINT) or SIGTERM. Startup indexes all projects and repairs interrupted writes.
- Development mode (two terminals): `npm run dev:server` (API) and `npm run dev:web` (Vite on 5173, proxies `/api`).

## Authentication token

Create a long random token in a file that only the service user can read, outside the repository and the data root:

```sh
# Linux / macOS
mkdir -p ~/.config/dashboard && umask 077
openssl rand -base64 32 > ~/.config/dashboard/token

# any platform with Node
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > token.txt
```

Never commit it, paste it into an issue, or put it in a Dockerfile or environment variable. Users sign in once with
the token in the browser (HttpOnly, SameSite=Strict cookie, 30 days by default); scripts log in via
`POST /api/auth/login`. Sessions are kept in memory, so a restart signs everyone out. To rotate the token, replace the
file and restart. There is one shared token and one operator identity; there are no per-user accounts or
per-project permissions.

## HTTPS

Remote use needs HTTPS: the token and the session cookie are credentials. Two ways:

**A. Built-in TLS.** Point the server at PEM files:

```sh
# self-signed certificate for trying it out (Git Bash on Windows: prefix with MSYS_NO_PATHCONV=1)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

PCC_DATA_ROOT=/srv/dashboard-data PCC_WEB_ROOT=dist/web \
PCC_AUTH_TOKEN_FILE=/etc/dashboard/token \
PCC_TLS_CERT=/etc/dashboard/cert.pem PCC_TLS_KEY=/etc/dashboard/key.pem \
PCC_HOST=0.0.0.0 npm start
```

Checked: with a self-signed certificate the server answers on `https://` only (plain `http://` to the same port
gets no response), and the session cookie is `HttpOnly; Secure; SameSite=Strict`. Browsers warn about self-signed
certificates; use a certificate from your own CA or a public CA for real use. Certificate renewal needs a restart.

**B. Reverse proxy.** Run the app on loopback and let Caddy, nginx or similar terminate TLS on the same machine:

```sh
PCC_BEHIND_HTTPS_PROXY=1 PCC_AUTH_TOKEN_FILE=/etc/dashboard/token PCC_DATA_ROOT=/srv/dashboard-data \
PCC_WEB_ROOT=dist/web npm start        # still bound to 127.0.0.1
```

Caddy (not executed here):

```text
dashboard.example.org {
    reverse_proxy 127.0.0.1:8790
}
```

nginx (not executed here). Live updates use Server-Sent Events, so buffering must be off:

```nginx
server {
    listen 443 ssl;
    server_name dashboard.example.org;
    ssl_certificate     /etc/ssl/dashboard/fullchain.pem;
    ssl_certificate_key /etc/ssl/dashboard/privkey.pem;
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

`PCC_BEHIND_HTTPS_PROXY=1` trusts only a proxy connecting from `127.0.0.1`. A proxy on another host is not supported
as a trusted proxy: terminate TLS in the app or on the same machine. If the proxy is not really on the same machine
or is not terminating TLS, do not set this flag.

## Docker and Docker Compose

**Status: verified on linux/arm64** (Docker 29.5, Compose 5.1): image build, `docker compose up` to healthy, HTTPS only
(plain HTTP refused), token login with a Secure HttpOnly cookie, CSRF guard, read-only root filesystem, non-root user,
all capabilities dropped, token absent from logs, a project folder copied in while running appears within seconds, and
data survives a restart. Not yet tried on amd64.

What the files do:

- Multi-stage build on `node:22-bookworm-slim`; the runtime image holds the compiled server, the built UI, and
  production dependencies only, runs as the unprivileged `node` user, and includes the license files.
- Data lives in `/data` (declared as a volume). Compose mounts the named volume `pcc-data` there.
- Inside the container the server binds `0.0.0.0` (it must, to be reachable through the published port), so the
  startup rules apply: a token file **and** TLS are required. The container fails fast without them.
- Compose publishes the port on the host's loopback address only (`127.0.0.1:8790` by default). No personal or
  absolute host paths are baked in.
- The container filesystem is read-only except `/data` and `/tmp`; all capabilities are dropped.

Setup:

```sh
mkdir secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > secrets/pcc_token.txt
openssl req -x509 -newkey rsa:2048 -nodes -keyout secrets/tls_key.pem -out secrets/tls_cert.pem -days 365 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
# The files must be readable by the container user (uid 1000 in the node image):
chmod 600 secrets/*; sudo chown 1000:1000 secrets/*       # Linux; adjust for your setup

docker compose up --build -d
# https://127.0.0.1:8790  (self-signed: the browser shows a warning)
```

Settings:

| Variable (shell or `.env`) | Default | Effect |
|---|---|---|
| `PCC_HOST_PORT` | `8790` | Host port. |
| `PCC_BIND` | `127.0.0.1` | Host address to publish on. `0.0.0.0` exposes the dashboard to the network; read [Exposure](#exposure-checklist) first. |

Put projects into the volume. Each project is a folder under `/data/projects/`:

```sh
docker compose cp ./my-project dashboard:/data/projects/my-project     # ownership may need fixing, see below
docker compose exec dashboard ls /data/projects
```

Files copied in as root may not be writable by the `node` user (the server needs to write `communications/`,
`user-state/` and uploads). Alternatively replace the named volume with a bind mount of a host folder owned by uid 1000
(`./data:/data`). Do not mount a folder you care about before testing.

To try the examples: copy `examples/projects/*` into `/data/projects/` of a **fresh** volume.

Using a reverse proxy in front of the container instead of built-in TLS: remove the two `PCC_TLS_*` variables and the
TLS secrets from the compose file and set `PCC_BEHIND_HTTPS_PROXY: "1"`. The proxy must be able to reach the published
port and must itself be on the same host (the container sees the proxy as a non-loopback address, so the app's
trusted-proxy handling does not apply and every client appears with the proxy's address for login throttling).
This combination has not been tested.

Limitations: no image is published to a registry; the health check assumes built-in TLS; the first start of a new
named volume takes its ownership from the image (`node` user); the examples are not baked into the image.

### Upgrading

Data is plain files outside the image, so an upgrade replaces only the code:

```sh
# back up first (see Backups)
git pull
docker compose up --build -d
```

Read the release notes for schema changes; any breaking change to the data format is announced with a migration note.
Roll back by checking out the previous version and rebuilding. Restarting signs users out (sessions are in memory).

## Self-hosted server

A minimal, least-privilege setup on Linux (example only; adapt names and paths):

```sh
sudo useradd --system --home /srv/dashboard --shell /usr/sbin/nologin dashboard
sudo mkdir -p /srv/dashboard/app /srv/dashboard-data/projects /etc/dashboard
# install the code and build as an administrator, then:
sudo chown -R root:root /srv/dashboard/app                 # code is not writable by the service
sudo chown -R dashboard:dashboard /srv/dashboard-data      # data is
sudo install -m 600 -o dashboard -g dashboard token /etc/dashboard/token
```

`/etc/systemd/system/dashboard.service` (not executed here):

```ini
[Unit]
Description=Project dashboard
After=network.target

[Service]
User=dashboard
WorkingDirectory=/srv/dashboard/app
Environment=PCC_DATA_ROOT=/srv/dashboard-data
Environment=PCC_WEB_ROOT=/srv/dashboard/app/dist/web
Environment=PCC_AUTH_TOKEN_FILE=/etc/dashboard/token
Environment=PCC_BEHIND_HTTPS_PROXY=1
ExecStart=/usr/bin/node dist/server/server/main.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/dashboard-data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Checklist: bind loopback behind a TLS proxy (or use built-in TLS), token file mode 600, data owned by the service
user, code read-only for the service, firewall allowing only the proxy port.

## Volumes and permissions

- The service user needs read and write on the data root and nothing else. It must be able to create files in each
  project's `communications/`, `user-state/` and `<attachmentRoot>/answers/`.
- Projects registered with `extraProjectRoots` must be readable and writable by the same user. The server only reads
  folders listed there or under `<dataRoot>/projects`; a project cannot point outside its own folder.
- Network shares: file watching may not deliver events, so changes can take up to 60 seconds (the reconciliation
  interval). Use a local disk for the data root when you can; if a share is needed, check that atomic rename and
  exclusive file creation work on it, because the queue depends on both.
- Keep the token file and TLS key outside the data root and outside backups that leave your control.

## Backups and restore

Everything is plain files under the data root. The in-memory index is rebuilt at start.

```sh
# back up (stop the server for a perfectly consistent copy; a running copy is usually fine, see below)
tar -czf dashboard-data-$(date +%F).tar.gz -C /srv/dashboard-data .

# restore
sudo systemctl stop dashboard
tar -xzf dashboard-data-2026-11-13.tar.gz -C /srv/dashboard-data
sudo chown -R dashboard:dashboard /srv/dashboard-data
sudo systemctl start dashboard
```

- Back up the whole project folders: records, `attachments/` (including uploaded answer files), `communications/`
  (the answer queue and claims) and `user-state/` (read state). Restore them together.
- Writes are temp file plus fsync plus rename, so a live copy never contains a half-written JSON file; leftover
  `.*.tmp` files can be deleted. A copy taken mid-submission may contain a staged answer, which startup repairs.
- After a restore, answers that were `processing` return to `pending` when their lease expires (or call
  `POST /api/projects/:projectId/queue/recover`). Consumers must be idempotent, see [QUEUE.md](QUEUE.md).
- Docker: `docker run --rm -v <project>_pcc-data:/data -v "$PWD":/backup debian:bookworm-slim tar -czf /backup/data.tar.gz -C /data .`
  (volume name depends on your compose project name; not executed here).
- No telemetry is sent anywhere. Logs go to stdout as JSON; cookies and authorization headers are redacted and
  record content is never logged.

## Exposure checklist

Before the dashboard is reachable by anyone but you:

1. Token auth on, token at least 32 random characters, file mode 600.
2. HTTPS end to end (built-in TLS or a proxy on the same host). Never send the token over plain HTTP on a shared network.
3. Understand the trust model ([SECURITY_MODEL.md](SECURITY_MODEL.md)): anyone with the token has full access to
   every project on the server, can submit answers, upload allowed file types and download attachments. There are no
   per-project permissions. Use separate server instances for projects with different audiences.
4. Do not put the dashboard on the public internet without a proxy that adds rate limiting, and do not rely on it
   as the only layer. Only failed logins are rate limited in the app.
5. Back up, and test a restore.
6. Keep Node and dependencies updated.
