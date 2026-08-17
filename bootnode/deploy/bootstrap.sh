#!/usr/bin/env bash
# Bring a FRESH Ubuntu 24.04 droplet up as a reputation-gated onion egress bootnode +
# gateway, in one idempotent command. You rent the box; this does the rest.
#
#   ssh root@<droplet>            # or a sudo user
#   curl -fsSL https://raw.githubusercontent.com/dmarzzz/reputation-gated-onion-egress/main/bootnode/deploy/bootstrap.sh | sudo bash
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
#   RGOE_REF         branch/tag/sha     (default: main)
#   RGOE_DIR         install dir        (default: /opt/rgoe)
#   RGOE_ADMISSION   open | stake       (default: open)
#   RGOE_BOOTNODE_PORT / RGOE_GATEWAY_PORT   loopback backends (default 8877 / 8443)
#   RGOE_ENABLE_POW  1 | 0              (default: 0) onion PoW DoS defense
#                    (HiddenServicePoWDefensesEnabled) on every HS block this box publishes.
#                    Default OFF: a client tor built without the pow module (e.g. the Homebrew
#                    bottle, `tor --list-modules` -> `pow: no`) could NOT reach a PoW-enabled
#                    onion (docs/DEPLOYMENT.md "PoW capability mismatch"); the agent-devops
#                    fleet role defaults `rgoe_enable_pow: false` for the same reason. Turn it
#                    on (=1) once every client you serve runs a pow-capable tor. Toggling
#                    later = edit /etc/tor/torrc.d-rgoe + `systemctl reload tor` (keys/onions
#                    are unchanged either way).
#   RGOE_BOOTNODE_ONION   <56-char>.onion   (default: unset = this box runs its OWN bootnode)
#                    GATEWAY-ONLY mode: when set, this box installs ONLY tor + rgoe-gateway +
#                    rgoe-heartbeat (no rgoe-bootnode unit, no bootnode HS block, no bootnode
#                    identity) and the heartbeat announces the gateway to THAT remote bootnode.
#                    Use it to add a second/third gateway to an existing bootnode (docs/OPERATOR.md
#                    section 2). Optional companions, only read in this mode:
#     RGOE_BOOTNODE_SIGNER   the remote bootnode's pinned signer pubkey -- printed into the
#                            client command at the end (the heartbeat does not need it).
#   RGOE_GATEWAY_REGION  na|sa|eu|af|as|oc|aq|unknown  (default: unset = not advertised)
#                    coarse region bucket the heartbeat advertises in signed caps (docs/CONFIG.md).
#   RGOE_HELIOS      1 | 0              (default: 0) OPT-IN Helios light-client sidecar (T-DEV-9b,
#                    docs/LIGHT-CLIENT.md). =1 installs the pinned a16z/helios release binary
#                    (sha256-verified, RGOE_HELIOS_VERSION below), renders + starts a hardened
#                    rgoe-helios.service (local verifying JSON-RPC on 127.0.0.1:RGOE_HELIOS_PORT),
#                    and points the gateway at it: the gateway unit gets RGOE_ROOT_PROVIDER=light,
#                    RGOE_HELIOS_RPC_URL, RGOE_RPC_URL, RGOE_GROUP_CONTRACT and is ordered after
#                    the sidecar. The admission root is then anchored to the beacon sync committee
#                    (no RPC trust). Default OFF: the default render is byte-identical to before.
#                    Companions, read only when RGOE_HELIOS=1:
#     RGOE_HELIOS_CONSENSUS_RPC  beacon API URL that serves the light-client endpoints  (REQUIRED)
#     RGOE_RPC_URL               execution JSON-RPC; MUST serve eth_getProof at the finalized
#                                block (own node / archive-capable provider)               (REQUIRED)
#     RGOE_GROUP_CONTRACT        StakedReputationSet address the gateway reads roots from (REQUIRED)
#     RGOE_HELIOS_NETWORK        mainnet | sepolia | holesky   (default: sepolia)
#     RGOE_HELIOS_PORT           sidecar loopback RPC port     (default: 8546; 8545 is left for a local node)
#     RGOE_HELIOS_CHECKPOINT     weak-subjectivity checkpoint = a recent FINALIZED beacon block
#                                root, 0x + 64 hex (default: unset -> helios --load-external-fallback,
#                                i.e. it fetches one from public checkpoint services; pinning your
#                                own is the more trust-minimized choice, docs/LIGHT-CLIENT.md)
#     RGOE_HELIOS_VERSION        release tag to install         (default: 0.11.1, sha256-pinned below;
#                                another version needs RGOE_HELIOS_SHA256=<sha256 of the tarball>)
#   RGOE_REGISTRAR   1 | 0              (default: 0) OPT-IN 402 registrar (T-FEAT-7, docs/PAYMENTS.md
#                    "Shipped 2026-08-17"): sell membership leaves for a stablecoin over x402 + MPP.
#                    =1 renders + starts a hardened rgoe-registrar.service (payments/registrar.mjs on
#                    127.0.0.1:RGOE_REGISTRAR_PORT), publishes it as an EXTRA PORT of the bootnode
#                    onion (HiddenServicePort <port> 127.0.0.1:<port> inside the bootnode HS block, so
#                    buyers reach it at http://<bootnode-onion>:<port>/), and makes the bootnode
#                    advertise it in GET /health (`pay: {...}`). Needs the bootnode on this box
#                    (not gateway-only mode). The OPERATOR KEY is a secret and deliberately NOT a
#                    tunable: after bootstrap, add it as a 0600 drop-in
#                    /etc/systemd/system/rgoe-registrar.service.d/operator.conf
#                    (Environment=RGOE_REGISTRAR_KEY=0x…; docs/OPERATOR.md "Selling access via 402").
#                    Default OFF: the default render is byte-identical to before.
#                    Companions, read only when RGOE_REGISTRAR=1:
#     RGOE_PAID_ACCESS_CONTRACT  PaidAccessSet address the registrar inserts into            (REQUIRED)
#     RGOE_PAY_ASSET             EIP-3009 stablecoin address (Sepolia USDC 0x1c7D…7238, or the
#                                test tUSD from network/sepolia/contracts.json payAsset)      (REQUIRED)
#     RGOE_PAY_PRICES            per-tier price in atomic units, "8=100000,32=400000"       (REQUIRED)
#     RGOE_RPC_URL               execution JSON-RPC the registrar settles/inserts through   (REQUIRED)
#     RGOE_PAY_TO                stablecoin recipient        (default: unset = the operator key's address)
#     RGOE_REGISTRAR_PORT        loopback + onion port       (default: 8878)
#     RGOE_PAY_CHAIN_ID          chain id the bootnode advertises in /health (default: 11155111 Sepolia)
#   RGOE_FROM_BLOCK  <block>            (default: unset = not rendered) eth_getLogs START block for
#                    the gateway's on-chain root scans (0x-hex or decimal), passed into the gateway
#                    unit verbatim. Public RPCs cap one eth_getLogs call (publicnode: 50k blocks;
#                    docs/OPERATOR.md "public RPC log-range caps"); the gateway pages the scan
#                    itself and derives each contract's deploy block from the committed network
#                    record, so this is only needed for a contract the records do not know.
#     RGOE_FROM_BLOCKS <addr>=<block>,…  per-contract start blocks (same passthrough; wins over
#                    RGOE_FROM_BLOCK for the named contract). Both unset = default render, byte-identical.
#   RGOE_RENDER_ONLY <dir>   (default: unset) RENDER mode for tests/review: write the torrc
#                    include + systemd units under <dir>/etc/... and exit WITHOUT touching the
#                    host (no root, no apt, no tor/node install, no clone, no systemctl). Onions
#                    are fixed placeholders so the output is deterministic (golden-testable).
#                    `bootstrap.sh --render <dir>` is the same thing.
set -euo pipefail

