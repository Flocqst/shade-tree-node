#!/usr/bin/env bash
# Native Rust RLN merkle-tree parity harness (T-RUST-2c).
#
# Proves two things end-to-end, against the SAME rlnjs libraries the gateway uses:
#
#   [A] ROOT PARITY: the native Rust depth-20 Poseidon tree root EQUALS the rlnjs
#       Semaphore-v3 group root over several identical member lists.
#   [B] SINGLE-MEMBER ENVELOPE: a RUST-computed root+path (index 0, all-zero
#       siblings) drives the circom-rln prover and lib/rln.mjs verifyEnvelope ACCEPTS it.
#   [C] MULTI-MEMBER ENVELOPE: a RUST-computed root+path for a member at a NON-zero
#       index (real leaf + real internal-node siblings) drives the prover and
#       verifyEnvelope ACCEPTS it.
#
# The JS side here is only the rlnjs reference (imported from lib/rln.mjs) and small
# inline readers/mergers; no existing .mjs is modified. run.sh (T-RUST-2b) still
# covers the JS-fixture path; this script is the Rust-owned-tree counterpart.
#
# Prereqs: `npm install` at the repo root (rlnjs) and a Rust toolchain.
# Run from anywhere: bash rust/rgoe-rln/interop/tree-run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CIRCUITS="$REPO/circuits/rln"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== building rust probe + tree =="
cargo build -p rgoe-rln --bin rgoe-rln-probe --bin rgoe-rln-tree --manifest-path "$REPO/rust/Cargo.toml"
PROBE="$REPO/rust/target/debug/rgoe-rln-probe"
TREE="$REPO/rust/target/debug/rgoe-rln-tree"

# --- [A] root parity over several member lists --------------------------------
echo "== [A] root parity: Rust tree root == rlnjs group root =="
js_root() { # args: leaves...  -> rlnjs newGroup([...]).root
  node --input-type=module -e '
    import { newGroup } from "'"$REPO"'/lib/rln.mjs";
    console.log(newGroup(process.argv.slice(1).map(BigInt)).root.toString());
  ' "$@"
}
for SET in "111 222 333" "7 8 9 10 11" "42" "1000000 2000000 3000000 4000000"; do
  # shellcheck disable=SC2086
  JS=$(js_root $SET)
  # shellcheck disable=SC2086
  RS=$("$TREE" root $SET)
  if [ "$JS" != "$RS" ]; then
    echo "  FAIL members=[$SET]: js=$JS rust=$RS"; exit 1
  fi
  echo "  OK members=[$SET] root=$RS"
done

# --- [B] single-member envelope with a RUST-computed root+path ----------------
echo "== [B] single-member envelope: RUST root+path -> prover -> verifyEnvelope =="
node "$HERE/fixture-gen.mjs" 0123456789abcdef0123456789abcdef > "$WORK/fixtureB.json"
LEAF=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).leaf)' "$WORK/fixtureB.json")
JSROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).root)' "$WORK/fixtureB.json")
"$TREE" proof 0 "$LEAF" > "$WORK/rustB.json"
RUSTROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).root)' "$WORK/rustB.json")
[ "$JSROOT" = "$RUSTROOT" ] || { echo "  FAIL: rust root ($RUSTROOT) != js root ($JSROOT)"; exit 1; }
echo "  rust root == js root: $RUSTROOT"
node -e '
  const fs=require("fs");
  const fx=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const rt=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  fx.root=rt.root; fx.pathElements=rt.pathElements; fx.identityPathIndex=rt.identityPathIndex;
  fx.ref_publicSignals.root=rt.root;
  fs.writeFileSync(process.argv[3], JSON.stringify(fx,null,2));
' "$WORK/fixtureB.json" "$WORK/rustB.json" "$WORK/fixtureB_rust.json"
"$PROBE" "$WORK/fixtureB_rust.json" "$WORK/envB.json" "$CIRCUITS"
node "$HERE/verify-envelope.mjs" "$WORK/envB.json"

