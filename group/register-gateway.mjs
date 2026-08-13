// register-gateway: stake a gateway operator bond into GatewayRegistry (contracts/GatewayRegistry.sol).
//
// This is OPTIONAL — bootnode admission defaults to `open` and a gateway can announce with only
// its onion-control signature. Stake it when you want the bootnode/clients to be able to require
// skin-in-the-game (admission=stake), or simply to fund the address that will pay gas to slash
// member over-spenders. The stake binds to the operator ADDRESS (msg.sender), never to an onion,
// so one stake can back many/rotating onions and the fleet is never enumerable on chain.
//
// After staking, authorize your onion off chain and hand it to the heartbeat:
//   RGOE_GW_OPERATOR_KEY=<this key> rgoe heartbeat --bootnode <onion>
// (the heartbeat signs operatorAuthMessage(onion, operator) durably; see bootnode/heartbeat.mjs).
//
// Config:
//   RGOE_RPC_URL           JSON-RPC endpoint            (default: deployed.rpcUrl or anvil)
//   RGOE_GATEWAY_REGISTRY  GatewayRegistry address      (default: deployed.gatewayRegistry)
//   RGOE_REGISTER_KEY      operator private key         (default: anvil account #1)
//   RGOE_BOND              bond in wei                  (default: on-chain BOND())

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYED_PATH = join(HERE, "..", "contracts", "deployed.local.json");
// anvil's deterministic account #1 — dev only, so the member (#0) and gateway operators differ.
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function readDeployed() {
  try { return JSON.parse(await readFile(DEPLOYED_PATH, "utf8")); } catch { return {}; }
}

async function main() {
  const deployed = await readDeployed();
  const rpcUrl = process.env.RGOE_RPC_URL || deployed.rpcUrl || "http://127.0.0.1:8545";
  const address = process.env.RGOE_GATEWAY_REGISTRY || deployed.gatewayRegistry || deployed.GatewayRegistry;
  const key = process.env.RGOE_REGISTER_KEY || ANVIL_KEY_1;
  if (!address) {
    console.error("no GatewayRegistry address: set RGOE_GATEWAY_REGISTRY or write contracts/deployed.local.json");
    process.exit(1);
  }

  let ethers;
  try { ({ ethers } = await import("ethers")); }
  catch { console.error("register-gateway needs the `ethers` dependency."); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const abi = ["function register() payable", "function BOND() view returns (uint256)", "function isStaked(address) view returns (bool)"];
  const contract = new ethers.Contract(address, abi, wallet);

  if (await contract.isStaked(wallet.address)) {
    console.log(`operator ${wallet.address} is already staked; nothing to do.`);
    return;
  }
  const bond = process.env.RGOE_BOND ?? (await contract.BOND());
  console.log(`register gateway operator`);
  console.log(`  contract: ${address}`);
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  operator: ${wallet.address}`);
  console.log(`  bond:     ${bond} wei`);

  const tx = await contract.register({ value: bond });
  console.log(`  tx:       ${tx.hash}  (waiting...)`);
  const rcpt = await tx.wait();
  console.log(`  mined in block ${rcpt.blockNumber}; operator staked. Authorize your onion via the heartbeat.`);
}

main().catch((e) => { console.error("register-gateway failed:", e.shortMessage || e.message); process.exit(1); });