if [ "${1:-}" = "--render" ]; then RGOE_RENDER_ONLY="${2:?--render needs a directory}"; shift 2; fi

RGOE_REPO="${RGOE_REPO:-https://github.com/dmarzzz/reputation-gated-onion-egress}"
RGOE_REF="${RGOE_REF:-main}"
RGOE_DIR="${RGOE_DIR:-/opt/rgoe}"
RGOE_ADMISSION="${RGOE_ADMISSION:-open}"
RGOE_BOOTNODE_PORT="${RGOE_BOOTNODE_PORT:-8877}"
RGOE_GATEWAY_PORT="${RGOE_GATEWAY_PORT:-8443}"
RGOE_ENABLE_POW="${RGOE_ENABLE_POW:-0}"
RGOE_BOOTNODE_ONION="${RGOE_BOOTNODE_ONION:-}"
RGOE_BOOTNODE_SIGNER="${RGOE_BOOTNODE_SIGNER:-}"
RGOE_GATEWAY_REGION="${RGOE_GATEWAY_REGION:-}"
RGOE_RENDER_ONLY="${RGOE_RENDER_ONLY:-}"
RUN_USER="${RGOE_USER:-rgoe}"
RGOE_HELIOS="${RGOE_HELIOS:-0}"
RGOE_HELIOS_CONSENSUS_RPC="${RGOE_HELIOS_CONSENSUS_RPC:-}"
RGOE_RPC_URL="${RGOE_RPC_URL:-}"
RGOE_GROUP_CONTRACT="${RGOE_GROUP_CONTRACT:-}"
RGOE_HELIOS_NETWORK="${RGOE_HELIOS_NETWORK:-sepolia}"
RGOE_HELIOS_PORT="${RGOE_HELIOS_PORT:-8546}"
RGOE_HELIOS_CHECKPOINT="${RGOE_HELIOS_CHECKPOINT:-}"
RGOE_HELIOS_VERSION="${RGOE_HELIOS_VERSION:-0.11.1}"
RGOE_HELIOS_SHA256="${RGOE_HELIOS_SHA256:-}"
HELIOS_BIN=/usr/local/bin/helios
RGOE_REGISTRAR="${RGOE_REGISTRAR:-0}"
RGOE_PAID_ACCESS_CONTRACT="${RGOE_PAID_ACCESS_CONTRACT:-}"
RGOE_PAY_ASSET="${RGOE_PAY_ASSET:-}"
RGOE_PAY_PRICES="${RGOE_PAY_PRICES:-}"
RGOE_PAY_TO="${RGOE_PAY_TO:-}"
RGOE_REGISTRAR_PORT="${RGOE_REGISTRAR_PORT:-8878}"
RGOE_PAY_CHAIN_ID="${RGOE_PAY_CHAIN_ID:-11155111}"
RGOE_FROM_BLOCK="${RGOE_FROM_BLOCK:-}"
RGOE_FROM_BLOCKS="${RGOE_FROM_BLOCKS:-}"
# Pinned sha256 of the a16z/helios 0.11.1 release tarballs (github.com/a16z/helios/releases/tag/0.11.1),
# computed 2026-08-17 from the downloaded assets. Another RGOE_HELIOS_VERSION must bring its own
# RGOE_HELIOS_SHA256 (no unpinned download, ever).
helios_pinned_sha256() {  # $1 = version, $2 = amd64|arm64 -> echoes sha256 or nothing
  case "$1:$2" in
    0.11.1:amd64) echo 339bf4ce73073c53790e41e3217b6d91f0e5d8571132b9e88689997613162ddb ;;
    0.11.1:arm64) echo 20132e1f772af246eac3885bcba3b54c21a98ac24027a5853eca2fb0edc5dab6 ;;
    *) ;;
  esac
}

