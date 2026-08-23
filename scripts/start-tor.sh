#!/usr/bin/env bash
# Start the dedicated Tor instance for the PoC and wait until the onion service
# descriptor is published. Prints the .onion address.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p tor/data tor/hs
chmod 700 tor/data tor/hs 2>/dev/null || true

# Pick the tor binary: explicit override, else a locally-built pow-capable tor
# (see scripts/build-tor-pow.sh), else whatever `tor` is on PATH (stock Homebrew).
if [ -n "${SHADE_TREE_TOR_BIN:-}" ]; then TOR_BIN="$SHADE_TREE_TOR_BIN"
elif [ -x ./tor/tor-pow/bin/tor ]; then TOR_BIN="./tor/tor-pow/bin/tor"
else TOR_BIN="tor"; fi

# Tor's onion-service proof-of-work defense is the outer DoS gate. It is stock
# tor, not a fork, but the PoW code (Equi-X) is GPL and Homebrew's BSD-only bottle
# omits it, so we enable it only when this tor actually has the 'pow' module.
# Stock tor HARD-FAILS config validation if the option is set without the module,
# so we pass it at runtime rather than baking it into torrc.
POW_ARGS=()
if "$TOR_BIN" --list-modules 2>/dev/null | grep -q '^pow: yes'; then
  POW_ARGS=(--HiddenServicePoWDefensesEnabled 1)
  echo "PoW: enabled (rendezvous DoS defense on)"
else
  echo "PoW: unavailable in this tor build; running without the outer DoS gate."
  echo "     (build one with: bash scripts/build-tor-pow.sh)"
fi

if pgrep -f "tor -f ./tor/torrc" >/dev/null 2>&1; then
  echo "tor already running for this PoC"
else
  echo "starting tor via $TOR_BIN (socks 9250, control 9251)..."
  # ${arr[@]+"${arr[@]}"} expands to nothing when the array is empty, instead of
  # tripping `set -u` on bash 3.2 (stock macOS). Harmless on bash 4+/Linux.
  "$TOR_BIN" -f ./tor/torrc ${POW_ARGS[@]+"${POW_ARGS[@]}"} >tor/tor.log 2>&1 &
  echo $! > tor/tor.pid
fi

echo -n "waiting for onion hostname"
for _ in $(seq 1 30); do
  if [ -s tor/hs/hostname ]; then
    echo ""
    echo "gateway onion: $(cat tor/hs/hostname)"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo ""
echo "timed out waiting for tor/hs/hostname; see tor/tor.log" >&2
exit 1