# --- [C] multi-member envelope: member at a NON-zero index --------------------
echo "== [C] multi-member envelope: RUST root+path (real siblings) -> prover -> verifyEnvelope =="
# Build a 3-member group with our real member at index 1 (decoys either side), emit
# the circuit fields + rlnjs reference public signals, WITHOUT any JS merkle path.
node --input-type=module -e '
  import {
    identityFor, identitySecretOf, rateCommitmentOf, newGroup,
    externalNullifierFor, requestSignal, proveForSlot, K_SLOTS, RLN_IDENTIFIER,
    calculateSignalHash, cleanUp,
  } from "'"$REPO"'/lib/rln.mjs";
  import { writeFileSync } from "node:fs";

  const SECRET = "12345678901234567890";
  const EPOCH = 42n, MESSAGE_ID = 3, TARGET = "example.com:443";
  const NONCE = "0123456789abcdef0123456789abcdef";
  const DECOY_A = 987654321n, DECOY_B = 55555555n;

  const identity = identityFor(SECRET);
  const identitySecret = identitySecretOf(identity);
  const leaf = rateCommitmentOf(identity);
  const members = [DECOY_A, leaf, DECOY_B]; // real member at index 1
  const group = newGroup(members);
  const signal = requestSignal(TARGET, NONCE);
  const x = calculateSignalHash(signal);
  const extNull = externalNullifierFor(EPOCH);
  const ref = await proveForSlot(SECRET, EPOCH, MESSAGE_ID, signal, { group });

  const out = {
    secret: SECRET, epoch: String(EPOCH), rlnIdentifier: String(RLN_IDENTIFIER),
    userMessageLimit: String(K_SLOTS), messageId: String(MESSAGE_ID),
    target: TARGET, nonce: NONCE, signal,
    identitySecret: String(identitySecret), leaf: String(leaf),
    members: members.map(String), memberIndex: 1,
    root: String(group.root), // rlnjs multi-member root (Rust will reproduce it)
    x: String(x), externalNullifier: String(extNull),
    ref_publicSignals: {
      y: String(ref.share.y), root: String(group.root),
      nullifier: String(ref.nullifier), x: String(ref.share.x),
      externalNullifier: String(ref.externalNullifier),
    },
  };
  writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
  cleanUp();
' "$WORK/fixtureC.json"

# Rust computes the root + path for member index 1 over the SAME ordered members.
INDEX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).memberIndex)' "$WORK/fixtureC.json")
# members are plain decimal integers (no embedded spaces) -> safe to word-split.
MEMBERS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).members.join(" "))' "$WORK/fixtureC.json")
# shellcheck disable=SC2086
"$TREE" proof "$INDEX" $MEMBERS > "$WORK/rustC.json"
JSROOTC=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).root)' "$WORK/fixtureC.json")
RUSTROOTC=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).root)' "$WORK/rustC.json")
[ "$JSROOTC" = "$RUSTROOTC" ] || { echo "  FAIL: rust root ($RUSTROOTC) != js root ($JSROOTC)"; exit 1; }
echo "  rust root == js root (member idx $INDEX): $RUSTROOTC"
node -e '
  const fs=require("fs");
  const fx=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const rt=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  fx.root=rt.root; fx.pathElements=rt.pathElements; fx.identityPathIndex=rt.identityPathIndex;
  fx.ref_publicSignals.root=rt.root;
  fs.writeFileSync(process.argv[3], JSON.stringify(fx,null,2));
' "$WORK/fixtureC.json" "$WORK/rustC.json" "$WORK/fixtureC_rust.json"
"$PROBE" "$WORK/fixtureC_rust.json" "$WORK/envC.json" "$CIRCUITS"
node "$HERE/verify-envelope.mjs" "$WORK/envC.json"

echo "== RLN MERKLE-TREE PARITY OK (root parity + single-member + multi-member envelopes) =="
