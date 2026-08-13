#!/usr/bin/env bash
# Bring a FRESH Ubuntu 24.04 droplet up as a reputation-gated onion egress bootnode +
# gateway, in one idempotent command. You rent the box; this does the rest.
#
#   ssh root@<droplet>            # or a sudo user
#   curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/feat/bootnode-and-productionize/bootnode/deploy/bootstrap.sh | sudo bash
#   # or, if you already cloned the repo on the box:
#   sudo bash bootnode/deploy/bootstrap.sh
#
# It installs Node + Tor (from the official Tor Project repo, so `pow: yes` is available),
# mints the bootnode and gateway onion identities, writes systemd units, starts everything,
# and prints the bootnode onion + pinned signer + gateway onion + the exact client command.
# Re-running it is safe: existing keys/units are reused, not regenerated.
#
# Tunables (env):
#   RGOE_REPO        git URL            (default: the public repo)
#   RGOE_REF         branch/tag/sha     (default: feat/bootnode-and-productionize)
#   RGOE_DIR         install dir        (default: /opt/rgoe)
#   RGOE_ADMISSION   open | stake       (default: open)
#   RGOE_BOOTNODE_PORT / RGOE_GATEWAY_PORT   loopback backends (default 8877 / 8443)
set -euo pipefail

RGOE_REPO="${RGOE_REPO:-https://github.com/dmarzzz/reputation-gated-onion-egress}"
RGOE_REF="${RGOE_REF:-feat/bootnode-and-productionize}"
RGOE_DIR="${RGOE_DIR:-/opt/rgoe}"
RGOE_ADMISSION="${RGOE_ADMISSION:-open}"
RGOE_BOOTNODE_PORT="${RGOE_BOOTNODE_PORT:-8877}"
RGOE_GATEWAY_PORT="${RGOE_GATEWAY_PORT:-8443}"
RUN_USER="${RGOE_USER:-rgoe}"

