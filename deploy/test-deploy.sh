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
# Output is captured whole before searching: with pipefail, grep -q exiting early can fail the producer (SIGPIPE).
out="$("$D" health --auth 2>&1 || true)"
if grep -qF -- "$(cat "$APD_SECRETS_DIR/pcc_token.txt")" <<<"$out"; then bad "token never printed"; else ok "token never printed"; fi

echo "== scoped agent tokens"
AT="$APD_SECRETS_DIR/agent_tokens.json"
amode="$(stat -c %a "$AT" 2>/dev/null || stat -f %Lp "$AT")"
case "$amode" in 600|640) ok "agent token list created and private ($amode)" ;; *) bad "agent token list created and private ($amode)" ;; esac
grep -q '"tokens": \[\]' "$AT" && ok "agent token list starts empty" || bad "agent token list starts empty"
agent_code() { curl -sk -o /dev/null -w '%{http_code}' -H @"$WORK/agent.hdr" "https://127.0.0.1:$PCC_HOST_PORT$1"; }
atok="$(openssl rand -hex 24)"; (umask 077; printf 'Authorization: Bearer %s\n' "$atok" > "$WORK/agent.hdr")
[ "$(agent_code /api/projects)" = 401 ] && ok "a token not in the list is refused (401)" || bad "a token not in the list is refused (401)"
ahash="$(printf '%s' "$atok" | openssl dgst -sha256 -r | cut -d' ' -f1)"
printf '{ "schemaVersion": 1, "tokens": [ { "name": "deploy-test-agent", "sha256": "%s", "projects": ["lantern-web-app"], "scopes": ["read"] } ] }\n' "$ahash" > "$AT"
check "restart picks up the edited agent token list" "$D" restart
check "agent token list kept by restart" grep -q deploy-test-agent "$AT"
"$D" down >/dev/null; "$D" up --demo >/dev/null
n=""; for _ in $(seq 30); do n="$(agent_code /api/projects/lantern-web-app/capabilities)"; [ "$n" = 200 ] && break; sleep 1; done
[ "$n" = 200 ] && ok "agent token reads its own project" || bad "agent token reads its own project ($n)"
[ "$(agent_code /api/projects/tidepool-notebook/capabilities)" = 404 ] && ok "agent token cannot see another project (404)" || bad "agent token cannot see another project"
printf '{ "schemaVersion": 1, "tokens": [] }\n' > "$AT"; "$D" restart >/dev/null
[ "$(agent_code /api/projects/lantern-web-app/capabilities)" = 401 ] && ok "a removed agent token is refused after restart" || bad "a removed agent token is refused after restart"
# A raw token pasted into the list instead of an entry: the server refuses to start and never logs the file's content.
printf '%s\n' "$atok" > "$AT"
refuses "restart with a malformed agent token list fails" "$D" restart
out="$(docker logs "$(docker compose -p "$APD_NAME" -f "$REPO/docker-compose.yml" ps -a -q dashboard)" 2>&1 || true)"
grep -q "agentTokensFile invalid" <<<"$out" && ok "malformed list: the log names the problem" || bad "malformed list: the log names the problem"
if grep -qF -- "$atok" <<<"$out"; then bad "malformed list: its content is not logged"; else ok "malformed list: its content is not logged"; fi
printf '{ "schemaVersion": 1, "tokens": [] }\n' > "$AT"
check "restart after fixing the list" "$D" restart
# Without the deploy script, a missing list stops Compose before anything starts.
"$D" down >/dev/null; mv "$AT" "$AT.away"
refuses "plain compose without agent_tokens.json is refused" env APD_IMAGE="$IMG" docker compose -p "$APD_NAME" -f "$REPO/docker-compose.yml" up -d --no-build
mv "$AT.away" "$AT"
"$D" down >/dev/null; inside 'rm -rf /data/projects/*'; "$D" up >/dev/null

echo "== demo deployment keeps data"
"$D" down >/dev/null
check "demo up" "$D" up --demo
# The examples are copied in after the server is up; its watcher indexes them a moment later.
want="$(find "$REPO/examples/projects" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
n=""; for _ in $(seq 30); do n="$(projects)"; [ "$n" = "$want" ] && break; sleep 1; done
[ "$want" -ge 2 ] && [ "$n" = "$want" ] && ok "demo has all $want example projects" || bad "demo has all $want example projects (saw: $n)"
inside 'echo kept > /data/projects/lantern-web-app/marker.txt && echo changed > /data/projects/tidepool-notebook/README.local'
"$D" down >/dev/null; "$D" up --demo >/dev/null
check "re-running demo up keeps existing project files" inside 'grep -q kept /data/projects/lantern-web-app/marker.txt'

