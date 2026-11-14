#!/usr/bin/env bash
# Deploy and operate Agents Project Dashboard with Docker Compose on a Linux or macOS host.
#
#   deploy/apd-deploy.sh up              clean deployment: no projects (existing data is kept)
#   deploy/apd-deploy.sh up --demo       demo deployment: adds the fictional example projects that are missing
#   deploy/apd-deploy.sh health [--auth] container health, HTTPS answer, plain HTTP refused; --auth also logs in
#   deploy/apd-deploy.sh backup [--stop] [--dir DIR]
#   deploy/apd-deploy.sh restore FILE [--confirm NAME]
#   deploy/apd-deploy.sh upgrade         back up, rebuild from this checkout, restart, verify (data kept)
#   deploy/apd-deploy.sh rollback        return to the image that was running before the last upgrade (data kept)
#   deploy/apd-deploy.sh status | logs | down
#   deploy/apd-deploy.sh reset [--confirm NAME]   DESTRUCTIVE: deletes all dashboard data (after a safety backup)
#
# Settings (environment or a .env file next to docker-compose.yml):
#   APD_NAME        instance name = Compose project name (default: apd). Data volume: <name>_pcc-data
#   APD_SECRETS_DIR token and TLS files (default: ./secrets); created on first `up` when missing, never overwritten
#   APD_BACKUP_DIR  where backups go (default: ./backups)
#   APD_TLS_NAMES   extra certificate names for a generated certificate, e.g. "DNS:dash.lan,IP:192.0.2.10"
#   PCC_BIND        host address to publish on (default 127.0.0.1 = this machine only)
#   PCC_HOST_PORT   host port (default 8790)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

NAME="${APD_NAME:-apd}"
SECRETS="${APD_SECRETS_DIR:-./secrets}"
BACKUPS="${APD_BACKUP_DIR:-./backups}"
BIND="${PCC_BIND:-127.0.0.1}"
PORT="${PCC_HOST_PORT:-8790}"
IMAGE="agents-project-dashboard:${NAME}"
VOLUME="${NAME}_pcc-data"
export APD_IMAGE="$IMAGE" APD_SECRETS_DIR="$SECRETS" PCC_BIND="$BIND" PCC_HOST_PORT="$PORT"

[[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "APD_NAME must be lowercase letters, digits, - or _" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
compose() { docker compose -p "$NAME" -f "$REPO/docker-compose.yml" "$@"; }
volume_exists() { docker volume inspect "$VOLUME" >/dev/null 2>&1; }
container() { compose ps -q dashboard 2>/dev/null; }
# Image for short helper containers (backup, restore, seeding): the one the instance runs, which also covers an
# instance first started by hand with another image name; otherwise this instance's own image.
tool_image() {
  local id img; id="$(compose ps -a -q dashboard 2>/dev/null | head -1)"
  if [ -n "$id" ]; then img="$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)"; fi
  for img in ${img:-} "$IMAGE"; do docker image inspect "$img" >/dev/null 2>&1 && { echo "$img"; return; }; done
  die "no image to run helper containers with; run '$0 up' first"
}
# Host to call for checks: the published address, or loopback when published on all addresses.
check_host() { case "$BIND" in 0.0.0.0|::|"") echo 127.0.0.1 ;; *) echo "$BIND" ;; esac; }

require_docker() {
  command -v docker >/dev/null || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
  docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running, and may this user use it?)"
}

# Asks the operator to type the instance name. Non-interactive callers pass --confirm NAME instead.
confirm_destructive() {
  local what="$1" given="${2:-}"
  if [ -z "$given" ]; then
    [ -r /dev/tty ] || die "$what needs confirmation: pass --confirm $NAME"
    printf '%s\nType the instance name (%s) to continue: ' "$what" "$NAME" > /dev/tty
    read -r given < /dev/tty
  fi
  [ "$given" = "$NAME" ] || die "confirmation did not match '$NAME'; nothing was changed"
}

ensure_secrets() {
  mkdir -p "$SECRETS"
  local token="$SECRETS/pcc_token.txt" cert="$SECRETS/tls_cert.pem" key="$SECRETS/tls_key.pem"
  if [ ! -f "$token" ]; then
    command -v openssl >/dev/null || die "openssl is needed to create the token and certificate"
    (umask 077; openssl rand -base64 33 | tr -d '\n=' | tr '+/' '-_' > "$token")
    say "created a new access token in $token (not shown; read it from the file to sign in)"
  fi
  if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
    [ ! -f "$cert" ] && [ ! -f "$key" ] || die "only one of tls_cert.pem / tls_key.pem exists in $SECRETS; fix or remove it"
    local san="DNS:localhost,IP:127.0.0.1"
    case "$BIND" in 127.0.0.1|0.0.0.0|::|"") ;; *) san="$san,IP:$BIND" ;; esac
    [ -n "${APD_TLS_NAMES:-}" ] && san="$san,$APD_TLS_NAMES"
    (umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" -addext "subjectAltName=$san" \
      -keyout "$key" -out "$cert" 2>/dev/null)
    touch "$SECRETS/.self-signed"
    say "created a self-signed certificate for $san (valid 365 days; browsers will warn)"
  fi
  # The certificate is public; the token and key are private.
  if [ -O "$token" ]; then chmod 600 "$token" "$key"; chmod 644 "$cert"; fi
  # The container runs as uid/gid 1000 and reads the files through Compose secrets, which keep host ownership. If the
  # operator is not uid 1000, the token and key get group 1000 and mode 640 (needs membership of that group, root or
  # sudo -n).
  if [ "$(uname -s)" = Linux ] && [ "$(stat -c %u "$token")" != 1000 ]; then
    if [ "$(stat -c %g "$token")" != 1000 ] || [ "$(stat -c %g "$key")" != 1000 ]; then
      chgrp 1000 "$token" "$key" 2>/dev/null || sudo -n chgrp 1000 "$token" "$key" 2>/dev/null \
        || die "the container user (uid/gid 1000) cannot read $token and $key. Run once:
  sudo chgrp 1000 $token $key && chmod 640 $token $key"
    fi
    chmod 640 "$token" "$key"
  fi
}

