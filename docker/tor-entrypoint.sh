#!/bin/sh
# Tor container entrypoint for the demo fleet.
#
# Two jobs before tor takes over as an unprivileged user:
#   1. Own the state volume as debian-tor (a fresh named volume mounts root-owned,
#      and tor secures its DataDirectory to 0700 — unreadable to other UIDs).
#   2. Run a tiny background mirror that copies each onion's `hostname` (written
#      by tor into its 0700 DataDirectory) out to /shared/<role>.onion at 0644.
#      /shared lives on its OWN volume, deliberately outside the 0700
#      DataDirectory, so the client container (a different UID) can traverse in
#      and discover the bootnode/gateway addresses generated on first boot.

set -e

STATE=/var/lib/tor
SHARED=/shared

chown -R debian-tor:debian-tor "$STATE"
mkdir -p "$SHARED"
chmod 755 "$SHARED"

# Background: publish onion hostnames once tor has generated them. Runs as root
# (before the exec below drops privileges) so it can read the 0700 HS dirs.
(
  while true; do
    for role in bootnode gateway; do
      src="$STATE/hs-$role/hostname"
      dst="$SHARED/$role.onion"
      if [ -s "$src" ] && [ ! -s "$dst" ]; then
        cat "$src" > "$dst"
        chmod 644 "$dst"
        echo "[tor] $role onion ready: $(cat "$dst")"
      fi
    done
    sleep 2
  done
) &

# Hand off to tor as the unprivileged package user.
exec runuser -u debian-tor -- tor -f /etc/tor/torrc.services
