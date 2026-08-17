#!/usr/bin/env bash
# End-to-end RLN interop check (T-RUST-2b RLN-INTEROP).
#
#   Rust builds an RLN Groth16 envelope proof against the repo's circom-rln
#   artifacts; the JS reference (lib/rln.mjs verifyEnvelope) ACCEPTS it; and a
#   cross-impl over-spend reconstructs the identity secret from two Rust shares.
#
# Prereqs: `npm install` at the repo root (rlnjs) and a Rust toolchain.
# Run from anywhere: bash rust/rgoe-rln/interop/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CIRCUITS="$REPO/circuits/rln"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== building rust probe =="
cargo build -p rgoe-rln --bin rgoe-rln-probe --manifest-path "$REPO/rust/Cargo.toml"
PROBE="$REPO/rust/target/debug/rgoe-rln-probe"

echo "== fixture A (nonce #1) =="
node "$HERE/fixture-gen.mjs" 0123456789abcdef0123456789abcdef > "$WORK/fixtureA.json"
"$PROBE" "$WORK/fixtureA.json" "$WORK/envA.json" "$CIRCUITS"

echo "== fixture B (same slot/epoch, nonce #2 -> different x) =="
node "$HERE/fixture-gen.mjs" ffffffffffffffffffffffffffffffff > "$WORK/fixtureB.json"
"$PROBE" "$WORK/fixtureB.json" "$WORK/envB.json" "$CIRCUITS"

echo "== JS verifyEnvelope must ACCEPT the Rust envelope =="
node "$HERE/verify-envelope.mjs" "$WORK/envA.json"

echo "== cross-impl over-spend reconstruction =="
node "$HERE/overspend.mjs" "$WORK/envA.json" "$WORK/envB.json" "$WORK/fixtureA.json"

echo "== RLN INTEROP OK =="