log() { echo -e "\n\033[1;36m== $*\033[0m"; }
die() { echo "bootstrap.sh: $*" >&2; exit 1; }

# --- validate the tunables up front (fail fast, before anything is installed) ---
case "$RGOE_ENABLE_POW" in
  1|true|yes|on)   RGOE_ENABLE_POW=1 ;;
  0|false|no|off)  RGOE_ENABLE_POW=0 ;;
  *) die "RGOE_ENABLE_POW must be 1 or 0 (got '$RGOE_ENABLE_POW')" ;;
esac
case "$RGOE_ADMISSION" in open|stake) ;; *) die "RGOE_ADMISSION must be open or stake (got '$RGOE_ADMISSION')" ;; esac
# Mode: WITH_BOOTNODE=1 -> this box runs bootnode + gateway (default, unchanged behaviour);
#       WITH_BOOTNODE=0 -> gateway-only, heartbeat -> the remote RGOE_BOOTNODE_ONION.
WITH_BOOTNODE=1
if [ -n "$RGOE_BOOTNODE_ONION" ]; then
  RGOE_BOOTNODE_ONION="${RGOE_BOOTNODE_ONION%.onion}.onion"
  [[ "$RGOE_BOOTNODE_ONION" =~ ^[a-z2-7]{56}\.onion$ ]] \
    || die "RGOE_BOOTNODE_ONION must be a v3 onion address (56 base32 chars, optional .onion suffix)"
  WITH_BOOTNODE=0
fi
if [ -n "$RGOE_GATEWAY_REGION" ]; then
  case "$RGOE_GATEWAY_REGION" in na|sa|eu|af|as|oc|aq|unknown) ;;
    *) die "RGOE_GATEWAY_REGION must be one of na sa eu af as oc aq unknown (got '$RGOE_GATEWAY_REGION')" ;; esac
fi
case "$RGOE_HELIOS" in
  1|true|yes|on)   RGOE_HELIOS=1 ;;
  0|false|no|off)  RGOE_HELIOS=0 ;;
  *) die "RGOE_HELIOS must be 1 or 0 (got '$RGOE_HELIOS')" ;;
