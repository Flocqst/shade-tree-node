// T-FEAT-7 gateway unit tests (fast lane, no chain): the root-SOURCE resolution (RGOE_ROOTS /
// the static+onchain union default), the ABI-file `roots:` startup line, and the ROUTING slasher
// (makeRoutingSlasher over a fake `ethers` — a reconstructed secret is slashed on the contract
// whose limitOf() holds its leaf; none => the primary gets the default claim). The anvil end-to-end
// twin is test/paid-access.selftest.mjs (slow lane).
//
//   node gateway/root-sources.selftest.mjs

import { resolveRootSources, describeRootSources, makeRoutingSlasher, makeOnchainSlasher, PAID_MIN_LEAVES } from "./gateway.mjs";
import { identityFor, identitySecretOf, deriveCommitment, K_SLOTS } from "../lib/rln.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// A fake `ethers` whose Contract answers the slasher's probes from a per-address table:
//   { tiered: bool, tiers: [..], holds: { commitment: limit }, active: Set } and records slash calls.
function fakeEthers(table, calls) {
  class Contract {
    constructor(address) { this.address = address; this.t = table[address]; if (!this.t) throw new Error("unknown contract " + address); }
    async DEFAULT_LIMIT() { if (!this.t.tiered) throw new Error("no DEFAULT_LIMIT"); return 8n; }
    async allowedLimits() { return (this.t.tiers || [8]).map(BigInt); }
    async limitOf(c) { return BigInt(this.t.holds?.[String(c)] || 0); }
    async isActive(c) { return !!this.t.active?.has(String(c)); }
    async "slash(uint256,uint256,uint256,address)"(leaf, secret, limit, receiver) { calls.push({ via: this.address, leaf: String(leaf), limit: Number(limit), receiver }); return { hash: "0xtx" + calls.length, wait: async () => ({ blockNumber: 7 }) }; }
    async "slash(uint256,uint256,address)"(leaf, secret, receiver) { calls.push({ via: this.address, leaf: String(leaf), limit: null, receiver }); return { hash: "0xtx" + calls.length, wait: async () => ({ blockNumber: 7 }) }; }
  }
  return { Contract };
}

