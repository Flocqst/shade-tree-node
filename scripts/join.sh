#!/usr/bin/env bash
# FRIEND entrypoint: join the egress and prove it works, in one command.
#
# Hand a friend: this repo (with group/members.json), the gateway's .onion, and
# their own RGOE_SECRET. Then they run:
#
#   scripts/join.sh <gateway-onion> <their-secret>
#
# or set RGOE_ONION / RGOE_SECRET in the environment and run it with no args.
# It starts their client-side Tor + shim, then runs the verification receipt.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -n "${1:-}" ] && export RGOE_ONION="$1"
[ -n "${2:-}" ] && export RGOE_SECRET="$2"

echo "joining the gated egress as a member..."
bash scripts/run-client.sh

echo ""
echo "giving the onion descriptor a moment to resolve, then verifying..."
sleep 2
bash scripts/verify.sh
