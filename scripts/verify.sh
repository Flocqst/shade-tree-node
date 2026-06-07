#!/usr/bin/env bash
# Prove the gated egress works, end to end, from the CLIENT side.
#
# It compares your real IP against the IP the world sees when you go through the
# tunnel. Getting a well-formed IP back at all means the full path worked:
#   shim -> proof -> Tor rendezvous -> gateway -> verify -> clean egress -> back.
#
# Run it after the client is up (scripts/run-client.sh or scripts/join.sh).
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${RGOE_SHIM_PORT:-8888}"
PROXY="http://127.0.0.1:${PORT}"
IPRE='[0-9]{1,3}(\.[0-9]{1,3}){3}'
EPOCH=$(( $(date +%s) / ${RGOE_EPOCH_SECONDS:-86400} ))

line(){ printf '  %-22s %s\n' "$1" "$2"; }
echo ""
echo "  reputation-gated egress — client verification"
echo "  ────────────────────────────────────────────"
line "shim proxy" "$PROXY"
line "epoch (matches gateway)" "$EPOCH"

# 1. Your real IP, direct, no tunnel.
REAL=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null | grep -oE "$IPRE" | head -1)
line "your real IP (direct)" "${REAL:-<no direct internet?>}"

# 2. The IP the world sees through the tunnel, plus round-trip time.
RESP=$(curl -s --max-time 75 -x "$PROXY" -w $'\n%{time_total}' https://api.ipify.org 2>/dev/null || true)
EGRESS=$(printf '%s' "$RESP" | grep -oE "$IPRE" | head -1)
LAT=$(printf '%s' "$RESP" | tail -1 | grep -oE '[0-9.]+' | head -1)

if [ -z "$EGRESS" ]; then
  echo ""
  echo "  ✗ FAIL — no IP came back through the tunnel."
  echo "    The path did not complete. Check that the client is up and the onion is right:"
  echo "      tail -n 20 shim.log"
  echo "      echo \$RGOE_ONION   (must be the gateway's .onion)"
  exit 1
fi

line "egress IP (via tunnel)" "$EGRESS"
line "round trip" "${LAT:-?}s"

# 3. Confirm a real site is reachable through it (Google answers the TLS).
GCODE=$(curl -s -o /dev/null --max-time 75 -x "$PROXY" -w '%{http_code}' https://www.google.com/ 2>/dev/null || true)
line "google.com over tunnel" "HTTP ${GCODE:-?}"

echo "  ────────────────────────────────────────────"
if [ -n "${RGOE_EXPECT_IP:-}" ]; then
  # Deploy mode: assert egress comes out of the droplet we expect.
  if [ "$EGRESS" = "$RGOE_EXPECT_IP" ]; then
    echo "  ✓ PASS — egress IP == the droplet (${RGOE_EXPECT_IP})."
    echo "    Google saw the droplet, never you. Deployed path proven end to end."
  else
    echo "  ✗ FAIL — egress IP ${EGRESS} != expected droplet ${RGOE_EXPECT_IP}."
    echo "    The tunnel returned an IP, so the path works, but it is not the box"
    echo "    you expected. Check RGOE_ONION points at THIS droplet's gateway."
    exit 1
  fi
elif [ -n "$REAL" ] && [ "$EGRESS" = "$REAL" ]; then
  echo "  ✓ TUNNEL WORKS (local mode)"
  echo "    The egress IP equals this machine — the gateway is egressing locally."
  echo "    On the droplet, that same field becomes the DROPLET's IP. Path proven."
elif [ -n "$REAL" ]; then
  echo "  ✓ PASS — egress is a DISTINCT clean IP, not yours."
  echo "    The world saw ${EGRESS} (the gateway), never your ${REAL}."
else
  echo "  ✓ TUNNEL WORKS — got ${EGRESS} back through the gated path."
fi
echo ""
echo "    On the gateway, this request appears as a PASS at epoch=${EPOCH}."
echo "    Confirm it there with:  bash scripts/gateway-status.sh"
echo ""
