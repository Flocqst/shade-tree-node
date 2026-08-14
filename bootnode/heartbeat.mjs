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
import { checkEgress, EGRESS_CHECK_TARGET } from "../gateway/gateway.mjs";

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

// ---- egress-gated announce (T-FEAT-16) --------------------------------------
// Before EACH announce, probe this host's clearnet egress (a metadata-only TCP connect to a
// well-known :443 host — see checkEgress in gateway/gateway.mjs). If egress is DOWN, SKIP the
// announce: a broken gateway then ages out of the bootnode /directory via its TTL instead of
// staying listed and DROPping every member routed to it. When egress recovers, the next beat
// finds it healthy and announcing resumes — no state to reset. The probe runs once per beat
// (throttling is unnecessary at heartbeat cadence, default 300s).
//
// Off-switch: RGOE_EGRESS_CHECK=0 disables the check and announces UNCONDITIONALLY (today's
// behavior), so a fresh/offline env (no working egress yet, or a test box) is never blocked.
//
// Factored out and fully injectable (announce + egress + enabled) so the selftest asserts the
// gating with a fake checkEgress and a fake announce — no Tor, no real network.
export function egressCheckEnabled() {
  return String(process.env.RGOE_EGRESS_CHECK ?? "1") !== "0";
}

export async function announceIfHealthy({ announce, egress, enabled = egressCheckEnabled() }) {
  if (!enabled) return announce(); // check disabled: announce unconditionally (current behavior)
  const r = await egress();
  if (!r.healthy) {
    console.log(`egress DOWN (${r.target} ${r.reason}); SKIP announce — gateway ages out of the bootnode via TTL`);
    return { skipped: true, egress: r };
  }
  return announce();
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
  console.log(egressCheckEnabled()
    ? `egress self-check: ON (metadata-only TCP connect to ${EGRESS_CHECK_TARGET} before each announce; SKIP announce if DOWN). Disable with RGOE_EGRESS_CHECK=0`
    : "egress self-check: OFF (RGOE_EGRESS_CHECK=0) — announcing unconditionally");

  const beat = async () => {
    try {
      const r = await announceIfHealthy({
        announce: () => announceOnce({ id, bootnode, op, weight, torHost, torPort }),
        egress: () => checkEgress(),
      });
      if (r && r.skipped) return; // egress DOWN: announce already logged + skipped
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
