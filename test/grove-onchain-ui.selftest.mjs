import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onchainLedgerModel, validPublicOnchain } from "../docs/post/grove/onchain.js";

const observedAt = Date.parse("2026-08-25T12:00:00.000Z");
const onchain = {
  definition: "finalized-v4-onchain-activity",
  generatedAt: "2026-08-25T12:00:00.000Z",
  delayHours: 6,
  minimumCohort: 5,
  source: {
    chainId: 11155111,
    finalizedBlock: "12345678",
    finalizedBlockHash: `0x${"ab".repeat(32)}`,
    finalizedBlockTime: "2026-08-25T06:00:00.000Z",
    finalityConfirmations: 64,
  },
  membership: {
    definition: "active-commitments-at-finalized-block",
    duplicatePolicy: "separate-contract-classes-no-cross-set-dedup",
    staked: { status: "available", activeCommitments: 12 },
    paid: { status: "suppressed", suppressionReason: "minimum-cohort" },
  },
  settlements: {
    definition: "finalized-settlement-linked-to-finalized-insert",
    attributionRule: "signed-registrar-chain-verified-v1",
    status: "unavailable",
    unavailableReason: "attribution-unavailable",
  },
  enforcement: {
    definition: "finalized-contract-slash-events",
    staked: { status: "suppressed", suppressionReason: "minimum-cohort" },
    paid: { status: "available", finalizedSlashes: 7 },
  },
};

assert.equal(validPublicOnchain(onchain, observedAt), true);
assert.equal(onchainLedgerModel(null), null, "absent onchain data omits the panel");
const model = onchainLedgerModel(onchain);
assert.match(model.membership, /12 staked/);
assert.match(model.membership, /Withheld/);
assert.equal(model.settlements, "Unavailable · attribution not configured");
assert.match(model.enforcement, /7 paid/);
assert.doesNotMatch(JSON.stringify(model), /\b0\b/, "unavailable and suppressed rows never render decorative zero");

const availableSettlement = onchainLedgerModel({
  ...onchain,
  settlements: {
    definition: "finalized-settlement-linked-to-finalized-insert",
    attributionRule: "signed-registrar-chain-verified-v1",
    status: "available",
    completedAccesses: 5,
    atomicValue: "1234500",
    asset: { chainId: 11155111, address: "0x3000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
  },
});
assert.equal(availableSettlement.settlements, "5 completed · 1.2345 USDC");

const html = await readFile(new URL("../docs/post/grove/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../docs/post/grove/grove.css", import.meta.url), "utf8");
assert.match(html, /data-onchain-ledger hidden/);
assert.ok(["membership", "settlements", "enforcement"].every((row) => html.includes(`data-onchain-${row}`)));
assert.match(css, /\.onchain-ledger dl\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, 1fr\)/, "desktop ledger has three compact rows");
assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.onchain-ledger dl\s*\{\s*grid-template-columns:\s*1fr/, "mobile ledger stacks without overflow");

console.log("PASS: Grove onchain browser validation and responsive ledger model");