wait_healthy() {
  local id state i
  id="$(container)"; [ -n "$id" ] || die "the dashboard container is not running"
  for i in $(seq 1 60); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
    case "$state" in
      healthy) return 0 ;;
      unhealthy) break ;;
    esac
    sleep 2
  done
  docker logs --tail 20 "$id" >&2 || true
  die "the container did not become healthy (state: $state)"
}

# A self-signed certificate (generated here or brought along) is trusted explicitly; others go through the system store.
self_signed() {
  [ -f "$SECRETS/.self-signed" ] && return 0
  [ "$(openssl x509 -in "$SECRETS/tls_cert.pem" -noout -subject 2>/dev/null | sed 's/^subject=//')" =     "$(openssl x509 -in "$SECRETS/tls_cert.pem" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" ]
}
curl_tls() {
  if self_signed; then curl --cacert "$SECRETS/tls_cert.pem" "$@"; else curl "$@"; fi
}

cmd_health() {
  local auth="${1:-}" host url code body
  require_docker
  host="$(check_host)"; url="https://$host:$PORT"
  [ -n "$(container)" ] || die "the dashboard container is not running"
  wait_healthy; say "container: healthy"
  body="$(curl_tls -fsS --max-time 10 "$url/api/session")" || die "no HTTPS answer from $url/api/session"
  say "https: $url answers (auth required: $(printf '%s' "$body" | grep -o '"authRequired":[a-z]*' | cut -d: -f2))"
  code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://$host:$PORT/api/session" || true)"
  case "$code" in 000|400) say "plain http: refused (as intended)" ;; *) die "plain HTTP answered with $code; expected a refusal" ;; esac
  code="$(curl_tls -s -o /dev/null --max-time 10 -w '%{http_code}' "$url/api/projects")"
  [ "$code" = 401 ] || die "unauthenticated /api/projects returned $code; expected 401"
  say "unauthenticated api: 401 (as intended)"
  if [ "$auth" = "--auth" ]; then
    # The token goes through a private temp file, never the command line (visible to other users in ps).
    local hdr; hdr="$(umask 077; mktemp)"
    printf 'Authorization: Bearer %s\n' "$(cat "$SECRETS/pcc_token.txt")" > "$hdr"
    body="$(curl_tls -fsS --max-time 10 -H @"$hdr" "$url/api/projects")" || { rm -f "$hdr"; die "signed-in /api/projects failed"; }
    rm -f "$hdr"
    say "signed in: $(printf '%s' "$body" | grep -o '"id":"[^"]*"' | wc -l | tr -d ' ') project(s), diagnostics: $(printf '%s' "$body" | grep -o '"diagnosticsCount":[0-9]*' | cut -d: -f2)"
  fi
  say "health: OK"
}

