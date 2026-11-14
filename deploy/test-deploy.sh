#!/usr/bin/env bash
# End-to-end test of deploy/apd-deploy.sh against the local Docker daemon, in an isolated instance with its own
# volume, secrets and backups, published on loopback only. Removes everything it created at the end.
#   deploy/test-deploy.sh            (needs docker, docker compose, openssl, curl)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export APD_NAME="${APD_TEST_NAME:-apd-deploy-test}" APD_SECRETS_DIR="$WORK/secrets" APD_BACKUP_DIR="$WORK/backups"
free_port() { local p; for p in $(seq "${1:-18790}" 18890); do (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null || { echo "$p"; return; }; done; return 1; }
export PCC_BIND=127.0.0.1 PCC_HOST_PORT="${APD_TEST_PORT:-$(free_port)}"
D="$REPO/deploy/apd-deploy.sh"; chmod +x "$D" 2>/dev/null || true
VOL="${APD_NAME}_pcc-data"; IMG="agents-project-dashboard:${APD_NAME}"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "PASS  $*"; }
bad() { fail=$((fail+1)); echo "FAIL  $*"; }
LOG="$WORK/last.log"
check() { local d="$1"; shift; if "$@" >"$LOG" 2>&1; then ok "$d"; else bad "$d"; tail -n 15 "$LOG" | sed 's/^/      /'; fi; }
refuses() { local d="$1"; shift; if "$@" </dev/null >/dev/null 2>&1; then bad "$d (was allowed)"; else ok "$d"; fi; }
inside() { docker run --rm --network none -v "$VOL:/data" --entrypoint sh "$IMG" -c "$1"; }
projects() { "$D" health --auth | sed -n 's/^signed in: \([0-9]*\) project.*/\1/p'; }
cleanup() {
  docker compose -p "$APD_NAME" -f "$REPO/docker-compose.yml" down >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker image rm "$IMG" "$IMG-previous" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
[ ! "$(docker volume ls -q -f name="^${VOL}$")" ] || { echo "volume $VOL already exists; refusing to test over it" >&2; exit 2; }

echo "== clean deployment"
check "up creates secrets, builds and starts healthy" "$D" up
[ "$fail" = 0 ] || { echo "first deployment failed; stopping"; exit 1; }
mode="$(stat -c %a "$APD_SECRETS_DIR/pcc_token.txt" 2>/dev/null || stat -f %Lp "$APD_SECRETS_DIR/pcc_token.txt")"
case "$mode" in 600|640) ok "token file is private ($mode)" ;; *) bad "token file is private ($mode)" ;; esac
cmode="$(stat -c %a "$APD_SECRETS_DIR/tls_cert.pem" 2>/dev/null || stat -f %Lp "$APD_SECRETS_DIR/tls_cert.pem")"
[ "$cmode" = 644 ] && ok "certificate readable by the container user (644)" || bad "certificate readable by the container user ($cmode)"
check "health passes (TLS, plain HTTP refused, 401 without token)" "$D" health
[ "$(projects)" = 0 ] && ok "clean deployment has no projects" || bad "clean deployment has no projects"
refuses "up refuses while running (no silent upgrade)" "$D" up
# -F and -- : the token is data, never a pattern or an option (a token starting with "-" must not reach grep's parser).
if "$D" health --auth 2>&1 | grep -qF -- "$(cat "$APD_SECRETS_DIR/pcc_token.txt")"; then bad "token never printed"; else ok "token never printed"; fi

echo "== demo deployment keeps data"
"$D" down >/dev/null
check "demo up" "$D" up --demo
[ "$(projects)" = 2 ] && ok "demo has the 2 example projects" || bad "demo has the 2 example projects"
inside 'echo kept > /data/projects/lantern-web-app/marker.txt && echo changed > /data/projects/tidepool-notebook/README.local'
"$D" down >/dev/null; "$D" up --demo >/dev/null
check "re-running demo up keeps existing project files" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'

echo "== backup"
check "backup" "$D" backup
B="$(ls -1t "$APD_BACKUP_DIR"/*.tar.gz | head -1)"
check "backup has a checksum file" test -s "$B.sha256"
check "backup holds project data" sh -c "tar -tzf '$B' | grep -q lantern-web-app/marker.txt"
check "backup with --stop" "$D" backup --stop
check "service healthy after --stop backup" "$D" health

echo "== upgrade and rollback keep data"
check "upgrade" "$D" upgrade
check "data kept after upgrade" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'
check "previous image kept for rollback" docker image inspect "$IMG-previous"
check "rollback" "$D" rollback
check "data kept after rollback" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'

echo "== restore"
inside 'rm /data/projects/lantern-web-app/marker.txt'
refuses "restore without confirmation is refused" "$D" restore "$B"
refuses "restore with the wrong name is refused" "$D" restore "$B" --confirm wrong
check "data untouched by refused restores" inside '! test -e /data/projects/lantern-web-app/marker.txt'
before=$(ls "$APD_BACKUP_DIR"/*.tar.gz | wc -l)
check "restore with confirmation" "$D" restore "$B" --confirm "$APD_NAME"
check "restored data is back" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'
[ "$(ls "$APD_BACKUP_DIR"/*.tar.gz | wc -l)" -gt "$before" ] && ok "restore took a safety backup first" || bad "restore took a safety backup first"
check "restored files belong to the service user" inside '[ "$(stat -c %u /data/projects/lantern-web-app/project.json)" = 1000 ]'
check "health after restore" "$D" health --auth
cp "$B" "$WORK/tampered.tar.gz"; echo "00  x" > "$WORK/tampered.tar.gz.sha256"
refuses "restore refuses a checksum mismatch" "$D" restore "$WORK/tampered.tar.gz" --confirm "$APD_NAME"
mkdir -p "$WORK/evil/projects"; echo x > "$WORK/evil/projects/f"; tar -czPf "$WORK/evil.tar.gz" "$WORK/evil/projects" "$WORK/evil/projects/f"
refuses "restore refuses absolute paths" "$D" restore "$WORK/evil.tar.gz" --confirm "$APD_NAME"
tar -czf "$WORK/other.tar.gz" -C "$WORK/evil/projects" f
refuses "restore refuses an archive that is not a dashboard backup" "$D" restore "$WORK/other.tar.gz" --confirm "$APD_NAME"
check "data intact after refused restores" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'

echo "== reset"
refuses "reset without confirmation is refused" "$D" reset
refuses "reset with the wrong name is refused" "$D" reset --confirm nope
check "data intact after refused resets" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'
before=$(ls "$APD_BACKUP_DIR"/*.tar.gz | wc -l)
check "reset with confirmation" "$D" reset --confirm "$APD_NAME"
[ "$(ls "$APD_BACKUP_DIR"/*.tar.gz | wc -l)" -gt "$before" ] && ok "reset took a safety backup first" || bad "reset took a safety backup first"
check "volume removed" sh -c "! docker volume inspect '$VOL'"
check "secrets kept" test -s "$APD_SECRETS_DIR/pcc_token.txt"
check "up after reset" "$D" up
[ "$(projects)" = 0 ] && ok "empty after reset" || bad "empty after reset"

echo; echo "$pass passed, $fail failed  (platform: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}'))"
[ "$fail" = 0 ]
