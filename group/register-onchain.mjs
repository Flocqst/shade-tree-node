// register-onchain: stake a self-enrolled commitment into the on-chain
// StakedReputationSet (docs/ONCHAIN.md). The sibling of self-enrollment: enroll.mjs
// generates the identity locally and emits the commitment; this posts that
// commitment with the fixed BOND so the member is admitted to the *canonical*,
// tamper-evident on-chain root the gateway reads through its RootProvider.
//
// register() is permissionless: anyone may pay the bond for any commitment, but
// only the secret-holder can ever spend or exit it. In production the bond is
// funded from a Layer-0 shielded (Railgun / Privacy Pools) fresh address so the
// funding identity never links to the member (R1). For the local anvil demo we
// fund from a well-known anvil dev key.
//
// Usage:
//   node group/register-onchain.mjs <commitment>
//   node group/enroll.mjs --commitment-only | node group/register-onchain.mjs
//
// Config (all overridable by env; defaults read contracts/deployed.local.json):
//   RGOE_RPC_URL        JSON-RPC endpoint         (default: deployed.rpcUrl or anvil)
//   RGOE_GROUP_CONTRACT StakedReputationSet addr  (default: deployed.StakedReputationSet)
//   RGOE_REGISTER_KEY   funding private key       (default: anvil account #0)
//   RGOE_BOND           bond in wei               (default: deployed.bond or on-chain BOND())
//
// NB: needs the `ethers` dependency (see final report). Imported lazily so this
// file still parses without it.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYED_PATH = join(HERE, "..", "contracts", "deployed.local.json");

// anvil's deterministic account #0 — dev only, funded on a fresh anvil.
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function readDeployed() {
  try {
    return JSON.parse(await readFile(DEPLOYED_PATH, "utf8"));
  } catch {
    return {}; // fall back entirely to env
  }
}

async function readCommitment() {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("--")) return arg.trim();
  // else read a single commitment from stdin (pipe from enroll --commitment-only)
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8").trim();
  if (s) return s.split(/\s+/)[0];
  console.error("usage: node group/register-onchain.mjs <commitment>   (or pipe one on stdin)");
  process.exit(1);
}

async function main() {
  const commitment = await readCommitment();
  const deployed = await readDeployed();

  const rpcUrl = process.env.RGOE_RPC_URL || deployed.rpcUrl || "http://127.0.0.1:8545";
  const address = process.env.RGOE_GROUP_CONTRACT || deployed.StakedReputationSet || deployed.address;
  const key = process.env.RGOE_REGISTER_KEY || ANVIL_KEY_0;
  if (!address) {
    console.error("no StakedReputationSet address: set RGOE_GROUP_CONTRACT or write contracts/deployed.local.json");
    process.exit(1);
  }

  let ethers;
  try {
    ({ ethers } = await import("ethers"));
  } catch {
    console.error("register-onchain needs the `ethers` dependency (add it to package.json; see report).");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const abi = [
    "function register(uint256 commitment) payable",
    "function BOND() view returns (uint256)",
    "function isActive(uint256 commitment) view returns (bool)",
  ];
  const contract = new ethers.Contract(address, abi, wallet);

  const bond = process.env.RGOE_BOND ?? deployed.bond ?? (await contract.BOND());

  console.log(`register(${commitment})`);
  console.log(`  contract: ${address}`);
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  from:     ${wallet.address}`);
  console.log(`  bond:     ${bond} wei`);

  const tx = await contract.register(commitment, { value: bond });
  console.log(`  tx:       ${tx.hash}  (waiting for confirmation...)`);
  const rcpt = await tx.wait();
  console.log(`  mined in block ${rcpt.blockNumber}; member staked and admitted to the on-chain root.`);
}

main().catch((e) => {
  console.error("register failed:", e.shortMessage || e.message);
  process.exit(1);
});