async function main() {
  console.log("root sources + routing slasher (T-FEAT-7):");
  const A = { address: "0xA", kind: "staked" }, P = { address: "0xP", kind: "paid" };

  // 1. RGOE_ROOTS resolution
  {
    let r = resolveRootSources({ spec: "", contracts: [], staticExists: true });
    ok(r.static === true && r.onchain === false, "no contract, members.json present -> static only (PoC path)");
    r = resolveRootSources({ spec: "", contracts: [], staticExists: false });
    ok(r.static === true && r.onchain === false, "no contract, no members.json -> still static (loadGroup reports the missing file, as before)");
    r = resolveRootSources({ spec: "", contracts: [A], staticExists: true });
    ok(r.static === true && r.onchain === true, "contract + members.json -> UNION by default (friends keep egressing)");
    r = resolveRootSources({ spec: "", contracts: [A, P], staticExists: false });
    ok(r.static === false && r.onchain === true, "contracts, no members.json -> on-chain only");
    r = resolveRootSources({ spec: "onchain", contracts: [A], staticExists: true });
    ok(r.static === false && r.onchain === true && r.explicit, "RGOE_ROOTS=onchain -> chain alone even with members.json present");
    r = resolveRootSources({ spec: "static", contracts: [A], staticExists: true });
    ok(r.static === true && r.onchain === false, "RGOE_ROOTS=static -> ignore configured contracts");
    r = resolveRootSources({ spec: " Static , ONCHAIN ", contracts: [A], staticExists: true });
    ok(r.static && r.onchain, "RGOE_ROOTS=static,onchain (case/space tolerant) -> both");
    let threw = null;
    try { resolveRootSources({ spec: "onchain", contracts: [], staticExists: true }); } catch (e) { threw = e.message; }
    ok(/no contract is configured/.test(threw || ""), "RGOE_ROOTS=onchain without a contract is a config error");
    threw = null;
    try { resolveRootSources({ spec: "chain", contracts: [A], staticExists: true }); } catch (e) { threw = e.message; }
    ok(/unknown source "chain"/.test(threw || ""), "an unknown source name is rejected");
  }

  // 2. the ABI-file startup line
  {
    ok(describeRootSources({ static: true, contracts: [A, P] }) === "roots: members.json + staked(0xA) + paid(0xP)", "`roots: members.json + staked(0x..) + paid(0x..)`");
    ok(describeRootSources({ static: false, contracts: [P] }) === "roots: paid(0xP)", "paid alone");
    ok(describeRootSources({ static: true, contracts: [] }) === "roots: members.json", "static alone");
    ok(PAID_MIN_LEAVES === 8, "paid floor default K=8 (RGOE_PAID_MIN_LEAVES)");
  }

  // 3. routing slasher over a fake ethers
  {
    const secret = identitySecretOf(identityFor("0x1234"));
    const leaf8 = deriveCommitment(secret, 8), leaf32 = deriveCommitment(secret, 32);
    const secretB = identitySecretOf(identityFor("0x5678"));
    const leafB8 = deriveCommitment(secretB, 8);
    const secretC = identitySecretOf(identityFor("0x9abc"));
    const calls = [];
    const ethers = fakeEthers({
      "0xV3": { tiered: false, active: new Set([leafB8]) },                    // rln-v3 primary holds B at tier 8
      "0xA": { tiered: true, tiers: [8, 32], holds: {} },                       // staked set holds nobody
      "0xP": { tiered: true, tiers: [8, 32], holds: { [leaf32]: 32 } },         // paid set holds A's tier-32 leaf
    }, calls);
    const wallet = {};
    const route = await makeRoutingSlasher({ ethers, wallet, contracts: [{ address: "0xV3", kind: "primary" }, A, P], receiver: "0xR" });
    ok(route.slashers.length === 3 && route.slashers[0].slash.tiered() === false && route.slashers[2].slash.tiered() === true, "one slasher per contract; v3 vs tiered detected per contract");

    // secret A: unresolved locally (default tier named) -> paid holds leaf32 -> slashed on 0xP at limit 32
    let r = await route(leaf8, secret, { commitment: leaf8, limit: K_SLOTS, resolved: false });
    ok(r.contract === "0xP" && r.limit === 32 && r.commitment === leaf32 && calls.at(-1).via === "0xP" && calls.at(-1).limit === 32, "over-spender held by the PAID set -> slash routed to 0xP at its tier (32), leaf recomputed there");
    // secret B: rln-v3 primary holds it (isActive) -> 3-arg slash on 0xV3
    r = await route(leafB8, secretB, { commitment: leafB8, limit: 8, resolved: false });
    ok(r.contract === "0xV3" && calls.at(-1).via === "0xV3" && calls.at(-1).limit === null, "over-spender held by the rln-v3 primary -> 3-arg slash there");
    // secret C: nobody holds it -> primary gets the default claim (revert on record), nothing elsewhere
    const before = calls.length;
    r = await route(deriveCommitment(secretC, 8), secretC, { commitment: deriveCommitment(secretC, 8), limit: 8, resolved: false });
    ok(r.contract === "0xV3" && calls.length === before + 1 && calls.at(-1).via === "0xV3", "held by nobody -> the default claim goes to the primary only");
    // locally-resolved tier (members.json leaf) still routes by holder, not by the local guess
    r = await route(leaf8, secret, { commitment: leaf8, limit: 8, resolved: true });
    ok(r.contract === "0xP" && r.limit === 32, "a locally-resolved tier does not override the on-chain holder");
    // holds() probe failure on one contract skips it (never blocks the others)
    const bad = fakeEthers({ "0xA": { tiered: true, tiers: [8], holds: {} }, "0xP": { tiered: true, tiers: [8, 32], holds: { [leaf32]: 32 } } }, calls);
    const origLimitOf = bad.Contract.prototype.limitOf;
    bad.Contract.prototype.limitOf = async function (c) { if (this.address === "0xA") throw new Error("rpc down"); return origLimitOf.call(this, c); };
    const route2 = await makeRoutingSlasher({ ethers: bad, wallet, contracts: [A, P], receiver: "0xR" });
    r = await route2(leaf8, secret, { commitment: leaf8, limit: 8, resolved: false });
    ok(r.contract === "0xP", "a contract whose probe throws is skipped; the holder is still found");
    // single-contract slasher: holds() exposed
    const single = await makeOnchainSlasher({ ethers, wallet, address: "0xP", receiver: "0xR" });
    ok((await single.holds(secret)).limit === 32 && (await single.holds(secretC)) === null && single.address === "0xP", "makeOnchainSlasher.holds(secret) names the tier the contract holds (or null)");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: root-sources selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
