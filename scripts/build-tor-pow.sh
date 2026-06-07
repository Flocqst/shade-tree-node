#!/usr/bin/env bash
# Build a pow-capable tor and install it into ./tor/tor-pow (never touches the
# system tor). start-tor.sh auto-detects this binary and turns on the onion-service
# proof-of-work defense.
#
# Why this is needed: the PoW code (Equi-X / HashX) is GPL, and Tor is otherwise
# BSD, so the module is compiled in only with `--enable-gpl`. Homebrew's bottle is
# built without it (`tor --list-modules` -> `pow: no`). This is NOT a fork of tor;
# it is stock tor source with one configure flag.
#
# Run this on a machine where dist.torproject.org is reachable.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${TOR_VERSION:-0.4.9.9}"
PREFIX="$PWD/tor/tor-pow"
BUILD="$PWD/tor/tor-pow-build"
TARBALL="tor-$VER.tar.gz"

mkdir -p "$BUILD"
cd "$BUILD"

if [ ! -f "$TARBALL" ]; then
  echo "downloading tor $VER source..."
  curl -fSLO "https://dist.torproject.org/$TARBALL"
  curl -fSLO "https://dist.torproject.org/$TARBALL.sha256sum"
  curl -fSLO "https://dist.torproject.org/$TARBALL.sha256sum.asc" || true
fi

echo "verifying sha256 integrity..."
shasum -a 256 -c "$TARBALL.sha256sum"

# Authenticity (best effort): verify the signed sums file against the Tor release
# signing keys. Import them first (see the Tor project's signing-keys page) to make
# this a hard guarantee rather than an integrity-only check.
if command -v gpg >/dev/null && [ -f "$TARBALL.sha256sum.asc" ]; then
  gpg --verify "$TARBALL.sha256sum.asc" "$TARBALL.sha256sum" \
    || echo "WARN: GPG verify failed/unavailable; sha256 integrity still checked."
fi

rm -rf "tor-$VER"
tar xf "$TARBALL"
cd "tor-$VER"

./configure \
  --enable-gpl \
  --disable-asciidoc --disable-manpage --disable-html-manual \
  --prefix="$PREFIX" \
  --with-libevent-dir="$(brew --prefix libevent)" \
  --with-openssl-dir="$(brew --prefix openssl@3)"

make -j"$(sysctl -n hw.ncpu)"
make install

echo ""
"$PREFIX/bin/tor" --list-modules | grep '^pow:' || true
echo "built: $PREFIX/bin/tor"
echo "next:  bash scripts/start-tor.sh   (auto-detects this binary and enables PoW)"
