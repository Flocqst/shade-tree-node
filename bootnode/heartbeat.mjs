// Gateway heartbeat: keep this gateway listed on the bootnode.
//
// A bootnode entry is soft-state with a TTL (bootnode/server.mjs): the gateway must re-announce
// periodically or it drops from the fleet. That is deliberate — liveness is proven by continuing
// to announce, so a dead gateway ages out without anyone deregistering it. This loop builds a
// fresh signed announce (fresh ts + nonce) from the gateway's onion identity and POSTs it to the
// bootnode onion over Tor, every RGOE_BOOTNODE_HEARTBEAT seconds.
//
// Config:
//   RGOE_BOOTNODE_ONION     the bootnode to announce to (required)
//   RGOE_GW_IDENTITY        path to the onion identity.local.json { onion, seed }
//                           (bootnode/keygen.mjs; default tor/hs/identity.local.json)
//   RGOE_GW_WEIGHT          selection weight advertised                    (default 100)
//   RGOE_BOOTNODE_HEARTBEAT re-announce interval in seconds                (default 300)
//   RGOE_TOR_HOST/PORT      local Tor SOCKS                                (default 127.0.0.1:9250)
//   stake (optional, admission=stake bootnodes):
//   RGOE_GW_OPERATOR_KEY    operator EOA private key; signs the durable onion<->operator auth, OR
//   RGOE_GW_OPERATOR +      a pre-computed operator address and
//   RGOE_GW_OPERATOR_SIG    its signature over operatorAuthMessage(onion, operator)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAnnounce, operatorAuthMessage } from "./announce.mjs";
import { postOverTor } from "./fetch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadIdentity() {
  const path = process.env.RGOE_GW_IDENTITY || join(HERE, "..", "tor", "hs", "identity.local.json");
  const id = JSON.parse(await readFile(path, "utf8"));
  if (!id.onion || !id.seed) throw new Error(`identity file ${path} missing onion/seed (run bootnode/keygen.mjs)`);
  return id;
}

// Resolve the optional operator-stake authorization once (it is durable across heartbeats).
async function resolveOperator(onion) {
  if (process.env.RGOE_GW_OPERATOR && process.env.RGOE_GW_OPERATOR_SIG) {
    return { operator: process.env.RGOE_GW_OPERATOR, operatorSig: process.env.RGOE_GW_OPERATOR_SIG };
  }
  if (process.env.RGOE_GW_OPERATOR_KEY) {
    const { ethers } = await import("ethers");
    const w = new ethers.Wallet(process.env.RGOE_GW_OPERATOR_KEY);
    return { operator: w.address, operatorSig: await w.signMessage(operatorAuthMessage(onion, w.address)) };
  }
  return { operator: null, operatorSig: null };
}

export async function announceOnce({ id, bootnode, op, weight, torHost, torPort }) {
  const rec = buildAnnounce({ onion: id.onion, weight, onionSeedHex: id.seed, operator: op.operator, operatorSig: op.operatorSig });
  return postOverTor(bootnode, "/announce", rec, { torHost, torPort });
}

async function main() {
  const bootnode = process.env.RGOE_BOOTNODE_ONION;
  if (!bootnode) { console.error("set RGOE_BOOTNODE_ONION (the bootnode to announce to)"); process.exit(1); }
  const intervalSec = Number(process.env.RGOE_BOOTNODE_HEARTBEAT || 300);
  const weight = Number(process.env.RGOE_GW_WEIGHT || 100);
  const torHost = process.env.RGOE_TOR_HOST || "127.0.0.1";
  const torPort = Number(process.env.RGOE_TOR_PORT || 9250);

  const id = await loadIdentity();
  const op = await resolveOperator(id.onion);
  console.log(`heartbeat: ${id.onion.slice(0, 16)}..onion -> ${bootnode.slice(0, 16)}..onion every ${intervalSec}s${op.operator ? ` (operator ${op.operator.slice(0, 10)}..)` : " (onion-only)"}`);

  const beat = async () => {
    try {
      const r = await announceOnce({ id, bootnode, op, weight, torHost, torPort });
      console.log(r.ok ? `announced (staked=${r.staked ?? false}, ttl=${r.ttl}s)` : `announce rejected: ${r.err}`);
    } catch (e) {
      console.log(`announce failed: ${e.message} (will retry next interval)`);
    }
  };
  await beat();
  setInterval(beat, intervalSec * 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
