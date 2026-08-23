#!/usr/bin/env bash
# Prove the Shade Tree tunnel works, end to end, from the GATEWAY side.
#
# Digests gateway.log into a clean receipt: who was admitted, who was dropped and
# why, how many distinct members showed up (counted by nullifier, never identity),
# and the box's own egress IP — the clean IP your friends are borrowing.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="${1:-gateway.log}"
if [ ! -f "$LOG" ]; then
  echo "no $LOG yet — start the gateway first (scripts/run-gateway.sh)." >&2
  exit 1
fi

echo ""
echo "  Shade Tree — gateway status ($LOG)"
echo "  ────────────────────────────────────────────"
printf '  %-26s %s\n' "this box's egress IP" "$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '?')"

PASS=$(grep -c '^PASS' "$LOG" 2>/dev/null || true); PASS=${PASS:-0}
DROP=$(grep -c '^DROP' "$LOG" 2>/dev/null || true); DROP=${DROP:-0}
NULLS=$(grep -oE 'null=[0-9a-fx]+' "$LOG" 2>/dev/null | sort -u | wc -l | tr -d ' ')
EPOCHS=$(grep -oE 'epoch=[0-9]+' "$LOG" 2>/dev/null | sort -u | tr '\n' ' ')

printf '  %-26s %s\n' "admitted (PASS)" "$PASS"
printf '  %-26s %s\n' "dropped  (DROP)" "$DROP"
printf '  %-26s %s\n' "distinct members (nullif.)" "${NULLS:-0}"
printf '  %-26s %s\n' "epochs seen" "${EPOCHS:-none}"

echo ""
echo "  drops by reason:"
if [ "$DROP" -gt 0 ]; then
  grep '^DROP' "$LOG" | awk '{print $2}' | sort | uniq -c | sort -rn | sed 's/^/    /'
else
  echo "    (none)"
fi

echo ""
echo "  last 8 events:"
grep -E '^(PASS|DROP)' "$LOG" | tail -8 | sed 's/^/    /' || echo "    (none yet)"
echo ""
