#!/usr/bin/env bash
# Zero-downtime rolling update for ONE deployed rgoe box (T-DEPLOY-6).
#
# Updates the code at $RGOE_DIR to a new git ref and restarts the three systemd
# units (rgoe-bootnode, rgoe-gateway, rgoe-heartbeat) in a SAFE order, with a
# health wait between each so a broken update is caught before it takes the next
# service down. Run it ON the box, or drive it over ssh:
#
#     ssh root@<droplet> 'sudo bash /opt/rgoe/bootnode/deploy/rolling-update.sh <new-ref>'
#     # or, on the box:
#     sudo bash /opt/rgoe/bootnode/deploy/rolling-update.sh v1.2.3
#
# Why a single box's brief restart is safe for clients: the gateway and bootnode
# sit behind Tor v3 onions, and clients do weighted rotation + failover and cache
# a last-known-good directory (see docs/BOOTNODE.md "Liveness"). The bootnode
# additionally reloads its persisted live-set on boot (RGOE_BOOTNODE_STORE,
# T-DEV-4), so the fleet view survives a restart instead of blanking. A few
# seconds of one box bouncing is absorbed by cache + failover.
#
# Core flow: capture the CURRENT ref  ->  update  ->  staged restart w/ health
# gates  ->  verify (services active, bootnode /health ok on loopback AND over
# Tor, onion still resolves). If anything fails, the exact one-line rollback
# (checkout the previous ref + reinstall + restart) is printed. The previous ref
# is captured and pinned as a git tag BEFORE the update, so rollback is reliable
# even against a shallow clone.
#
# Multi-box fleets: this script handles ONE box. For the fleet-wide drain ->
# update -> rejoin sequencing that keeps healthy gateways serving throughout,
# see bootnode/deploy/ROLLING-UPDATE.md.
#
# Idempotent + non-destructive: reuses the existing onions and deploy-state
# (keys, signer, persistence store) -- it never touches deploy-state. Re-running
# with the same ref is a no-op update followed by a clean restart.
#
# Tunables (env), matching bootstrap.sh:
#   RGOE_REF            new branch/tag/sha to update to (or pass as $1)
#   RGOE_REPO           git remote                 (default: origin's URL)
#   RGOE_DIR            install dir                (default: /opt/rgoe)
#   RGOE_BOOTNODE_PORT  bootnode loopback backend  (default: 8877)
#   RGOE_GATEWAY_PORT   gateway  loopback backend  (default: 8443)
#   RGOE_TOR_PORT       local Tor SOCKS port       (default: 9050)
#   RGOE_HEALTH_TIMEOUT per-service health wait, s  (default: 60)
#   RGOE_ONION_TIMEOUT  onion /health wait, s       (default: 120)
set -euo pipefail

RGOE_DIR="${RGOE_DIR:-/opt/rgoe}"
RGOE_BOOTNODE_PORT="${RGOE_BOOTNODE_PORT:-8877}"
RGOE_GATEWAY_PORT="${RGOE_GATEWAY_PORT:-8443}"
RGOE_TOR_PORT="${RGOE_TOR_PORT:-9050}"
RGOE_HEALTH_TIMEOUT="${RGOE_HEALTH_TIMEOUT:-60}"
RGOE_ONION_TIMEOUT="${RGOE_ONION_TIMEOUT:-120}"
# The ref to move to: positional arg wins, else RGOE_REF env.
NEW_REF="${1:-${RGOE_REF:-}}"

BOOTNODE_UNIT="rgoe-bootnode"
GATEWAY_UNIT="rgoe-gateway"
HEARTBEAT_UNIT="rgoe-heartbeat"

