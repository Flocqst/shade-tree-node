import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GET } from "../docs/post/api/grove.mjs";
import {
  GROVE_MAX_BYTES,
  GROVE_SNAPSHOT_URL,
  validGroveSnapshot,
  verifyGroveSnapshot,
} from "../docs/post/api/_grove-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(await readFile(join(ROOT, "docs/post/grove/network.fallback.json"), "utf8"));
const originalFetch = globalThis.fetch;
const originalError = console.error;
const checks = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`  ok   ${name}`);
}

function upstream(body, { status = 200, contentType = "text/plain; charset=utf-8" } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}

async function requestWith(fetchImpl) {
  globalThis.fetch = fetchImpl;
  return GET();
}

try {
  check("reference snapshot passes API schema validation", validGroveSnapshot(snapshot));
  check("reference snapshot passes API attestation verification", verifyGroveSnapshot(snapshot));
  check("network label cannot pass through regular-expression coercion", !validGroveSnapshot({ ...snapshot, network: null }));
  check("numeric timestamps cannot pass through Date.parse coercion", !validGroveSnapshot({
    ...snapshot,
    observedAt: 0,
    history: snapshot.history.map((sample, index) => index === snapshot.history.length - 1 ? { ...sample, at: 0 } : sample),
  }));
  check("non-canonical timestamps are rejected", !validGroveSnapshot({
    ...snapshot,
    observedAt: snapshot.observedAt.replace(".000Z", "Z"),
    history: snapshot.history.map((sample, index) => index === snapshot.history.length - 1
      ? { ...sample, at: sample.at.replace(".000Z", "Z") }
      : sample),
  }));

  let upstreamCall = null;
  const success = await requestWith(async (url, options) => {
    upstreamCall = { url, options };
    return upstream(snapshot);
  });
  check("API requests only the fixed signed-snapshot source", upstreamCall.url === GROVE_SNAPSHOT_URL);
  check("API fetch is bounded by a signal and refuses redirects", upstreamCall.options.signal instanceof AbortSignal && upstreamCall.options.redirect === "error");
  check("API returns a successful JSON response", success.status === 200 && success.headers.get("content-type") === "application/json; charset=utf-8");
  check("API returns the signed envelope unchanged", JSON.stringify(await success.json()) === JSON.stringify(snapshot));
  check("API gives browsers a short cache", success.headers.get("cache-control") === "public, max-age=60");
  check("API gives Vercel a five-minute stale-while-revalidate cache", success.headers.get("vercel-cdn-cache-control") === "public, max-age=300, stale-while-revalidate=3600");
  check("API does not opt into cross-origin browser reads", success.headers.get("access-control-allow-origin") === null);

  console.error = () => {};
  for (const [name, body, options] of [
    ["bad signature", { ...snapshot, attestation: { ...snapshot.attestation, signature: `B${snapshot.attestation.signature.slice(1)}` } }],
    ["extra field", { ...snapshot, directory: { gateways: [] } }],
    ["wrong content type", JSON.stringify(snapshot), { contentType: "text/html" }],
    ["oversized response", "x".repeat(GROVE_MAX_BYTES + 1)],
  ]) {
    const response = await requestWith(async () => upstream(body, options));
    check(`${name} fails closed with 503`, response.status === 503);
    check(`${name} failure is not cached`, response.headers.get("cache-control") === "no-store");
    check(`${name} does not reflect upstream details`, await response.text() === '{"error":"network_snapshot_unavailable"}\n');
  }

  const upstreamFailure = await requestWith(async () => upstream("unavailable", { status: 502 }));
  check("upstream HTTP failure returns 503", upstreamFailure.status === 503);
  check("upstream HTTP failure suggests a bounded retry", upstreamFailure.headers.get("retry-after") === "60");
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
}

console.log(`PASS: Grove API selftest (${checks.length} checks)`);