log() { echo -e "\n\033[1;36m== $*\033[0m"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root or with sudo"; exit 1; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates git apt-transport-https >/dev/null

log "node 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

log "tor (official repo, for pow: yes)"
if ! command -v tor >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc \
    | gpg --dearmor -o /etc/apt/keyrings/tor.gpg
  . /etc/os-release
  echo "deb [signed-by=/etc/apt/keyrings/tor.gpg] https://deb.torproject.org/torproject.org ${VERSION_CODENAME} main" \
    > /etc/apt/sources.list.d/tor.list
  apt-get update -qq
  apt-get install -y -qq tor deb.torproject.org-keyring >/dev/null
fi
tor --version | head -1

log "service user + repo"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
if [ -d "$RGOE_DIR/.git" ]; then
  git -C "$RGOE_DIR" fetch --depth 1 origin "$RGOE_REF" -q && git -C "$RGOE_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$RGOE_REF" "$RGOE_REPO" "$RGOE_DIR" -q \
    || { git clone --depth 1 "$RGOE_REPO" "$RGOE_DIR" -q && git -C "$RGOE_DIR" checkout -q "$RGOE_REF"; }
fi
( cd "$RGOE_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 )

log "onion identities (reused if present)"
BN_HS="$RGOE_DIR/deploy-state/bootnode-hs"
GW_HS="$RGOE_DIR/deploy-state/gateway-hs"
[ -f "$BN_HS/hostname" ] || node "$RGOE_DIR/bootnode/keygen.mjs" "$BN_HS" --label bootnode >/dev/null
[ -f "$GW_HS/hostname" ] || node "$RGOE_DIR/bootnode/keygen.mjs" "$GW_HS" --label gateway  >/dev/null
BN_ONION="$(cat "$BN_HS/hostname")"
GW_ONION="$(cat "$GW_HS/hostname")"

log "tor config (two hidden services + pow)"
# Tor owns the HS dirs; copy the minted keys into tor's own dirs (Tor is strict about perms).
install -d -o debian-tor -g debian-tor -m 0700 /var/lib/tor/rgoe-bootnode /var/lib/tor/rgoe-gateway
for pair in "$BN_HS:/var/lib/tor/rgoe-bootnode" "$GW_HS:/var/lib/tor/rgoe-gateway"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  install -o debian-tor -g debian-tor -m 0600 "$src/hs_ed25519_secret_key" "$dst/"
  install -o debian-tor -g debian-tor -m 0600 "$src/hs_ed25519_public_key" "$dst/"
  install -o debian-tor -g debian-tor -m 0600 "$src/hostname" "$dst/"
done
cat > /etc/tor/torrc.d-rgoe <<EOF
# rgoe: two onion services. PoW on (official tor build ships the pow module).
HiddenServiceDir /var/lib/tor/rgoe-bootnode
HiddenServicePort 80 127.0.0.1:${RGOE_BOOTNODE_PORT}
HiddenServicePoWDefensesEnabled 1
HiddenServiceDir /var/lib/tor/rgoe-gateway
HiddenServicePort 80 127.0.0.1:${RGOE_GATEWAY_PORT}
HiddenServicePoWDefensesEnabled 1
EOF
grep -q "torrc.d-rgoe" /etc/tor/torrc || echo "%include /etc/tor/torrc.d-rgoe" >> /etc/tor/torrc
systemctl enable tor >/dev/null 2>&1 || true
systemctl restart tor

log "systemd units"
cat > /etc/systemd/system/rgoe-bootnode.service <<EOF
[Unit]
Description=rgoe bootnode (gateway discovery)
After=network-online.target tor.service
Wants=network-online.target
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
Environment=RGOE_BOOTNODE_PORT=${RGOE_BOOTNODE_PORT}
Environment=RGOE_BOOTNODE_ADMISSION=${RGOE_ADMISSION}
Environment=RGOE_BOOTNODE_SIGNER_KEY=${RGOE_DIR}/deploy-state/bootnode-signer.key
ExecStart=$(command -v node) ${RGOE_DIR}/bootnode/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/rgoe-gateway.service <<EOF
[Unit]
Description=rgoe reputation-gated egress gateway
After=network-online.target tor.service
Wants=network-online.target
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
ExecStart=$(command -v node) ${RGOE_DIR}/gateway/gateway.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
# the deploy-state dir must be writable by the service user (signer key is minted at runtime)
chown -R "$RUN_USER":"$RUN_USER" "$RGOE_DIR/deploy-state"
systemctl daemon-reload
systemctl enable --now rgoe-bootnode rgoe-gateway >/dev/null 2>&1 || systemctl restart rgoe-bootnode rgoe-gateway

log "gateway heartbeat -> bootnode"
# The gateway announces itself to the local bootnode. It uses the gateway onion identity and
# the local Tor SOCKS. (For admission=stake, add RGOE_GW_OPERATOR_KEY here after staking.)
cat > /etc/systemd/system/rgoe-heartbeat.service <<EOF
[Unit]
Description=rgoe gateway heartbeat to bootnode
After=rgoe-bootnode.service tor.service
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
Environment=RGOE_BOOTNODE_ONION=${BN_ONION}
Environment=RGOE_GW_IDENTITY=${GW_HS}/identity.local.json
Environment=RGOE_TOR_PORT=9050
ExecStart=$(command -v node) ${RGOE_DIR}/bootnode/heartbeat.mjs
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rgoe-heartbeat >/dev/null 2>&1 || systemctl restart rgoe-heartbeat

log "waiting for the bootnode signer + onion descriptors (~15s)…"
sleep 15
SIGNER="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RGOE_DIR}/deploy-state/bootnode-signer.key')).pub)" 2>/dev/null || echo '<check: journalctl -u rgoe-bootnode>')"

cat <<EOF

========================================================================
rgoe fleet is up.

  bootnode onion : ${BN_ONION}
  bootnode signer: ${SIGNER}
  gateway onion  : ${GW_ONION}
  admission      : ${RGOE_ADMISSION}

Clients connect with (pin the signer!):
  rgoe client --secret <member-hex> \\
    --bootnode ${BN_ONION} \\
    --dir-signer ${SIGNER}

Check it:
  systemctl status rgoe-bootnode rgoe-gateway rgoe-heartbeat
  curl --socks5-hostname 127.0.0.1:9050 http://${BN_ONION}/health   # after ~30s of descriptor propagation
========================================================================
EOF