seed_examples() {
  # Copies each example that is not there yet, as the container user; never overwrites a project folder.
  docker run --rm --user 1000:1000 --network none -v "$VOLUME:/data" -v "$REPO/examples/projects:/seed:ro" \
    --entrypoint sh "$(tool_image)" -c '
      mkdir -p /data/projects
      for d in /seed/*/; do
        n=$(basename "$d")
        if [ -e "/data/projects/$n" ]; then echo "example $n: already present, left unchanged"
        else cp -R "$d" "/data/projects/$n" && echo "example $n: added"; fi
      done'
}

cmd_up() {
  local demo="${1:-}"
  require_docker
  [ -z "$(container)" ] || die "instance '$NAME' is already running; use 'upgrade' to deploy new code (it backs up first)"
  ensure_secrets
  if volume_exists; then say "data volume $VOLUME exists: keeping its data"; else say "creating data volume $VOLUME"; fi
  compose build
  compose up -d
  wait_healthy
  [ "$demo" = "--demo" ] && seed_examples
  say "dashboard: https://$(check_host):$PORT  (sign in with the token in $SECRETS/pcc_token.txt)"
  [ "$BIND" = 127.0.0.1 ] || say "note: published on $BIND; read docs/DEPLOYMENT.md, Exposure checklist"
}

cmd_backup() {
  local stop="" dir="$BACKUPS"
  while [ $# -gt 0 ]; do case "$1" in --stop) stop=1 ;; --dir) dir="$2"; shift ;; *) die "unknown option $1" ;; esac; shift; done
  require_docker
  volume_exists || die "no data volume $VOLUME to back up"
  mkdir -p "$dir"; dir="$(cd "$dir" && pwd)"
  local file="${NAME}-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" running
  running="$(container)"
  if [ -n "$stop" ] && [ -n "$running" ]; then compose stop dashboard; fi
  docker run --rm --user 0:0 --network none -v "$VOLUME:/data:ro" -v "$dir:/backup" --entrypoint sh "$(tool_image)" -c \
    "tar -czf /backup/$file -C /data . && chown $(id -u):$(id -g) /backup/$file"
  if [ -n "$stop" ] && [ -n "$running" ]; then compose start dashboard; wait_healthy; fi
  (cd "$dir" && { command -v sha256sum >/dev/null && sha256sum "$file" || shasum -a 256 "$file"; } > "$file.sha256")
  say "backup: $dir/$file"
  BACKUP_FILE="$dir/$file"
}

# Checks a backup before anything is changed: readable gzip tar, checksum if present, only relative paths.
verify_archive() {
  local f="$1"
  [ -f "$f" ] || die "no such backup file: $f"
  if [ -f "$f.sha256" ]; then
    (cd "$(dirname "$f")" && { command -v sha256sum >/dev/null && sha256sum -c --quiet "$(basename "$f").sha256" || shasum -a 256 -c "$(basename "$f").sha256" >/dev/null; }) \
      || die "checksum mismatch for $f"
  fi
  local list; list="$(tar -tzf "$f")" || die "$f is not a readable .tar.gz"
  if printf '%s\n' "$list" | grep -Eq '^/|(^|/)\.\.(/|$)'; then die "$f contains absolute or parent paths; refusing"; fi
  printf '%s\n' "$list" | grep -Eq '^(\./)?projects/?$' || die "$f does not look like a dashboard backup (no projects/ folder)"
}

cmd_restore() {
  local file="" confirm=""
  while [ $# -gt 0 ]; do case "$1" in --confirm) confirm="$2"; shift ;; -*) die "unknown option $1" ;; *) file="$1" ;; esac; shift; done
  [ -n "$file" ] || die "usage: restore FILE [--confirm NAME]"
  require_docker
  verify_archive "$file"
  file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  confirm_destructive "Restore replaces ALL current data of instance '$NAME' with $file (a safety backup is taken first)." "$confirm"
  if volume_exists; then cmd_backup; say "safety backup of the replaced data: $BACKUP_FILE"; fi
  compose stop dashboard 2>/dev/null || true
  docker volume create "$VOLUME" >/dev/null
  docker run --rm --user 0:0 --network none -v "$VOLUME:/data" -v "$file:/restore.tar.gz:ro" --entrypoint sh "$(tool_image)" -c \
    'find /data -mindepth 1 -delete && tar -xzf /restore.tar.gz -C /data --no-same-owner && chown -R 1000:1000 /data'
  compose up -d
  wait_healthy
  say "restored $file into $NAME"
}

cmd_upgrade() {
  require_docker
  [ -n "$(container)" ] || die "instance '$NAME' is not running; use 'up' for a first deployment"
  volume_exists && cmd_backup
  docker image tag "$(tool_image)" "$IMAGE-previous"   # the image running now, whatever its name
  compose build
  compose up -d
  wait_healthy
  say "upgraded $NAME; data volume $VOLUME unchanged. To go back: $0 rollback"
}

cmd_rollback() {
  require_docker
  docker image inspect "$IMAGE-previous" >/dev/null 2>&1 || die "no previous image ($IMAGE-previous) to roll back to"
  docker image tag "$IMAGE-previous" "$IMAGE"
  compose up -d --no-build --force-recreate
  wait_healthy
  say "rolled back $NAME to the previous image; data volume $VOLUME unchanged"
}

cmd_reset() {
  local confirm=""
  while [ $# -gt 0 ]; do case "$1" in --confirm) confirm="$2"; shift ;; *) die "unknown option $1" ;; esac; shift; done
  require_docker
  confirm_destructive "Reset DELETES ALL DATA of instance '$NAME' (volume $VOLUME). A safety backup is taken first." "$confirm"
  volume_exists && { cmd_backup; say "safety backup: $BACKUP_FILE"; }
  compose down
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  say "instance '$NAME' reset: data deleted, secrets kept. Start again with: $0 up"
}

main() {
  local cmd="${1:-}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    up) cmd_up "$@" ;;
    health) cmd_health "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    upgrade) cmd_upgrade ;;
    rollback) cmd_rollback ;;
    status) require_docker; compose ps; volume_exists && say "data volume: $VOLUME" || say "data volume: none" ;;
    logs) require_docker; compose logs --tail "${1:-100}" dashboard ;;
    down) require_docker; compose down; say "stopped; data volume $VOLUME kept" ;;
    reset) cmd_reset "$@" ;;
    *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; [ -z "$cmd" ] || exit 2 ;;
  esac
}
main "$@"
