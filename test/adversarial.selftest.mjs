// Auditor-facing ADVERSARIAL SCENARIO suite for the discovery / directory / announce trust
// surface. The unit selftests (lib/directory.selftest.mjs, bootnode/selftest.mjs,
// test/fuzz.selftest.mjs) prove each primitive in isolation. THIS file does something
// different: it composes the real modules into end-to-end ATTACK scenarios, so an auditor has
// ONE place that reads "here is the attack, here is the attack executed against the real code,
// here is the proof it is defeated." Nothing here re-tests a unit assertion for its own sake;
// every check is the punchline of an attack narrative.
//
//   node test/adversarial.selftest.mjs
//
// Exit 0 = every modelled attack was defeated. No Tor, no chain, no real RLN proofs — this is
// the trust surface a client leans on BEFORE it ever dials a gateway (who is in the directory,
// did they prove control, is the operator staked), which is exactly where forgery is cheapest.
//
// Attacks covered:
//   1. POISONED DIRECTORY  — hostile bootnode signer grafts an onion it does not control.
//   2. MITM BOOTNODE       — the served directory is tampered on the wire / re-signed hostile.
//   3. FORGED ANNOUNCE     — the full announce forgery matrix against the live registry.
//   4. STAKE LAPSE         — an operator staked at announce time later unstakes.
//   5. REGISTRY DoS        — mint->announce flood + weight-grab against the DoS controls.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateOnionIdentity } from "../bootnode/keygen.mjs";
import { buildAnnounce, operatorAuthMessage, canonicalAnnounceBytes } from "../bootnode/announce.mjs";
import { makeRegistry, makeServer, loadOrMintSigner } from "../bootnode/server.mjs";
import { MockStakeVerifier } from "../lib/gateway-registry.mjs";
import {
  signDirectory, verifyDirectory, onionToPubkey, pubkeyToOnion, pickGateway,
} from "../lib/directory.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };
const note = (msg) => console.log(`  note ${msg}`);

