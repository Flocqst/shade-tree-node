#!/usr/bin/env bash
# Start the dedicated Tor instance for the PoC and wait until the onion service
# descriptor is published. Prints the .onion address.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p tor/data tor/hs
chmod 700 tor/data tor/hs 2>/dev/null || true

if pgrep -f "tor -f ./tor/torrc" >/dev/null 2>&1; then
  echo "tor already running for this PoC"
else
  echo "starting tor (socks 9250, control 9251)..."
  tor -f ./tor/torrc >tor/tor.log 2>&1 &
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
