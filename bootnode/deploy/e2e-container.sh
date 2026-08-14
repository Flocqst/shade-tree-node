#!/usr/bin/env bash
# End-to-end test of bootnode/deploy/bootstrap.sh inside a throwaway Ubuntu 24.04
# container running REAL systemd -- the same code path a fresh droplet takes.
#
#   bash bootnode/deploy/e2e-container.sh
#
# What it does:
#   1. boots ubuntu:24.04 as a --privileged container with systemd as PID 1
#      (bootstrap.sh drives systemctl; a plain `docker run` has no init, so we
#       give it one -- see bootnode/deploy/E2E-CONTAINER.md for the rationale),
#   2. runs bootstrap.sh against THIS checkout (cloned from a read-only bind mount,
#      not from GitHub, so you test your working branch, not origin),
#   3. asserts tor + the rgoe units are active, both onion hostname files were
#      written, and the bootnode answers /health on loopback,
#   4. best-effort: dials the bootnode onion over Tor SOCKS (needs live descriptor
#      propagation; NON-fatal, reported either way).
#
# Requires: docker, a Linux kernel that can run systemd in a privileged container
# (works on GitHub Actions ubuntu-latest and on Docker Desktop / colima on macOS).
# The container is force-removed on exit.
#
# Tunables (env): RGOE_REF (branch/tag to clone; auto-detected), E2E_IMAGE
# (default ubuntu:24.04), E2E_KEEP=1 (leave the container running for inspection).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"          # repo root
IMAGE="${E2E_IMAGE:-ubuntu:24.04}"
CONTAINER="rgoe-e2e-$$"
BOOTNODE_PORT="${RGOE_BOOTNODE_PORT:-8877}"
GATEWAY_PORT="${RGOE_GATEWAY_PORT:-8443}"

log()  { echo -e "\n\033[1;36m== $*\033[0m"; }
fail() { echo -e "\033[1;31mFAIL: $*\033[0m" >&2; exit 1; }

command -v docker >/dev/null || fail "docker not found on PATH"
docker info >/dev/null 2>&1 || fail "docker daemon not reachable (start Docker Desktop / dockerd)"

# The ref to clone into the container. bootstrap.sh clones RGOE_REPO@RGOE_REF, so we
# point it at the bind-mounted repo and hand it a ref that EXISTS there. On a branch we
# use that branch; in detached HEAD (CI PR merge ref) we mint a throwaway tag at HEAD.
REF="${RGOE_REF:-$(git -C "$SRC" symbolic-ref --quiet --short HEAD || true)}"
CREATED_TAG=""
if [ -z "$REF" ]; then
  REF="rgoe-e2e-head"
  git -C "$SRC" tag -f "$REF" HEAD >/dev/null
  CREATED_TAG="$REF"
fi

cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    echo "E2E_KEEP=1 -> leaving container $CONTAINER up (docker rm -f $CONTAINER to remove)"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  [ -n "$CREATED_TAG" ] && git -C "$SRC" tag -d "$CREATED_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "boot ubuntu container with systemd as PID 1 ($IMAGE)"
# Install systemd first, then exec it as PID 1 so it owns cgroup/unit management.
# --privileged + host cgroup namespace + a writable cgroupfs is what lets systemd run.
docker run -d --name "$CONTAINER" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "$SRC":/mnt/src:ro \
  "$IMAGE" \
  bash -c 'export DEBIAN_FRONTEND=noninteractive;
           apt-get update -qq >/dev/null 2>&1;
           apt-get install -y -qq systemd systemd-sysv >/dev/null 2>&1;
           exec /lib/systemd/systemd' >/dev/null

log "wait for systemd to come up"
ok=0
for _ in $(seq 1 60); do
  state="$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in
    running|degraded|starting) ok=1; [ "$state" = "starting" ] || break ;;
  esac
  sleep 2
done
[ "$ok" = "1" ] || { docker logs "$CONTAINER" 2>&1 | tail -30; fail "systemd never came up in container"; }
docker exec "$CONTAINER" systemctl is-system-running || true

log "run bootstrap.sh inside the container (clone file:///mnt/src @ $REF)"
docker exec \
  -e RGOE_REPO="file:///mnt/src" \
  -e RGOE_REF="$REF" \
  -e RGOE_ADMISSION="open" \
  -e RGOE_BOOTNODE_PORT="$BOOTNODE_PORT" \
  -e RGOE_GATEWAY_PORT="$GATEWAY_PORT" \
  "$CONTAINER" bash /mnt/src/bootnode/deploy/bootstrap.sh

log "assert services + onions"
docker exec -i "$CONTAINER" env BN_PORT="$BOOTNODE_PORT" GW_PORT="$GATEWAY_PORT" bash -s <<'CHECK'
set -euo pipefail
echo "-- unit state --"
systemctl is-active tor           || { journalctl -u tor           --no-pager | tail -20; exit 1; }
systemctl is-active rgoe-bootnode || { journalctl -u rgoe-bootnode --no-pager | tail -20; exit 1; }
systemctl is-active rgoe-gateway  || { journalctl -u rgoe-gateway  --no-pager | tail -20; exit 1; }

echo "-- onion hostname files --"
for hs in rgoe-bootnode rgoe-gateway; do
  f="/var/lib/tor/$hs/hostname"
  test -s "$f" || { echo "missing/empty $f"; exit 1; }
  grep -qE '\.onion$' "$f" || { echo "no .onion in $f"; cat "$f"; exit 1; }
  echo "$hs -> $(cat "$f")"
done

echo "-- bootnode /health on loopback --"
curl -fsS --max-time 5 "http://127.0.0.1:${BN_PORT}/health" ; echo

echo "-- gateway TCP listener on loopback --"
timeout 3 bash -c ":</dev/tcp/127.0.0.1/${GW_PORT}" && echo "gateway :${GW_PORT} accepting connections"
CHECK

log "best-effort: reach the bootnode onion over Tor (non-fatal)"
BN_ONION="$(docker exec "$CONTAINER" cat /var/lib/tor/rgoe-bootnode/hostname | tr -d '[:space:]')"
if docker exec "$CONTAINER" bash -c \
     "curl -fsS --socks5-hostname 127.0.0.1:9050 --max-time 90 http://${BN_ONION}/health >/dev/null"; then
  echo "OK: bootnode onion $BN_ONION answered /health over Tor"
else
  echo "NOTE: onion not reachable over Tor within timeout (descriptor propagation / egress);"
  echo "      loopback /health + hostname files already proved the node published. Non-fatal."
fi

log "PASS -- bootstrap.sh brought the fleet up in the container"
