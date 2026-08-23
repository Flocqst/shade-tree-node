import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  aggregateAnnouncedNodeHours,
  attestPublicGroveSnapshot,
  buildPublicGroveSnapshot,
  grovePublicKeyRawBase64,
  GROVE_HISTORY_CAP,
  scrubGroveHistory,
  verifyPublicGroveAttestation,
} from "../lib/public-grove.mjs";
import { collectPublicGrove } from "./grove-snapshot.mjs";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const onion = (char) => char.repeat(56) + ".onion";
const gateways = [
  { onion: onion("a"), pubkey: "11".repeat(32), operator: "0x" + "22".repeat(20), health: "up", caps: { region: "na" } },
  { onion: onion("b"), pubkey: "33".repeat(32), operator: "0x" + "44".repeat(20), health: "down", caps: { region: "eu" } },
];
const directory = { version: 1, issued: Math.floor(NOW.getTime() / 1000), signer: "55".repeat(32), signature: "66".repeat(64), gateways };
const keypair = generateKeyPairSync("ed25519");
const privateKey = keypair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keypair.publicKey.export({ type: "spki", format: "pem" });

const previousUnsigned = buildPublicGroveSnapshot({
  directory,
  observedAt: new Date("2026-08-23T11:45:00.000Z"),
  network: "sepolia",
});
const previous = attestPublicGroveSnapshot(previousUnsigned, privateKey);

const snapshot = buildPublicGroveSnapshot({ directory, previous, previousPublicKey: publicKey, observedAt: NOW, network: "sepolia" });
assert.equal(snapshot.schema, "shade-tree-public-grove-v1");
assert.deepEqual(snapshot.nodes, { announced: 2 });
assert.equal(snapshot.source.directoryVerified, true);
assert.equal(snapshot.source.definition, "announced-within-ttl");
assert.equal(snapshot.history.length, 2);
assert.equal(snapshot.growth.announcedNodeHours, 0); // 2 nodes * 15 minutes, floored to whole hours
assert.equal(aggregateAnnouncedNodeHours([
  { at: "2026-08-23T11:00:00.000Z", announced: 2 },
  { at: "2026-08-23T11:30:00.000Z", announced: 2 },
  { at: "2026-08-23T12:00:00.000Z", announced: 2 },
], { now: NOW }), 2);

const serialized = JSON.stringify(snapshot);
for (const secret of [gateways[0].onion, gateways[1].onion, gateways[0].pubkey, gateways[0].operator, "region", "caps", "markedDown"]) {
  assert.equal(serialized.includes(secret), false, `public snapshot omits ${secret.slice(0, 16)}`);
}
assert.deepEqual(Object.keys(snapshot).sort(), ["growth", "history", "network", "nodes", "observedAt", "privacy", "schema", "source"]);
assert.ok(snapshot.history.every((sample) => Object.keys(sample).sort().join(",") === "announced,at"));

const signed = attestPublicGroveSnapshot(snapshot, privateKey);
assert.equal(verifyPublicGroveAttestation(signed, publicKey), true);
assert.equal(grovePublicKeyRawBase64(publicKey).length, 44);
assert.equal(verifyPublicGroveAttestation({ ...signed, nodes: { announced: 99 } }, publicKey), false);

const wrongNetworkPrevious = attestPublicGroveSnapshot(buildPublicGroveSnapshot({
  directory,
  observedAt: new Date("2026-08-23T11:45:00.000Z"),
  network: "other",
}), privateKey);
assert.equal(buildPublicGroveSnapshot({
  directory,
  previous: wrongNetworkPrevious,
  previousPublicKey: publicKey,
  observedAt: NOW,
  network: "sepolia",
}).history.length, 1, "cross-network history is discarded");

const tamperedPrevious = structuredClone(previous);
tamperedPrevious.history[0].announced = 100_000;
assert.equal(buildPublicGroveSnapshot({
  directory,
  previous: tamperedPrevious,
  previousPublicKey: publicKey,
  observedAt: NOW,
  network: "sepolia",
}).history.length, 1, "unauthenticated history is discarded");

const oversized = { history: Array.from({ length: GROVE_HISTORY_CAP * 3 }, (_, index) => ({
  at: new Date(NOW.getTime() - index * 60_000).toISOString(),
  announced: index % 5,
  identity: onion("d"),
})) };
assert.equal(scrubGroveHistory(oversized, { now: NOW }).length, GROVE_HISTORY_CAP);
assert.equal(JSON.stringify(scrubGroveHistory(oversized, { now: NOW })).includes("identity"), false);
assert.ok(scrubGroveHistory(oversized, { now: NOW }).every((sample) => Object.keys(sample).sort().join(",") === "announced,at"));

const collected = await collectPublicGrove({
  previous: null,
  network: "test",
  observedAt: NOW,
  signingKey: privateKey,
  observe: async () => ({ result: { ok: true, signerOk: true, directoryFresh: true }, directory }),
});
assert.equal(collected.nodes.announced, 2);
assert.equal(verifyPublicGroveAttestation(collected, publicKey), true);
await assert.rejects(
  collectPublicGrove({ signingKey: privateKey, observe: async () => ({ result: { ok: false, signerOk: false, directoryFresh: false }, directory: null }) }),
  /no verified bootnode directory/,
);
await assert.rejects(
  collectPublicGrove({ observe: async () => ({ result: { ok: true, signerOk: true, directoryFresh: true }, directory }) }),
  /signing key required/,
);

console.log("PASS: public grove snapshot selftest");