async function getJson(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}
async function postJson(base, path, body) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "rgoe-adversarial-"));
  try {
    // Real onion identities used across the scenarios. Each `.onion` IS its ed25519 identity
    // key; whoever holds the seed controls the address and only they can sign for it.
    const victim   = await generateOnionIdentity(join(work, "victim"),   { label: "victim" });   // an honest gateway
    const attacker = await generateOnionIdentity(join(work, "attacker"), { label: "attacker" }); // the address traffic would be diverted to
    const honest   = await generateOnionIdentity(join(work, "honest"),   { label: "honest" });

    // =====================================================================================
    // SCENARIO 1 — POISONED DIRECTORY
    // The bootnode's OWN signer key is hostile (or stolen). It signs a directory that grafts
    // the attacker's onion under the VICTIM's pubkey: "this is the victim's gateway, dial it
    // here." The client PINS this very signer, so signature + provenance both pass. The graft
    // must still die on the onion<->pubkey binding: a v3 address IS a key, and the attacker's
    // address does not encode the victim's key.
    // =====================================================================================
    console.log("SCENARIO 1 — poisoned directory (hostile signer grafts an onion):");
    const hostileSigner = await loadOrMintSigner(join(work, "hostile-signer.key"));

    const poisoned = signDirectory({
      version: 1, issued: 1_000, signer: hostileSigner.pub,
      gateways: [{ onion: attacker.onion, pubkey: victim.pub, weight: 100, health: "up" }], // GRAFT
    }, hostileSigner.priv);

    // Sanity: this is a genuinely, correctly signed directory under the pinned signer — the
    // attack is NOT a broken signature. It fails purely on the address<->key binding.
    ok(onionToPubkey(poisoned.gateways[0].onion) !== poisoned.gateways[0].pubkey, "graft entry: onion address does not encode the claimed pubkey");
    const v1 = verifyDirectory(poisoned, hostileSigner.pub);
    ok(v1.ok === false && v1.reason?.startsWith("pubkey-onion-mismatch"), "client rejects the grafted onion (pubkey-onion-mismatch) even though it pins this signer");

    // Second face of the same attack: a directory that is perfectly well-formed but signed by
    // a signer the client did NOT pin. Provenance alone defeats it, before any binding check.
    const strangerSigner = await loadOrMintSigner(join(work, "stranger-signer.key"));
    const cleanButUnpinned = signDirectory({
      version: 1, issued: 1_001, signer: strangerSigner.pub,
      gateways: [{ onion: honest.onion, pubkey: honest.pub, weight: 100, health: "up" }],
    }, strangerSigner.priv);
    const v1b = verifyDirectory(cleanButUnpinned, hostileSigner.pub); // client pins the hostile/real signer, not the stranger
    ok(v1b.ok === false && v1b.reason === "signer-not-pinned", "directory signed by a non-pinned signer rejected (signer-not-pinned)");

    // =====================================================================================
    // SCENARIO 2 — MITM BOOTNODE
    // A real, honest bootnode serves a real signed directory. An on-path attacker (or a later-
    // compromised bootnode) swaps one entry's onion to the attacker's address so the client
    // dials the attacker while believing it is the honest gateway. Two variants:
    //   (a) MITM without the signer key — swaps the onion, cannot re-sign -> signature breaks.
    //   (b) MITM WITH the signer key    — re-signs the swap -> still dies on the binding.
    // =====================================================================================
    console.log("\nSCENARIO 2 — MITM bootnode (directory tampered on the wire):");
    const signer = await loadOrMintSigner(join(work, "signer.key"));
    const registry = makeRegistry({ signer, stake: MockStakeVerifier({}), admission: "open", ttlSec: 900, minReannounceSec: 0 });
    const server = makeServer(registry, { signerPub: signer.pub });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      ok((await postJson(base, "/announce", buildAnnounce({ onion: honest.onion, weight: 100, onionSeedHex: honest.seed }))).json.ok === true, "honest gateway announces to the real bootnode");
      const served = (await getJson(base, "/directory")).json;
      ok(verifyDirectory(served, signer.pub).ok, "the untampered served directory verifies against the pinned signer (baseline)");

      // (a) on-path swap, attacker has NO signer key: the onion is a signed field, so the
      //     signature over the canonical bytes no longer holds.
      const wireTampered = JSON.parse(JSON.stringify(served));
      wireTampered.gateways[0].onion = attacker.onion; // divert traffic, keep the honest pubkey
      const v2a = verifyDirectory(wireTampered, signer.pub);
      ok(v2a.ok === false && v2a.reason === "bad-signature", "on-path onion swap without the signer key breaks the signature (bad-signature)");

      // (b) the bootnode itself is hostile and re-signs after the swap with the REAL signer key.
      //     A validly-re-signed directory STILL cannot carry an onion whose key the signer does
      //     not encode: the binding is checked independently of who signed the list.
      const reSigned = signDirectory({
        version: served.version, issued: served.issued, signer: signer.pub,
        gateways: [{ onion: attacker.onion, pubkey: honest.pub, weight: 100, health: "up" }],
      }, signer.priv);
      const v2b = verifyDirectory(reSigned, signer.pub);
      ok(v2b.ok === false && v2b.reason?.startsWith("pubkey-onion-mismatch"), "even a validly-re-signed directory cannot bind the attacker's onion to the honest key (pubkey-onion-mismatch)");
    } finally {
      await new Promise((r) => server.close(r));
    }

    // =====================================================================================
    // SCENARIO 3 — FORGED ANNOUNCE (the attack matrix)
    // Everything an attacker can put in an /announce to get a gateway they do not control (or a
    // stale/replayed/unstaked one) admitted, run against the REAL registry.announce path. Each
    // row is a distinct forgery; each must be rejected with its specific reason.
    // =====================================================================================
    console.log("\nSCENARIO 3 — forged announce matrix (against the live registry):");
    const clock3 = 2_000_000;
    const reg3 = makeRegistry({ signer, stake: MockStakeVerifier({}), admission: "open", ttlSec: 900, minReannounceSec: 0, now: () => clock3 });

    // row 0 — control: an honest announce is accepted (so the rejections below are the forgery,
    // not a broken harness).
    ok((await reg3.announce(buildAnnounce({ onion: honest.onion, weight: 100, onionSeedHex: honest.seed, ts: clock3 }))).ok === true, "control: an honest announce is accepted");

    // row 1 — forged onion signature (attacker does not hold the onion's key).
    const forged = buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: victim.seed, ts: clock3 });
    forged.onionSig = forged.onionSig.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    ok((await reg3.announce(forged)).reason === "bad-onion-sig", "forged onion signature rejected (bad-onion-sig)");

    // row 2 — onion signed by the WRONG key (announces victim's address using attacker's seed).
    ok((await reg3.announce(buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: attacker.seed, ts: clock3 }))).reason === "bad-onion-sig", "onion signed by a key that is not the address rejected (bad-onion-sig)");

    // row 3 — stale timestamp (a captured announce replayed far outside the freshness window).
    ok((await reg3.announce(buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: victim.seed, ts: clock3 - 9_999 }))).reason?.startsWith("stale-ts"), "stale-dated announce rejected (stale-ts)");

    // row 4 — replayed nonce (a valid announce captured and re-submitted verbatim in-window).
    const replay = buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: victim.seed, ts: clock3 });
    ok((await reg3.announce(replay)).ok === true, "first submission of a fresh announce accepted");
    ok((await reg3.announce(replay)).reason === "replayed-nonce", "verbatim replay of the same announce rejected (replayed-nonce)");

    // rows 5-6 — stake mode: an operator that never staked, and a stolen operator signature.
    const { ethers } = await import("ethers");
    const opWallet = ethers.Wallet.createRandom();
    const operator = opWallet.address;
    const opSig = await opWallet.signMessage(operatorAuthMessage(honest.onion, operator));
    const clockS = 2_100_000;
    const regStake = makeRegistry({ signer, stake: MockStakeVerifier({ allowlist: operator }), admission: "stake", ttlSec: 900, minReannounceSec: 0, now: () => clockS });

    ok((await regStake.announce(buildAnnounce({ onion: honest.onion, weight: 100, onionSeedHex: honest.seed, operator, operatorSig: opSig, ts: clockS }))).staked === true, "control: staked+authorized operator admitted and labelled staked");

    // row 5 — an operator not in the staked set (authorized signature, but no live stake).
    const stranger = ethers.Wallet.createRandom();
    const strangerSig = await stranger.signMessage(operatorAuthMessage(victim.onion, stranger.address));
    ok((await regStake.announce(buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: victim.seed, operator: stranger.address, operatorSig: strangerSig, ts: clockS }))).reason === "not-staked", "unstaked operator rejected in stake mode (not-staked)");

    // row 6 — a stolen operator signature: opSig authorizes honest.onion, reused for victim.onion.
    ok((await regStake.announce(buildAnnounce({ onion: victim.onion, weight: 100, onionSeedHex: victim.seed, operator, operatorSig: opSig, ts: clockS }))).reason === "bad-operator-sig", "operator signature bound to a different onion (stolen sig) rejected (bad-operator-sig)");

    // =====================================================================================
    // SCENARIO 4 — STAKE LAPSE MID-SESSION
    // An operator is staked when it announces, is admitted, and appears in the directory. Later
    // it UNSTAKES (revocation == unstake). We model the chain by an isStaked that flips to false
    // and assert the lapse is observable/enforced by the three checks that actually run today.
    // =====================================================================================
    console.log("\nSCENARIO 4 — stake lapse mid-session (operator unstakes after admission):");
    let onChainStaked = true;
    const flippingStake = { isStaked: async () => onChainStaked, mode: "mock:flip" };
    let clock4 = 3_000_000;
    const reg4 = makeRegistry({ signer, stake: flippingStake, admission: "stake", ttlSec: 900, minReannounceSec: 0, now: () => clock4 });

    const opSig4 = await opWallet.signMessage(operatorAuthMessage(honest.onion, operator));
    const admit = await reg4.announce(buildAnnounce({ onion: honest.onion, weight: 100, onionSeedHex: honest.seed, operator, operatorSig: opSig4, ts: clock4 }));
    ok(admit.ok === true && admit.staked === true, "operator staked at announce time -> admitted and listed");
    ok(reg4.directory().gateways.some((g) => g.onion === honest.onion), "gateway is present in the served directory while staked");

    // ---- the operator unstakes on chain ----
    onChainStaked = false;

    // Enforcement 1 (live, works today): the raw on-chain read now returns false. Any client
    // doing the T-DEV-5 re-check would see the lapse directly.
    ok((await flippingStake.isStaked(operator)) === false, "after unstake the live on-chain isStaked(operator) returns false (observable to any re-checker)");

    // Enforcement 2 (live, works today): the entry cannot REFRESH. On the next heartbeat the
    // re-announce is rejected (not-staked), so the entry drops at TTL rather than living forever.
    clock4 += 10;
    const refresh = await reg4.announce(buildAnnounce({ onion: honest.onion, weight: 100, onionSeedHex: honest.seed, operator, operatorSig: opSig4, ts: clock4 }));
    ok(refresh.ok === false && refresh.reason === "not-staked", "an unstaked operator's re-announce is refused (not-staked) -> entry drops at TTL, cannot persist");

    // Enforcement 3 (PENDING): the bootnode's *already-served* directory still carries the stale
    // `staked` label until TTL/refresh. Closing that gap mid-session requires the CLIENT to
    // re-check GET /gateway/<onion> + isStaked itself and not trust the bootnode's label.
    const stale = reg4.directory().gateways.find((g) => g.onion === honest.onion);
    ok(stale && stale.staked === true, "bootnode's cached directory still shows staked=true (stale-positive) until TTL — this is the gap");
    note("client-side mid-session re-verification is PENDING T-DEV-5 (docs/SHIP-PLAN.md:103): the client must fetch GET /gateway/<onion> and re-check operatorSig + isStaked itself. Today the lapse is enforced on refresh + observable via the live on-chain read (asserted above), but the served label is not yet re-verified by the client mid-session.");

    // =====================================================================================
    // SCENARIO 5 — REGISTRY DoS
    // An attacker mints onions for free and floods /announce to (a) exhaust registry memory and
    // (b) self-assign a colossal selection weight to capture ~all client traffic (a concentration
    // / deanonymization lever). The size cap, per-onion throttle, and weight clamp must hold.
    // =====================================================================================
    console.log("\nSCENARIO 5 — registry DoS (mint->announce flood + weight grab):");
    let clock5 = 4_000_000;
    const MAX = 3;
    const regDoS = makeRegistry({ signer, stake: MockStakeVerifier({}), admission: "open", ttlSec: 900, maxEntries: MAX, minReannounceSec: 5, now: () => clock5 });

    // Flood: mint FLOOD fresh onions (all crypto-valid — the attacker really holds each key) and
    // announce them. The registry must never grow past MAX; overflow onions get registry-full.
    const FLOOD = 8;
    let fullRejects = 0;
    const floodOnions = [];
    for (let i = 0; i < FLOOD; i++) {
      const id = await generateOnionIdentity(join(work, `flood-${i}`), { label: `flood-${i}` });
      floodOnions.push(id);
      const r = await regDoS.announce(buildAnnounce({ onion: id.onion, weight: 100, onionSeedHex: id.seed, ts: clock5 }));
      if (r.reason === "registry-full") fullRejects++;
    }
    ok(regDoS.size() === MAX, `registry size stays bounded at maxEntries=${MAX} under a ${FLOOD}-onion flood (never grows unbounded)`);
    ok(fullRejects === FLOOD - MAX, `every overflow onion is refused with registry-full (${fullRejects}/${FLOOD - MAX})`);

    // Per-onion throttle: an already-resident onion cannot spin the expensive verify path by
    // re-announcing inside the window; it is rejected cheaply BEFORE verification.
    const resident = floodOnions[0];
    ok((await regDoS.announce(buildAnnounce({ onion: resident.onion, weight: 100, onionSeedHex: resident.seed, ts: clock5 }))).reason === "rate-limited", "a resident onion re-announcing inside the window is rate-limited (cheap pre-verify reject)");

    // Weight grab: a gateway self-attests an astronomical weight to win ~100% of client picks.
    // The clamp caps it at MAX_WEIGHT=1000, so it can never dominate a fleet of honestly-weighted
    // peers. We prove the clamp AND that the resulting selection share is bounded, not ~100%.
    let clockW = 5_000_000;
    const regW = makeRegistry({ signer, stake: MockStakeVerifier({}), admission: "open", ttlSec: 900, minReannounceSec: 0, now: () => clockW });
    await regW.announce(buildAnnounce({ onion: attacker.onion, weight: 1e12, onionSeedHex: attacker.seed, ts: clockW })); // greedy
    await regW.announce(buildAnnounce({ onion: honest.onion, weight: 1000, onionSeedHex: honest.seed, ts: clockW }));   // honest peer at max
    await regW.announce(buildAnnounce({ onion: victim.onion, weight: 1000, onionSeedHex: victim.seed, ts: clockW }));   // honest peer at max
    const dirW = regW.directory();
    const greedy = dirW.gateways.find((g) => g.onion === attacker.onion);
    ok(greedy.weight === 1000, "self-attested weight 1e12 is clamped to MAX_WEIGHT=1000 in the signed directory");

    // Empirically: with the clamp, the greedy gateway wins ~1/3 of picks against two equal peers,
    // NOT the ~100% its 1e12 claim intended. (Unclamped, 1e12/(1e12+2000) ~= 0.9999999998.)
    let greedyWins = 0;
    const N = 6000;
    for (let i = 0; i < N; i++) if (pickGateway(dirW)?.onion === attacker.onion) greedyWins++;
    const share = greedyWins / N;
    ok(share < 0.6, `weight clamp bounds the greedy gateway's traffic share to ${(share * 100).toFixed(1)}% (~33% expected; unclamped it would be ~100%), so it cannot capture the fleet`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: adversarial scenario suite (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
