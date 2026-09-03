#!/usr/bin/env node
// Recompute the normalized public-stake-v1 runtime identities from Foundry artifacts.
// Run after `forge build` or `forge test`; CI fails if source/compiler output drifts without
// an explicitly reviewed manifest update.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "deploy/v4/public-stake-v1-bytecode.json"), "utf8"));
const fail = (message) => { throw new Error(`public-stake-v1 bytecode manifest: ${message}`); };
const cleanRanges = (ranges) => ranges.map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start || a.length - b.length);

if (manifest.schemaVersion !== 1 || manifest.profile !== "public-stake-v1") fail("wrong schema/profile");
if (JSON.stringify(manifest.compiler) !== JSON.stringify({ solc: "0.8.24", optimizer: true, runs: 200 })) fail("compiler pin drifted from foundry.toml");
if (Object.keys(manifest.contracts || {}).sort().join(",") !== "groth16,hasher,staking,withdrawVerifier") fail("contract graph is incomplete or has unknown entries");
if (Object.keys(manifest.libraries || {}).sort().join(",") !== "PoseidonT2,PoseidonT3") fail("linked-library graph is incomplete or has unknown entries");
if (Object.keys(manifest.libraryAddresses || {}).sort().join(",") !== "PoseidonT2,PoseidonT3") fail("linked-library addresses are incomplete or have unknown entries");

for (const section of ["contracts", "libraries"]) {
  for (const [name, spec] of Object.entries(manifest[section] || {})) {
    const artifact = JSON.parse(readFileSync(join(ROOT, "out", spec.artifact), "utf8"));
    const bytecode = artifact?.deployedBytecode?.object;
    if (typeof bytecode !== "string") fail(`${name}: missing Foundry deployedBytecode`);
    let normalized = bytecode.replace(/^0x/, "");
    const metadataLength = Number.parseInt(normalized.slice(-4), 16) + 2;
    const metadataRange = { start: normalized.length / 2 - metadataLength, length: metadataLength };
    const requiredRanges = cleanRanges([
      ...Object.values(artifact.deployedBytecode.immutableReferences || {}).flat(),
      ...Object.values(spec.links || {}).flat(),
      ...(section === "libraries" ? [{ start: 1, length: 20 }] : []),
      metadataRange,
    ]);
    const zeroRanges = cleanRanges(spec.zeroRanges);
    if (JSON.stringify(zeroRanges) !== JSON.stringify(requiredRanges)) fail(`${name}.zeroRanges does not cover exactly its immutables, links, library self-address, and metadata`);
    for (const [library, ranges] of Object.entries(spec.links || {})) {
      const expected = manifest.libraryAddresses[library]?.toLowerCase().replace(/^0x/, "");
      if (!expected || ranges.some(({ start, length }) => length !== 20 || normalized.slice(start * 2, (start + length) * 2).toLowerCase() !== expected)) {
        fail(`${name}: compiled link does not equal pinned ${library} address`);
      }
    }
    for (const { start, length } of zeroRanges) {
      normalized = normalized.slice(0, start * 2) + "0".repeat(length * 2) + normalized.slice((start + length) * 2);
    }
    if (!/^[0-9a-f]*$/i.test(normalized)) fail(`${name}: unresolved bytecode placeholders remain`);
    const actual = {
      runtimeBytes: normalized.length / 2,
      normalizedSha256: createHash("sha256").update(Buffer.from(normalized, "hex")).digest("hex"),
      zeroRanges,
    };
    for (const field of ["runtimeBytes", "normalizedSha256"]) {
      if (JSON.stringify(actual[field] ?? null) !== JSON.stringify(spec[field] ?? null)) fail(`${name}.${field} does not match current Foundry output`);
    }
  }
}

console.log("public-stake-v1 bytecode manifest matches current Foundry output");
