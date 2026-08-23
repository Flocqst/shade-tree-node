#!/usr/bin/env bash
# Start the client-side Tor (SOCKS only, no onion) and wait until it has
# bootstrapped enough to build circuits. Prints the SOCKS port.
#
# Used by the LAPTOP role (run-client.sh). On a real laptop you can skip this
# entirely and point the shim at any existing Tor SOCKS via SHADE_TREE_TOR_PORT
# (system tor 9050, Tor Browser 9150). This exists so the split can be run
# self-contained, including on the same machine as the gateway Tor.
set -euo pipefail
cd "$(dirname "$0")/.."

TOR_BIN="${SHADE_TREE_TOR_BIN:-tor}"
mkdir -p tor/data-client
chmod 700 tor/data-client 2>/dev/null || true

if pgrep -f "tor -f ./tor/torrc.client" >/dev/null 2>&1; then
  echo "client tor already running (socks 9260)"
  exit 0
fi

echo "starting client tor via $TOR_BIN (socks 9260, no onion)..."
"$TOR_BIN" -f ./tor/torrc.client > tor/tor-client.log 2>&1 &
echo $! > tor/tor-client.pid

echo -n "waiting for client tor to bootstrap"
for _ in $(seq 1 60); do
  if grep -q "Bootstrapped 100%" tor/tor-client.log 2>/dev/null; then
    echo ""
    echo "client tor ready: SOCKS 127.0.0.1:9260"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo ""
echo "timed out waiting for client tor bootstrap; see tor/tor-client.log" >&2
exit 1
