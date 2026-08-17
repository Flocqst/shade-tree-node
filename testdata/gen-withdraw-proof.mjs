// Regenerates testdata/withdraw-proof.json — the REAL Groth16 exit-auth proof fixture
// the Foundry test (test/WithdrawVerifier.t.sol) feeds to the on-chain WithdrawVerifier.
//
//   node testdata/gen-withdraw-proof.mjs
//
// Why a committed fixture: Foundry can't build a Groth16 witness, so we snapshot a real
// snarkJS proof (over the committed circuits/rln/withdraw.wasm + withdraw_final.zkey) and
// the Solidity test replays it against the real verifier. Groth16 proofs are randomized,
// so re-running this produces a DIFFERENT-but-valid proof; that's fine — the JSON is a
// golden snapshot, this script exists for reproducibility/audit.
//
// SECRET HYGIENE: the raw identity secret (the proving witness) is NEVER written to the
// fixture — only the proof + public signals + the public commitment/context. The demo
// secret used here is 111 (SECRET_A), already a public constant across the repo's tests;
// it carries zero value. Real deployments never reuse a demo identity.
//
// TESTNET-ONLY: withdraw_final.zkey is circom-rln's untrusted dev phase-2 (see
// circuits/rln/ARTIFACTS.md). Genuine ZK, but not ceremony-trusted (ship-plan T-HARD-1).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as snarkjs from "snarkjs";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { AbiCoder, solidityPackedKeccak256, getAddress } from "ethers";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const wasm = join(ROOT, "circuits/rln/withdraw.wasm");
const zkey = join(ROOT, "circuits/rln/withdraw_final.zkey");
const vkey = JSON.parse(readFileSync(join(ROOT, "circuits/rln/withdraw_verification_key.json"), "utf8"));

// BN254 scalar field; must match WithdrawVerifier.FIELD.
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const K = 8n; // RLN userMessageLimit; must match WithdrawVerifier.K / RateCommitmentHasher.K

// Demo member: identity secret 111 (public SECRET_A). Leaf = RLN rate commitment.
const SECRET = 111n;
const identityCommitment = poseidon1([SECRET]);
const commitment = poseidon2([identityCommitment, K]); // == the membership leaf

// The recipient the withdraw proof is bound to (matches the Foundry test's RECIPIENT).
const RECIPIENT = getAddress("0x000000000000000000000000000000000000bEEF");

// Build the two contexts EXACTLY as StakedReputationSet computes them, then reduce into
// the field to get the circuit's public `address` input.
function ctxExit(c) {
  return solidityPackedKeccak256(["string", "uint256"], ["RGOE_EXIT", c]);
}
function ctxWithdraw(c, recipient) {
  return solidityPackedKeccak256(["string", "uint256", "address"], ["RGOE_WITHDRAW", c, recipient]);
}

const coder = AbiCoder.defaultAbiCoder();

async function proveFor(contextHex) {
  const addr = BigInt(contextHex) % FIELD;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { identitySecret: SECRET.toString(), address: addr.toString() },
    wasm,
    zkey,
  );
  // Sanity: proof is valid and the public signals are what we expect.
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!ok) throw new Error("snarkjs.verify failed for a freshly-generated proof");
  if (publicSignals[0] !== identityCommitment.toString())
    throw new Error(`pubSignals[0] ${publicSignals[0]} != identityCommitment ${identityCommitment}`);
  if (publicSignals[1] !== addr.toString())
    throw new Error(`pubSignals[1] ${publicSignals[1]} != addr ${addr}`);

  // Use exportSolidityCallData so the G2 (b) coordinate swap snarkJS applies is baked in.
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c] = JSON.parse("[" + calldata + "]"); // [a, b, c, pubSignals]

  // proof bytes = abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 idComm)
  const proofBytes = coder.encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]", "uint256"],
    [a, b, c, identityCommitment.toString()],
  );
  return { context: contextHex, address: addr.toString(), proof: proofBytes };
}

async function main() {
  const exitCtx = ctxExit(commitment);
  const withdrawCtx = ctxWithdraw(commitment, RECIPIENT);

  const out = {
    _comment:
      "REAL Groth16 exit-auth proof fixture for test/WithdrawVerifier.t.sol. " +
      "Proof of knowledge of the identity secret behind the membership leaf, bound to the action. " +
      "Regenerate with: node testdata/gen-withdraw-proof.mjs",
    _trust:
      "TESTNET-ONLY: verifier VK is from circom-rln's untrusted dev phase-2 (see circuits/rln/ARTIFACTS.md). " +
      "Not ceremony-trusted until ship-plan T-HARD-1.",
    _secret_note: "The raw identity secret (witness) is intentionally NOT in this fixture; only proof + public signals.",
    circuit: "circom-rln withdraw (RLN slash-side): out = Poseidon(1)([identitySecret]); public [address]",
    pubSignalLayout: ["identityCommitment", "address"],
    K: Number(K),
    commitment: commitment.toString(),
    identityCommitment: identityCommitment.toString(),
    recipient: RECIPIENT,
    exit: await proveFor(exitCtx),
    withdraw: await proveFor(withdrawCtx),
  };

  const path = join(__dir, "withdraw-proof.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", path);
  console.log("commitment        :", out.commitment);
  console.log("identityCommitment:", out.identityCommitment);
  console.log("exit.address      :", out.exit.address);
  console.log("withdraw.address  :", out.withdraw.address);

  // snarkjs spins up worker threads; exit explicitly so the script terminates.
  process.exit(0);
}

main().catch((e) => {
  console.error("FIXTURE GEN FAILED:", e);
  process.exit(1);
});
