// T-TEST-11: golden cross-implementation test vectors. Re-derive every deterministic value in
// testdata/vectors.json from its fixed seeds and assert a byte-exact match. This is two things:
//   1. a REGRESSION GUARD for the JS canonical formats (change the serialization or signing and
//      this fails, so a silent wire-format change cannot slip through), and
//   2. the ANTI-DRIFT CONTRACT for the coming Rust client (T-RUST-1): the Rust implementation MUST
//      reproduce these exact bytes/signatures, so the two clients cannot diverge on the wire.
//
// ed25519 (RFC 8032) is deterministic, so directory + announce signatures are pinned exactly.
// RLN Groth16 proofs are NOT deterministic (random blinding), so they are verified for equivalence
// elsewhere (lib/rln.selftest.mjs), not byte-pinned here.
//
//   node test/vectors.selftest.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { ed25519Sign, ed25519PrivateKey, pubkeyToOnion, onionToPubkey, canonicalDirectoryBytes, signDirectory, verifyDirectory } from "../lib/directory.mjs";
import { canonicalAnnounceBytes, operatorAuthMessage, verifyOperatorSig } from "../bootnode/announce.mjs";
import { calculateSignalHash, requestSignal } from "../lib/rln.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "..", "testdata", "vectors.json"), "utf8"));

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };
const pubFromSeed = (s) => { const d = createPublicKey(ed25519PrivateKey(s)).export({ format: "der", type: "spki" }); return Buffer.from(d.subarray(d.length - 32)).toString("hex"); };

async function main() {
  console.log("key derivation:");
  ok(pubFromSeed(V.signerSeed) === V.signerPub, "signer pubkey re-derives from its seed");
  ok(pubFromSeed(V.onionSeed) === V.onionPub, "onion pubkey re-derives from its seed");
  ok(pubkeyToOnion(V.onionPub) === V.onion, "onion address re-derives from the pubkey");
  ok(onionToPubkey(V.onion) === V.onionPub, "onion decodes back to the pubkey");

  console.log("\ndirectory (deterministic canonical bytes + ed25519 signature):");
  const dir = { version: 1, issued: 1000000, gateways: [{ onion: V.onion, pubkey: V.onionPub, weight: 100, health: "up" }] };
  ok(canonicalDirectoryBytes(dir).toString("hex") === V.canonicalDirectoryBytesHex, "canonical directory bytes match the pinned vector");
  const signed = signDirectory({ ...dir, signer: V.signerPub }, V.signerSeed);
  ok(signed.signature === V.directorySignature, "directory signature matches the pinned vector (ed25519 determinism)");
  ok(verifyDirectory(signed, V.signerPub).ok, "the pinned signed directory verifies against the pinned signer");

  console.log("\nannounce (deterministic canonical bytes + onion signature):");
  ok(canonicalAnnounceBytes(V.announce).toString("hex") === V.canonicalAnnounceBytesHex, "canonical announce bytes match the pinned vector");
  ok(ed25519Sign(canonicalAnnounceBytes(V.announce), V.onionSeed) === V.announceOnionSig, "announce onion signature matches the pinned vector");

  console.log("\noperator authorization:");
  ok(operatorAuthMessage(V.onion, V.operator) === V.operatorAuthMessage, "operator-auth message matches the pinned vector");
  // and the pinned message, signed by ANY operator key, must verify against that operator (round-trip)
  const { ethers } = await import("ethers");
  const w = new ethers.Wallet("0x" + "34".repeat(32));
  const sig = await w.signMessage(operatorAuthMessage(V.onion, w.address));
  ok(await verifyOperatorSig(V.onion, w.address, sig), "operator-auth message signs + verifies round-trip");

  console.log("\nsignal hash (deterministic keccak256(utf8(message)) >> 8):");
  // The circuit public x, byte-pinned so the Rust port can conformance-check it (T-RUST-1b).
  const sh = V.signalHash;
  ok(
    calculateSignalHash(requestSignal(sh.target, sh.nonce)).toString() === sh.signalHashDecimal,
    "calculateSignalHash(requestSignal(target,nonce)) matches the pinned decimal"
  );

  console.log("\nstaked-announce operator (pinned key + EIP-191 personal_sign):");
  // Round-trip against the PINNED sig (not a freshly-generated one): the byte-pinned
  // operatorSig must recover the pinned operator address.
  const oa = V.operatorAnnounce;
  ok(
    (await import("ethers")).ethers.verifyMessage(operatorAuthMessage(V.onion, oa.operator), oa.operatorSig).toLowerCase()
      === oa.operator.toLowerCase(),
    "pinned operatorSig recovers the pinned operator (raw ethers recover)"
  );
  ok(
    await verifyOperatorSig(V.onion, oa.operator, oa.operatorSig),
    "verifyOperatorSig(onion, operator, operatorSig) === true against the pinned sig"
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: vectors selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