echo "== login modes"
code() { curl -sk -o /dev/null -w '%{http_code}' "$@" "https://127.0.0.1:$PCC_HOST_PORT/api/projects"; }
"$D" down >/dev/null
refuses "local-network without trusted networks is refused" env PCC_AUTH_MODE=local-network "$D" up
refuses "disabled without confirmation is refused" env PCC_AUTH_MODE=disabled "$D" up
refuses "disabled with the wrong confirmation is refused" env PCC_AUTH_MODE=disabled APD_CONFIRM_AUTH_DISABLED=nope "$D" up
refuses "an unknown login mode is refused" env PCC_AUTH_MODE=open "$D" up
check "local-network with an explicit range starts" env PCC_AUTH_MODE=local-network PCC_TRUSTED_NETWORKS=192.0.2.0/24 "$D" up
[ "$(code)" = 401 ] && ok "local-network: a client outside the range needs the token" || bad "local-network: a client outside the range needs the token"
[ "$(code -H 'X-Forwarded-For: 192.0.2.5')" = 401 ] && ok "local-network: a forged X-Forwarded-For is ignored" || bad "local-network: a forged X-Forwarded-For is ignored"
check "local-network: signing in with the token works" "$D" health --auth
"$D" down >/dev/null
check "disabled with confirmation starts" env PCC_AUTH_MODE=disabled APD_CONFIRM_AUTH_DISABLED="$APD_NAME" "$D" up
[ "$(code)" = 200 ] && ok "disabled: the API answers without a token" || bad "disabled: the API answers without a token"
[ "$(code -H 'Host: attacker.example')" = 401 ] && ok "disabled: an unknown Host name is refused (DNS rebinding)" || bad "disabled: an unknown Host name is refused"
out="$("$D" logs 200 2>&1 || true)"
if grep -q "AUTHENTICATION IS DISABLED" <<<"$out"; then ok "disabled: the server log warns"; else bad "disabled: the server log warns"; fi
"$D" down >/dev/null
check "back to the default (login required)" "$D" up
check "default: 401 without token again" "$D" health

echo "== backup"
check "backup" "$D" backup
B="$(ls -1t "$APD_BACKUP_DIR"/*.tar.gz | head -1)"
check "backup has a checksum file" test -s "$B.sha256"
check "backup holds project data" sh -c "tar -tzf '$B' | grep -q lantern-web-app/marker.txt"
check "backup with --stop" "$D" backup --stop
check "service healthy after --stop backup" "$D" health

echo "== upgrade and rollback keep data"
# An instance set up before the agent token list existed has no agent_tokens.json; upgrade must create it.
rm "$APD_SECRETS_DIR/agent_tokens.json"
check "upgrade" "$D" upgrade
check "upgrade creates a missing agent token list" test -s "$APD_SECRETS_DIR/agent_tokens.json"
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
check "agent token list kept" test -s "$APD_SECRETS_DIR/agent_tokens.json"
check "up after reset" "$D" up
[ "$(projects)" = 0 ] && ok "empty after reset" || bad "empty after reset"

echo "== upgrade of an instance started by hand (other image name)"
"$D" reset --confirm "$APD_NAME" >/dev/null
APD_IMAGE="$IMG-manual" docker compose -p "$APD_NAME" -f "$REPO/docker-compose.yml" up -d --build >/dev/null 2>&1
check "hand-started instance is up" sh -c "sleep 20; docker inspect -f '{{.State.Health.Status}}' \$(docker compose -p '$APD_NAME' -f '$REPO/docker-compose.yml' ps -q dashboard) | grep -Eq 'healthy|starting'"
docker run --rm --network none -v "$VOL:/data" --entrypoint sh "$IMG-manual" -c 'mkdir -p /data/projects/hand && echo kept > /data/projects/hand/marker.txt'
check "upgrade works on it (backs up with the running image)" "$D" upgrade
check "data kept after upgrading the hand-started instance" inside 'grep -q kept /data/projects/hand/marker.txt'
check "rollback target is the hand-started image" test "$(docker image inspect -f '{{.Id}}' "$IMG-previous")" = "$(docker image inspect -f '{{.Id}}' "$IMG-manual")"
docker image rm "$IMG-manual" >/dev/null 2>&1 || true

echo; echo "$pass passed, $fail failed  (platform: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}'))"
[ "$fail" = 0 ]