esac
if [ "$RGOE_HELIOS" = "1" ]; then
  # URLs: http(s) (ws(s) too for the execution RPC), no whitespace/quotes/semicolons (they land in unit files).
  [[ "$RGOE_HELIOS_CONSENSUS_RPC" =~ ^https?://[A-Za-z0-9._~:/?#@!$\&*+,=%-]+$ ]] \
    || die "RGOE_HELIOS=1 needs RGOE_HELIOS_CONSENSUS_RPC=<http(s) beacon API URL serving the light-client endpoints>"
  [[ "$RGOE_RPC_URL" =~ ^(https?|wss?)://[A-Za-z0-9._~:/?#@!$\&*+,=%-]+$ ]] \
    || die "RGOE_HELIOS=1 needs RGOE_RPC_URL=<execution JSON-RPC URL that serves eth_getProof at finalized>"
  [[ "$RGOE_GROUP_CONTRACT" =~ ^0x[0-9a-fA-F]{40}$ ]] \
    || die "RGOE_HELIOS=1 needs RGOE_GROUP_CONTRACT=<0x StakedReputationSet address> (the gateway reads its roots from it)"
  case "$RGOE_HELIOS_NETWORK" in mainnet|sepolia|holesky) ;;
    *) die "RGOE_HELIOS_NETWORK must be mainnet, sepolia or holesky (got '$RGOE_HELIOS_NETWORK')" ;; esac
  { [[ "$RGOE_HELIOS_PORT" =~ ^[0-9]{4,5}$ ]] && [ "$RGOE_HELIOS_PORT" -ge 1024 ] && [ "$RGOE_HELIOS_PORT" -le 65535 ]; } \
    || die "RGOE_HELIOS_PORT must be a port in 1024..65535 (got '$RGOE_HELIOS_PORT')"
  { [ -z "$RGOE_HELIOS_CHECKPOINT" ] || [[ "$RGOE_HELIOS_CHECKPOINT" =~ ^0x[0-9a-fA-F]{64}$ ]]; } \
    || die "RGOE_HELIOS_CHECKPOINT must be a 0x-prefixed 32-byte beacon block root (got '$RGOE_HELIOS_CHECKPOINT')"
  [[ "$RGOE_HELIOS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "RGOE_HELIOS_VERSION must look like 0.11.1 (got '$RGOE_HELIOS_VERSION')"
  { [ -z "$RGOE_HELIOS_SHA256" ] || [[ "$RGOE_HELIOS_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; } || die "RGOE_HELIOS_SHA256 must be 64 hex chars"
fi

case "$RGOE_REGISTRAR" in
  1|true|yes|on)   RGOE_REGISTRAR=1 ;;
  0|false|no|off)  RGOE_REGISTRAR=0 ;;
  *) die "RGOE_REGISTRAR must be 1 or 0 (got '$RGOE_REGISTRAR')" ;;
esac
if [ "$RGOE_REGISTRAR" = "1" ]; then
  [ "$WITH_BOOTNODE" = "1" ] || die "RGOE_REGISTRAR=1 needs the bootnode on this box (the registrar is published on the bootnode onion); unset RGOE_BOOTNODE_ONION"
  [[ "$RGOE_PAID_ACCESS_CONTRACT" =~ ^0x[0-9a-fA-F]{40}$ ]] \
    || die "RGOE_REGISTRAR=1 needs RGOE_PAID_ACCESS_CONTRACT=<0x PaidAccessSet address>"
  [[ "$RGOE_PAY_ASSET" =~ ^0x[0-9a-fA-F]{40}$ ]] \
    || die "RGOE_REGISTRAR=1 needs RGOE_PAY_ASSET=<0x EIP-3009 stablecoin address>"
  [[ "$RGOE_PAY_PRICES" =~ ^[1-9][0-9]{0,4}=[1-9][0-9]*(,[1-9][0-9]{0,4}=[1-9][0-9]*)*$ ]] \
    || die "RGOE_REGISTRAR=1 needs RGOE_PAY_PRICES=<limit>=<atomic-amount>[,...] (e.g. 8=100000,32=400000)"
  [[ "$RGOE_RPC_URL" =~ ^(https?|wss?)://[A-Za-z0-9._~:/?#@!$\&*+,=%-]+$ ]] \
    || die "RGOE_REGISTRAR=1 needs RGOE_RPC_URL=<execution JSON-RPC URL>"
  { [ -z "$RGOE_PAY_TO" ] || [[ "$RGOE_PAY_TO" =~ ^0x[0-9a-fA-F]{40}$ ]]; } || die "RGOE_PAY_TO must be a 0x address"
  { [[ "$RGOE_REGISTRAR_PORT" =~ ^[0-9]{4,5}$ ]] && [ "$RGOE_REGISTRAR_PORT" -ge 1024 ] && [ "$RGOE_REGISTRAR_PORT" -le 65535 ]; } \
    || die "RGOE_REGISTRAR_PORT must be a port in 1024..65535 (got '$RGOE_REGISTRAR_PORT')"
  [[ "$RGOE_PAY_CHAIN_ID" =~ ^[1-9][0-9]{0,15}$ ]] || die "RGOE_PAY_CHAIN_ID must be a positive integer"
fi

# eth_getLogs start blocks (gateway on-chain roots): a bare block, or <0xaddr>=<block> pairs. Both
# land verbatim in a unit file, so the shape is pinned here (no spaces/quotes/semicolons).
{ [ -z "$RGOE_FROM_BLOCK" ] || [[ "$RGOE_FROM_BLOCK" =~ ^(0x[0-9a-fA-F]{1,16}|[0-9]{1,16})$ ]]; } \
  || die "RGOE_FROM_BLOCK must be a block number (0x-hex or decimal; got '$RGOE_FROM_BLOCK')"
{ [ -z "$RGOE_FROM_BLOCKS" ] || [[ "$RGOE_FROM_BLOCKS" =~ ^0x[0-9a-fA-F]{40}=(0x[0-9a-fA-F]{1,16}|[0-9]{1,16})(,0x[0-9a-fA-F]{40}=(0x[0-9a-fA-F]{1,16}|[0-9]{1,16}))*$ ]]; } \
  || die "RGOE_FROM_BLOCKS must be <0xaddress>=<block>[,...] (got '$RGOE_FROM_BLOCKS')"

# --- renderers: the ONLY places torrc / unit text is produced (live + render mode share them) ---
# torrc include: one HiddenServiceDir block per onion this box publishes. The PoW line is a
# per-service option, so it sits INSIDE each block right after its HiddenServicePort.
render_torrc() {  # $1 = output file
  {
    if [ "$WITH_BOOTNODE" = "1" ]; then
      echo "# rgoe: two onion services (bootnode + gateway). PoW defense: RGOE_ENABLE_POW=${RGOE_ENABLE_POW}."
      echo "HiddenServiceDir /var/lib/tor/rgoe-bootnode"
      echo "HiddenServicePort 80 127.0.0.1:${RGOE_BOOTNODE_PORT}"
      # The 402 registrar rides the SAME onion on an extra virtual port (RGOE_REGISTRAR=1).
      [ "$RGOE_REGISTRAR" = "1" ] && echo "HiddenServicePort ${RGOE_REGISTRAR_PORT} 127.0.0.1:${RGOE_REGISTRAR_PORT}"
      echo "HiddenServicePoWDefensesEnabled ${RGOE_ENABLE_POW}"
    else
      echo "# rgoe: gateway-only box (bootnode is remote: ${RGOE_BOOTNODE_ONION}). PoW defense: RGOE_ENABLE_POW=${RGOE_ENABLE_POW}."
    fi
    echo "HiddenServiceDir /var/lib/tor/rgoe-gateway"
    echo "HiddenServicePort 80 127.0.0.1:${RGOE_GATEWAY_PORT}"
    echo "HiddenServicePoWDefensesEnabled ${RGOE_ENABLE_POW}"
  } > "$1"
}

# Sandbox rationale (applied identically to every unit below). Each is a plain Node
# process that needs: outbound network (bootnode/heartbeat over Tor SOCKS on loopback, Node
# fetch), read access to the repo, and write access ONLY to ${RGOE_DIR}/deploy-state (the
# bootnode mints its signer key there at runtime; the gateway/heartbeat read the minted onion
# identities from there; persistence writes there too) plus a private /tmp.
#   NoNewPrivileges       no setuid/capability escalation ever
#   ProtectSystem=strict  whole FS read-only; ReadWritePaths re-opens deploy-state (see above)
#   ProtectHome           /home,/root,/run/user hidden (service user is --system, no $HOME use)
#   PrivateTmp            private /tmp,/var/tmp, unshared from the host
#   ProtectKernel*/CGroups block /proc/sys, /sys, kmod, and cgroup writes (none needed)
#   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX  IPv4/IPv6 + AF_UNIX for the Tor SOCKS
#                          path/DNS resolver sockets; everything exotic (AF_PACKET, AF_NETLINK…) denied
#   RestrictNamespaces/LockPersonality  no new namespaces, no persona (ASLR) downgrades
#   SystemCallFilter=@system-service  vetted allowlist for normal services; implicitly EXCLUDES
#                          @privileged/@mount/@reboot/@swap/@module etc. (~=EPERM below)
#   CapabilityBoundingSet= (empty) drop ALL capabilities — the services bind only loopback high
#                          ports (>1024), so no CAP_NET_BIND_SERVICE or anything else is required
#   MemoryMax=512M/TasksMax=256  contain runaway RSS/fork storms; Node + these workloads sit well under
# MemoryDenyWriteExecute is deliberately NOT set: V8's JIT maps writable-then-executable pages,
# so W^X enforcement would crash the Node runtime. Left off on purpose.
render_sandbox() {
  cat <<EOF
# --- sandbox (see rationale in bootstrap.sh) ---
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${RGOE_DIR}/deploy-state
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
SystemCallFilter=@system-service
CapabilityBoundingSet=
MemoryMax=512M
TasksMax=256
[Install]
WantedBy=multi-user.target
EOF
}

render_bootnode_unit() {  # $1 = output file
  {
    cat <<EOF
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
Environment=RGOE_BOOTNODE_STORE=${RGOE_DIR}/deploy-state/bootnode-state.json
EOF
    if [ "$RGOE_REGISTRAR" = "1" ]; then
      # Advertise the registrar in GET /health (`pay: {port, protocols, asset, chain, tiers}`).
      echo "Environment=RGOE_REGISTRAR_ADVERTISE=1"
      echo "Environment=RGOE_REGISTRAR_PORT=${RGOE_REGISTRAR_PORT}"
      echo "Environment=RGOE_PAY_ASSET=${RGOE_PAY_ASSET}"
      echo "Environment=RGOE_PAY_PRICES=${RGOE_PAY_PRICES}"
      echo "Environment=RGOE_PAY_CHAIN_ID=${RGOE_PAY_CHAIN_ID}"
    fi
    cat <<EOF
ExecStart=${NODE_BIN} ${RGOE_DIR}/bootnode/server.mjs
Restart=always
RestartSec=3
EOF
    render_sandbox
  } > "$1"
}

# The 402 registrar (T-FEAT-7): a loopback Node service that sells membership leaves over x402 +
# MPP and inserts them into the PaidAccessSet from the operator key. Same sandbox as the other
# units; its order store lives under deploy-state (the one writable path). RGOE_REGISTRAR_KEY is a
# SECRET and is NOT rendered here: add it as a 0600 drop-in after bootstrap (see the header).
render_registrar_unit() {  # $1 = output file
  {
    cat <<EOF
[Unit]
Description=rgoe 402 registrar (sell membership leaves: x402 + MPP -> PaidAccessSet)
After=network-online.target tor.service
Wants=network-online.target
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
Environment=RGOE_REGISTRAR_PORT=${RGOE_REGISTRAR_PORT}
Environment=RGOE_REGISTRAR_ONION=${BN_ONION}
Environment=RGOE_REGISTRAR_STORE=${RGOE_DIR}/deploy-state/registrar-state.json
Environment=RGOE_PAID_ACCESS_CONTRACT=${RGOE_PAID_ACCESS_CONTRACT}
Environment=RGOE_PAY_ASSET=${RGOE_PAY_ASSET}
Environment=RGOE_PAY_PRICES=${RGOE_PAY_PRICES}
Environment=RGOE_RPC_URL=${RGOE_RPC_URL}
EOF
    [ -z "$RGOE_PAY_TO" ] || echo "Environment=RGOE_PAY_TO=${RGOE_PAY_TO}"
    cat <<EOF
ExecStart=${NODE_BIN} ${RGOE_DIR}/payments/registrar.mjs
Restart=always
RestartSec=5
EOF
    render_sandbox
  } > "$1"
}

# With RGOE_HELIOS=1 the gateway is ordered after the sidecar and told to read on-chain roots
# through the light provider anchored to it (RGOE_ROOT_PROVIDER=light + RGOE_HELIOS_RPC_URL);
# lib/root-provider.mjs fails closed if the sidecar is down/mismatched, so the gateway simply
# restarts until Helios is synced. Default (RGOE_HELIOS=0): byte-identical to before.
render_gateway_unit() {  # $1 = output file
  {
    echo "[Unit]"
    echo "Description=rgoe reputation-gated egress gateway"
    if [ "$RGOE_HELIOS" = "1" ]; then
      echo "After=network-online.target tor.service rgoe-helios.service"
      echo "Wants=network-online.target rgoe-helios.service"
    else
      echo "After=network-online.target tor.service"
      echo "Wants=network-online.target"
    fi
    cat <<EOF
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
EOF
    if [ "$RGOE_HELIOS" = "1" ]; then
      echo "Environment=RGOE_GROUP_CONTRACT=${RGOE_GROUP_CONTRACT}"
      echo "Environment=RGOE_RPC_URL=${RGOE_RPC_URL}"
      echo "Environment=RGOE_ROOT_PROVIDER=light"
      echo "Environment=RGOE_HELIOS_RPC_URL=http://127.0.0.1:${RGOE_HELIOS_PORT}"
    fi
    # eth_getLogs start block(s) for the on-chain root scan (only when given; unset = no line).
    [ -z "$RGOE_FROM_BLOCK" ]  || echo "Environment=RGOE_FROM_BLOCK=${RGOE_FROM_BLOCK}"
    [ -z "$RGOE_FROM_BLOCKS" ] || echo "Environment=RGOE_FROM_BLOCKS=${RGOE_FROM_BLOCKS}"
    cat <<EOF
ExecStart=${NODE_BIN} ${RGOE_DIR}/gateway/gateway.mjs
Restart=always
RestartSec=3
EOF
    render_sandbox
  } > "$1"
}

# The Helios sidecar (T-DEV-9b, docs/LIGHT-CLIENT.md option A): a local JSON-RPC that only
# answers with sync-committee-verified headers/state. Endpoints go in via helios' own env vars
# (EXECUTION_RPC / CONSENSUS_RPC / CHECKPOINT) rather than argv so an API key in a URL is not
# in `ps`. Binds loopback only. Same sandbox as the other units; helios is a Rust binary (no
# JIT), so W^X (MemoryDenyWriteExecute) is ON here even though the Node units must leave it off.
# The checkpoint cache lives under deploy-state (already the one writable path).
render_helios_unit() {  # $1 = output file
  {
    cat <<EOF
[Unit]
Description=rgoe helios light client (sync-committee verified stateRoot anchor, ${RGOE_HELIOS_NETWORK})
After=network-online.target
Wants=network-online.target
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
Environment=RUST_LOG=info
Environment=EXECUTION_RPC=${RGOE_RPC_URL}
Environment=CONSENSUS_RPC=${RGOE_HELIOS_CONSENSUS_RPC}
EOF
    if [ -n "$RGOE_HELIOS_CHECKPOINT" ]; then
      echo "Environment=CHECKPOINT=${RGOE_HELIOS_CHECKPOINT}"
      echo "ExecStart=${HELIOS_BIN} ethereum --network ${RGOE_HELIOS_NETWORK} --rpc-bind-ip 127.0.0.1 --rpc-port ${RGOE_HELIOS_PORT} --data-dir ${RGOE_DIR}/deploy-state/helios"
    else
      echo "ExecStart=${HELIOS_BIN} ethereum --network ${RGOE_HELIOS_NETWORK} --rpc-bind-ip 127.0.0.1 --rpc-port ${RGOE_HELIOS_PORT} --data-dir ${RGOE_DIR}/deploy-state/helios --load-external-fallback"
    fi
    cat <<EOF
Restart=always
RestartSec=5
MemoryDenyWriteExecute=true
EOF
    render_sandbox
  } > "$1"
}

# The gateway announces itself to the bootnode (local one by default, RGOE_BOOTNODE_ONION in
# gateway-only mode). It uses the gateway onion identity and the local Tor SOCKS. (For
# admission=stake, add Environment=RGOE_GW_OPERATOR_KEY=... here after staking -- a secret,
# so it is deliberately NOT a bootstrap.sh tunable; see bootnode/deploy/README.md.)
render_heartbeat_unit() {  # $1 = output file
  {
    if [ "$WITH_BOOTNODE" = "1" ]; then
      echo "[Unit]"
      echo "Description=rgoe gateway heartbeat to bootnode"
      echo "After=rgoe-bootnode.service tor.service"
    else
      echo "[Unit]"
      echo "Description=rgoe gateway heartbeat to remote bootnode ${RGOE_BOOTNODE_ONION}"
      echo "After=network-online.target tor.service"
      echo "Wants=network-online.target"
    fi
    cat <<EOF
[Service]
User=${RUN_USER}
WorkingDirectory=${RGOE_DIR}
Environment=RGOE_BOOTNODE_ONION=${BN_ONION}
Environment=RGOE_GW_IDENTITY=${GW_HS}/identity.local.json
Environment=RGOE_TOR_PORT=9050
EOF
    [ -z "$RGOE_GATEWAY_REGION" ] || echo "Environment=RGOE_GATEWAY_REGION=${RGOE_GATEWAY_REGION}"
    cat <<EOF
ExecStart=${NODE_BIN} ${RGOE_DIR}/bootnode/heartbeat.mjs
Restart=always
RestartSec=10
EOF
    render_sandbox
  } > "$1"
}

BN_HS="$RGOE_DIR/deploy-state/bootnode-hs"
GW_HS="$RGOE_DIR/deploy-state/gateway-hs"

# --- RENDER mode: emit the files and stop -------------------------------------------------
if [ -n "$RGOE_RENDER_ONLY" ]; then
  NODE_BIN="${RGOE_NODE_BIN:-/usr/bin/node}"
  GW_ONION="gatewayplaceholderplaceholderplaceholderplaceholderplace.onion"
  if [ "$WITH_BOOTNODE" = "1" ]; then BN_ONION="bootnodeplaceholderplaceholderplaceholderplaceholderplac.onion"; else BN_ONION="$RGOE_BOOTNODE_ONION"; fi
  out="$RGOE_RENDER_ONLY"
  mkdir -p "$out/etc/tor" "$out/etc/systemd/system"
  render_torrc "$out/etc/tor/torrc.d-rgoe"
  [ "$WITH_BOOTNODE" = "1" ] && render_bootnode_unit "$out/etc/systemd/system/rgoe-bootnode.service"
  render_gateway_unit   "$out/etc/systemd/system/rgoe-gateway.service"
  render_heartbeat_unit "$out/etc/systemd/system/rgoe-heartbeat.service"
  [ "$RGOE_HELIOS" = "1" ] && render_helios_unit "$out/etc/systemd/system/rgoe-helios.service"
  [ "$RGOE_REGISTRAR" = "1" ] && render_registrar_unit "$out/etc/systemd/system/rgoe-registrar.service"
  echo "rendered to $out (mode: $([ "$WITH_BOOTNODE" = "1" ] && echo bootnode+gateway || echo gateway-only), pow=${RGOE_ENABLE_POW}, helios=${RGOE_HELIOS}, registrar=${RGOE_REGISTRAR})"
  exit 0
fi

# --- LIVE mode --------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "run as root or with sudo"; exit 1; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates git apt-transport-https >/dev/null

log "node 24"
# Node < 24 is upgraded, not tolerated: the units below run under
# SystemCallFilter=@system-service, and Node 20's V8 calls pkey_alloc (syscall 330) at
# startup, which that allowlist does not include -> every unit dies with SIGSYS
# (status=31/SYS) in a restart loop. Observed on the 2026-08-17 go-live box (pre-installed
# NodeSource 20.20.2); Node 24 starts clean under the same filter. See
# docs/GO-LIVE-LOG-2026-08-17.md (Phase 1.3).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node --version
NODE_BIN="${RGOE_NODE_BIN:-$(command -v node)}"

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
# A file:// source (the e2e containers bind-mount the checkout) is usually owned by a
# different uid than root; git >= 2.35.2 refuses to read it ("dubious ownership") until
# the path is marked safe. Scoped to that one path; a URL source is unaffected.
case "$RGOE_REPO" in
  file://*)
    _src="${RGOE_REPO#file://}"
    # git resolves a file:// clone source to its .git dir and checks THAT path.
    git config --global --add safe.directory "$_src"
    git config --global --add safe.directory "$_src/.git"
    ;;
esac
if [ -d "$RGOE_DIR/.git" ]; then
  git -C "$RGOE_DIR" fetch --depth 1 origin "$RGOE_REF" -q && git -C "$RGOE_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$RGOE_REF" "$RGOE_REPO" "$RGOE_DIR" -q \
    || { git clone --depth 1 "$RGOE_REPO" "$RGOE_DIR" -q && git -C "$RGOE_DIR" checkout -q "$RGOE_REF"; }
fi
( cd "$RGOE_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 )

log "onion identities (reused if present)"
if [ "$WITH_BOOTNODE" = "1" ]; then
  [ -f "$BN_HS/hostname" ] || node "$RGOE_DIR/bootnode/keygen.mjs" "$BN_HS" --label bootnode >/dev/null
  BN_ONION="$(cat "$BN_HS/hostname")"
else
  BN_ONION="$RGOE_BOOTNODE_ONION"   # remote; nothing minted here
fi
[ -f "$GW_HS/hostname" ] || node "$RGOE_DIR/bootnode/keygen.mjs" "$GW_HS" --label gateway  >/dev/null
GW_ONION="$(cat "$GW_HS/hostname")"

if [ "$WITH_BOOTNODE" = "1" ]; then log "tor config (two hidden services, pow=${RGOE_ENABLE_POW})"; else log "tor config (gateway hidden service only, pow=${RGOE_ENABLE_POW})"; fi
# Tor owns the HS dirs; copy the minted keys into tor's own dirs (Tor is strict about perms).
HS_PAIRS=("$GW_HS:/var/lib/tor/rgoe-gateway")
[ "$WITH_BOOTNODE" = "1" ] && HS_PAIRS=("$BN_HS:/var/lib/tor/rgoe-bootnode" "${HS_PAIRS[@]}")
for pair in "${HS_PAIRS[@]}"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  install -d -o debian-tor -g debian-tor -m 0700 "$dst"
  install -o debian-tor -g debian-tor -m 0600 "$src/hs_ed25519_secret_key" "$dst/"
  install -o debian-tor -g debian-tor -m 0600 "$src/hs_ed25519_public_key" "$dst/"
  install -o debian-tor -g debian-tor -m 0600 "$src/hostname" "$dst/"
done
render_torrc /etc/tor/torrc.d-rgoe
grep -q "torrc.d-rgoe" /etc/tor/torrc || echo "%include /etc/tor/torrc.d-rgoe" >> /etc/tor/torrc
systemctl enable tor >/dev/null 2>&1 || true
systemctl restart tor

if [ "$RGOE_HELIOS" = "1" ]; then
  log "helios ${RGOE_HELIOS_VERSION} light-client sidecar (sha256-pinned release binary)"
  # Release layout (checked 2026-08-17): helios_linux_{amd64,arm64,armv7,riscv64gc}.tar.gz, each
  # a tarball containing the single `helios` binary at its root. Anything else -> manual install
  # (docs/LIGHT-CLIENT.md "Sidecar"): put a `helios` on ${HELIOS_BIN} and re-run.
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64|x86_64) HELIOS_ARCH=amd64 ;;
    arm64|aarch64) HELIOS_ARCH=arm64 ;;
    *) die "no pinned helios build for this arch; install helios ${RGOE_HELIOS_VERSION} manually at ${HELIOS_BIN} (docs/LIGHT-CLIENT.md)" ;;
  esac
  WANT_SHA="${RGOE_HELIOS_SHA256:-$(helios_pinned_sha256 "$RGOE_HELIOS_VERSION" "$HELIOS_ARCH")}"
  [ -n "$WANT_SHA" ] || die "no pinned sha256 for helios ${RGOE_HELIOS_VERSION}/${HELIOS_ARCH}; pass RGOE_HELIOS_SHA256=<sha256 of helios_linux_${HELIOS_ARCH}.tar.gz>"
  if [ -x "$HELIOS_BIN" ] && "$HELIOS_BIN" --version 2>/dev/null | grep -q " ${RGOE_HELIOS_VERSION}\$"; then
    echo "helios ${RGOE_HELIOS_VERSION} already installed at ${HELIOS_BIN}"
  else
    tmpd="$(mktemp -d)"
    curl -fsSL -o "$tmpd/helios.tar.gz" \
      "https://github.com/a16z/helios/releases/download/${RGOE_HELIOS_VERSION}/helios_linux_${HELIOS_ARCH}.tar.gz"
    echo "${WANT_SHA}  $tmpd/helios.tar.gz" | sha256sum -c - >/dev/null \
      || die "helios tarball sha256 mismatch (want ${WANT_SHA}); refusing to install"
    tar -xzf "$tmpd/helios.tar.gz" -C "$tmpd" helios
    install -o root -g root -m 0755 "$tmpd/helios" "$HELIOS_BIN"
    rm -rf "$tmpd"
  fi
  "$HELIOS_BIN" --version
  install -d -o "$RUN_USER" -g "$RUN_USER" -m 0700 "$RGOE_DIR/deploy-state/helios"
  render_helios_unit /etc/systemd/system/rgoe-helios.service
  systemctl daemon-reload
  systemctl enable --now rgoe-helios >/dev/null 2>&1 || systemctl restart rgoe-helios
elif [ -f /etc/systemd/system/rgoe-helios.service ]; then
  # A previous run had the sidecar on; RGOE_HELIOS=0 (default) means it must go, and the gateway
  # unit rendered below no longer points at it.
  systemctl disable --now rgoe-helios >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/rgoe-helios.service
fi

log "systemd units"
UNITS="rgoe-gateway"
if [ "$WITH_BOOTNODE" = "1" ]; then
  render_bootnode_unit /etc/systemd/system/rgoe-bootnode.service
  UNITS="rgoe-bootnode $UNITS"
elif [ -f /etc/systemd/system/rgoe-bootnode.service ]; then
  # A previous run of this box was bootnode+gateway; gateway-only means that unit must go.
  systemctl disable --now rgoe-bootnode >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/rgoe-bootnode.service
fi
render_gateway_unit /etc/systemd/system/rgoe-gateway.service
# the deploy-state dir must be writable by the service user (signer key is minted at runtime)
chown -R "$RUN_USER":"$RUN_USER" "$RGOE_DIR/deploy-state"
systemctl daemon-reload
# shellcheck disable=SC2086
systemctl enable --now $UNITS >/dev/null 2>&1 || systemctl restart $UNITS

log "gateway heartbeat -> bootnode ${BN_ONION}"
render_heartbeat_unit /etc/systemd/system/rgoe-heartbeat.service
systemctl daemon-reload
systemctl enable --now rgoe-heartbeat >/dev/null 2>&1 || systemctl restart rgoe-heartbeat

if [ "$RGOE_REGISTRAR" = "1" ]; then
  log "402 registrar on ${BN_ONION}:${RGOE_REGISTRAR_PORT} (x402 + MPP)"
  render_registrar_unit /etc/systemd/system/rgoe-registrar.service
  systemctl daemon-reload
  if [ -f /etc/systemd/system/rgoe-registrar.service.d/operator.conf ]; then
    systemctl enable --now rgoe-registrar >/dev/null 2>&1 || systemctl restart rgoe-registrar
  else
    systemctl enable rgoe-registrar >/dev/null 2>&1 || true
    echo "rgoe-registrar: NOT started — add the operator key drop-in first (see the summary below), then: systemctl start rgoe-registrar"
  fi
elif [ -f /etc/systemd/system/rgoe-registrar.service ]; then
  systemctl disable --now rgoe-registrar >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/rgoe-registrar.service
fi

if [ "$WITH_BOOTNODE" = "1" ]; then
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
  onion PoW      : ${RGOE_ENABLE_POW}   (RGOE_ENABLE_POW; 0 = off)
  helios sidecar : ${RGOE_HELIOS}   (RGOE_HELIOS; 1 = admission root anchored to the sync committee, journalctl -u rgoe-helios)
  402 registrar  : ${RGOE_REGISTRAR}   (RGOE_REGISTRAR; 1 = http://${BN_ONION}:${RGOE_REGISTRAR_PORT}/pay/quote sells leaves via x402 + MPP)
$([ "$RGOE_REGISTRAR" = "1" ] && cat <<REG

Registrar operator key (settles EIP-3009 transfers + inserts leaves; pays gas) — a SECRET, so it is
NOT a bootstrap tunable. Install it as a 0600 drop-in via stdin (never in argv/log), then start:
  install -d -m 0755 /etc/systemd/system/rgoe-registrar.service.d
  printf '[Service]\\nEnvironment=RGOE_REGISTRAR_KEY=%s\\n' "\$(cat /path/to/key)" \\
    | install -m 0600 /dev/stdin /etc/systemd/system/rgoe-registrar.service.d/operator.conf
  systemctl daemon-reload && systemctl restart rgoe-registrar
  curl --socks5-hostname 127.0.0.1:9050 "http://${BN_ONION}:${RGOE_REGISTRAR_PORT}/pay/quote?limit=8"   # expect 402 + PAYMENT-REQUIRED + WWW-Authenticate: Payment
REG
)
Clients connect with (pin the signer!):
  rgoe client --secret <member-hex> \\
    --bootnode ${BN_ONION} \\
    --dir-signer ${SIGNER}

Check it:
  systemctl status rgoe-bootnode rgoe-gateway rgoe-heartbeat$([ "$RGOE_HELIOS" = "1" ] && echo " rgoe-helios")$([ "$RGOE_REGISTRAR" = "1" ] && echo " rgoe-registrar")
  curl --socks5-hostname 127.0.0.1:9050 http://${BN_ONION}/health   # after ~30s of descriptor propagation
========================================================================
EOF
else
  SIGNER="${RGOE_BOOTNODE_SIGNER:-<pinned signer of the remote bootnode; ask its operator>}"
  cat <<EOF

========================================================================
rgoe gateway is up (gateway-only box; bootnode is remote).

  bootnode onion : ${BN_ONION}   (remote, RGOE_BOOTNODE_ONION)
  bootnode signer: ${SIGNER}
  gateway onion  : ${GW_ONION}
  onion PoW      : ${RGOE_ENABLE_POW}   (RGOE_ENABLE_POW; 0 = off)

The heartbeat announces this gateway to the remote bootnode over Tor. For an
admission=stake bootnode, stake the operator first (rgoe register-gateway), then add
  Environment=RGOE_GW_OPERATOR_KEY=<operator-key>
to /etc/systemd/system/rgoe-heartbeat.service and \`systemctl daemon-reload && systemctl restart rgoe-heartbeat\`.

Clients connect with (pin the signer!):
  rgoe client --secret <member-hex> \\
    --bootnode ${BN_ONION} \\
    --dir-signer ${SIGNER}

Check it:
  systemctl status rgoe-gateway rgoe-heartbeat
  journalctl -u rgoe-heartbeat -f      # expect 'announced (...)' once the descriptors propagate
  curl --socks5-hostname 127.0.0.1:9050 http://${BN_ONION}/directory | grep -o "${GW_ONION%.onion}" | head -1
========================================================================
EOF
fi