log()  { echo -e "\n\033[1;36m== $*\033[0m"; }
warn() { echo -e "\033[1;33mWARN: $*\033[0m" >&2; }
die()  { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run as root or with sudo (restarts systemd units, writes ${RGOE_DIR})"
command -v git        >/dev/null || die "git not found"
command -v systemctl  >/dev/null || die "systemctl not found (is this a systemd host?)"
command -v curl       >/dev/null || die "curl not found"
[ -d "$RGOE_DIR/.git" ] || die "no git repo at ${RGOE_DIR} -- run bootstrap.sh first"
[ -n "$NEW_REF" ] || die "no ref given. Usage: sudo bash $0 <branch|tag|sha>   (or set RGOE_REF)"

# Remote defaults to whatever origin already points at (bootstrap set it).
RGOE_REPO="${RGOE_REPO:-$(git -C "$RGOE_DIR" remote get-url origin 2>/dev/null || true)}"

# ---------------------------------------------------------------------------
# Capture the CURRENT ref BEFORE we touch anything, and pin it so rollback is
# guaranteed reachable even on a shallow clone (bootstrap clones --depth 1).
# ---------------------------------------------------------------------------
PREV_SHA="$(git -C "$RGOE_DIR" rev-parse HEAD)"
PREV_DESC="$(git -C "$RGOE_DIR" describe --always --tags --dirty 2>/dev/null || echo "$PREV_SHA")"
ROLLBACK_TAG="rgoe-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
# -f: idempotent if a tag of this name somehow already exists. Tagging keeps the
# old commit object reachable so `checkout $PREV_SHA` still works after a shallow
# fetch that would otherwise let it be pruned.
git -C "$RGOE_DIR" tag -f "$ROLLBACK_TAG" "$PREV_SHA" >/dev/null

# The one-liner an operator runs to undo this update. Printed on ANY failure
# below (via the ERR trap) and again in the success banner for reference.
ROLLBACK_CMD="git -C ${RGOE_DIR} checkout -q ${PREV_SHA} && ( cd ${RGOE_DIR} && npm install --omit=dev --no-audit --no-fund ) && systemctl restart ${BOOTNODE_UNIT} ${GATEWAY_UNIT} ${HEARTBEAT_UNIT}"

print_rollback() {
  cat >&2 <<EOF

------------------------------------------------------------------------
ROLLBACK (restores the pre-update ref ${PREV_DESC} and restarts the fleet):

  sudo ${ROLLBACK_CMD}

(the previous commit is also pinned as tag ${ROLLBACK_TAG} in ${RGOE_DIR})
------------------------------------------------------------------------
EOF
}
# Any unhandled failure under `set -e` prints the rollback recipe, then exits.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo -e "\n\033[1;31m== update FAILED (exit $rc)\033[0m" >&2; print_rollback; fi' EXIT

log "rolling update on this box"
echo "  install dir : ${RGOE_DIR}"
echo "  current ref : ${PREV_DESC} (${PREV_SHA})"
echo "  new ref     : ${NEW_REF}"
echo "  remote      : ${RGOE_REPO:-<none set>}"

# ---------------------------------------------------------------------------
# Health helpers
# ---------------------------------------------------------------------------

# Poll the bootnode loopback /health until it reports ok, or timeout. The
# bootnode is a plain HTTP service bound to 127.0.0.1:$RGOE_BOOTNODE_PORT, so we
# can hit it directly (no Tor) for a fast, authoritative liveness gate.
wait_bootnode_health() {
  local deadline=$(( SECONDS + RGOE_HEALTH_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${RGOE_BOOTNODE_PORT}/health" 2>/dev/null \
         | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# systemctl is-active with a short retry window (units are Restart=always, so a
# just-restarted process may take a beat to be reported active).
wait_active() {
  local unit="$1" deadline=$(( SECONDS + RGOE_HEALTH_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if systemctl is-active --quiet "$unit"; then return 0; fi
    sleep 2
  done
  return 1
}

# The gateway is a raw TCP/TLS tunnel (net.createServer), not HTTP -- there is no
# /health to curl. Liveness = unit active AND the loopback backend is accepting
# connections. Use bash's /dev/tcp so we need no extra tooling.
wait_gateway_ready() {
  wait_active "$GATEWAY_UNIT" || return 1
  local deadline=$(( SECONDS + RGOE_HEALTH_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if timeout 3 bash -c ": >/dev/tcp/127.0.0.1/${RGOE_GATEWAY_PORT}" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# 1. Update the code (mirrors bootstrap.sh: fetch the ref, checkout, install).
#    --depth 100 (not 1) leaves headroom; the rollback tag above is the real
#    guarantee the previous commit survives. deploy-state is never touched.
# ---------------------------------------------------------------------------
log "fetch + checkout ${NEW_REF}"
if git -C "$RGOE_DIR" fetch --tags --depth 100 origin "$NEW_REF" -q; then
  git -C "$RGOE_DIR" checkout -q FETCH_HEAD
else
  # Fallback: full fetch, then resolve the ref by name (branch/tag/sha).
  git -C "$RGOE_DIR" fetch --tags origin -q
  git -C "$RGOE_DIR" checkout -q "$NEW_REF"
fi
NEW_SHA="$(git -C "$RGOE_DIR" rev-parse HEAD)"
NEW_DESC="$(git -C "$RGOE_DIR" describe --always --tags --dirty 2>/dev/null || echo "$NEW_SHA")"
echo "  now at: ${NEW_DESC} (${NEW_SHA})"
if [ "$NEW_SHA" = "$PREV_SHA" ]; then
  warn "new ref resolves to the same commit as before -- restarting services anyway"
fi

log "npm install --omit=dev"
( cd "$RGOE_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || die "npm install failed at ${NEW_DESC}"

# ---------------------------------------------------------------------------
# 2. Staged restart in SAFE order, health-gated between each step:
#      bootnode  -> gateway -> heartbeat
#
#    bootnode FIRST: it reloads its persisted live-set (RGOE_BOOTNODE_STORE) on
#    boot, so the fleet directory survives the bounce. Bringing it up (and
#    confirming /health) before the gateway means the gateway's heartbeat has a
#    live bootnode to re-announce to.
#
#    gateway SECOND: the actual egress. We confirm the unit is active and the
#    loopback backend accepts a TCP connection before proceeding.
#
#    heartbeat LAST: re-announces the (now-updated) gateway to the bootnode.
#    Restarting it last means it announces against an already-healthy pair.
#
#    A failed health wait aborts here (ERR trap prints rollback) so a broken
#    update never cascades past the first service.
# ---------------------------------------------------------------------------
log "restart ${BOOTNODE_UNIT} (reloads persisted fleet state)"
systemctl restart "$BOOTNODE_UNIT"
wait_bootnode_health || die "${BOOTNODE_UNIT} did not report /health ok within ${RGOE_HEALTH_TIMEOUT}s -- see: journalctl -u ${BOOTNODE_UNIT} -n 50"
echo "  bootnode healthy on 127.0.0.1:${RGOE_BOOTNODE_PORT}"

log "restart ${GATEWAY_UNIT} (egress)"
systemctl restart "$GATEWAY_UNIT"
wait_gateway_ready || die "${GATEWAY_UNIT} not active/accepting on 127.0.0.1:${RGOE_GATEWAY_PORT} within ${RGOE_HEALTH_TIMEOUT}s -- see: journalctl -u ${GATEWAY_UNIT} -n 50"
echo "  gateway active + accepting on 127.0.0.1:${RGOE_GATEWAY_PORT}"

log "restart ${HEARTBEAT_UNIT} (re-announce gateway to bootnode)"
systemctl restart "$HEARTBEAT_UNIT"
wait_active "$HEARTBEAT_UNIT" || die "${HEARTBEAT_UNIT} not active within ${RGOE_HEALTH_TIMEOUT}s -- see: journalctl -u ${HEARTBEAT_UNIT} -n 50"
echo "  heartbeat active"

# ---------------------------------------------------------------------------
# 3. Post-update verification.
#    - all three units active
#    - bootnode /health ok on loopback (already gated above; re-checked)
#    - bootnode /health ok OVER THE ONION via local Tor SOCKS (proves the onion
#      still resolves and the descriptor is still published; tor was NOT
#      restarted and the onion is reused, so this should come back quickly)
# ---------------------------------------------------------------------------
log "verify"
for u in "$BOOTNODE_UNIT" "$GATEWAY_UNIT" "$HEARTBEAT_UNIT"; do
  systemctl is-active --quiet "$u" || die "${u} is not active after update"
  echo "  active: ${u}"
done

wait_bootnode_health || die "bootnode /health not ok on loopback after update"
echo "  bootnode /health ok (loopback)"

# Onion reachability check over Tor. The onion address is reused from
# deploy-state; read it from the bootnode HS hostname file.
BN_ONION=""
if [ -f "${RGOE_DIR}/deploy-state/bootnode-hs/hostname" ]; then
  BN_ONION="$(cat "${RGOE_DIR}/deploy-state/bootnode-hs/hostname")"
fi
if [ -n "$BN_ONION" ]; then
  echo "  checking onion http://${BN_ONION}/health over Tor SOCKS 127.0.0.1:${RGOE_TOR_PORT} (up to ${RGOE_ONION_TIMEOUT}s)..."
  onion_ok=0
  onion_deadline=$(( SECONDS + RGOE_ONION_TIMEOUT ))
  while [ "$SECONDS" -lt "$onion_deadline" ]; do
    if curl -fsS --max-time 15 --socks5-hostname "127.0.0.1:${RGOE_TOR_PORT}" \
         "http://${BN_ONION}/health" 2>/dev/null \
         | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      onion_ok=1; break
    fi
    sleep 5
  done
  if [ "$onion_ok" -eq 1 ]; then
    echo "  bootnode onion resolves + /health ok over Tor"
  else
    die "bootnode onion ${BN_ONION} did not answer /health over Tor within ${RGOE_ONION_TIMEOUT}s (services are up on loopback; the onion may just need more descriptor time -- re-check: curl --socks5-hostname 127.0.0.1:${RGOE_TOR_PORT} http://${BN_ONION}/health)"
  fi
else
  warn "no bootnode onion hostname at ${RGOE_DIR}/deploy-state/bootnode-hs/hostname -- skipping the over-Tor onion check (is this box the bootnode?)"
fi

# ---------------------------------------------------------------------------
# Success. Disarm the failure trap and print a clean banner (rollback recipe
# included for reference in case a problem surfaces after the fact).
# ---------------------------------------------------------------------------
trap - EXIT
cat <<EOF

========================================================================
rolling update complete on this box.

  from : ${PREV_DESC} (${PREV_SHA})
  to   : ${NEW_DESC} (${NEW_SHA})

  bootnode : active, /health ok (loopback${BN_ONION:+ + onion})
  gateway  : active, accepting on 127.0.0.1:${RGOE_GATEWAY_PORT}
  heartbeat: active (re-announcing)

If a problem surfaces, roll back with:
  sudo ${ROLLBACK_CMD}
  # previous commit is pinned as tag ${ROLLBACK_TAG}

Multi-box fleet? Update gateways ONE AT A TIME -- see
${RGOE_DIR}/bootnode/deploy/ROLLING-UPDATE.md
========================================================================
EOF
