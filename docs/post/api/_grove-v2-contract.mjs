import { verify as verifyBytes } from "node:crypto";

export const GROVE_V2_SNAPSHOT_URL = "https://api.github.com/repos/dmarzzz/shade-tree-node/contents/grove-v2.json?ref=network-state";
export const GROVE_V2_MAX_BYTES = 64 * 1024;
export const GROVE_V2_FETCH_TIMEOUT_MS = 4_000;
export const GROVE_V2_NETWORK = "sepolia";

const GROVE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA377fAP+xg5aKu7AzQa7yB3NMpFpquPSIgs3TcQtVSYI=
-----END PUBLIC KEY-----`;
const GROVE_KEY_ID = "grove-2026-08";
const HOUR_MS = 60 * 60_000;

export class GroveV2SnapshotError extends Error {
  constructor(code) { super(code); this.name = "GroveV2SnapshotError"; this.code = code; }
}
function fail(code) { throw new GroveV2SnapshotError(code); }
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function safeCount(value) { return Number.isInteger(value) && value >= 0 && value <= 100_000; }
function decimalU64(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  try { const n = BigInt(value); return n <= (1n << 64n) - 1n ? n : null; } catch { return null; }
}
function isoMillis(value) {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function validRelayWindow(value, hours, relay) {
  const available = value?.status === "available";
  const start = isoMillis(value?.windowStart);
  const end = isoMillis(value?.windowEnd);
  const base = exactKeys(value, available
    ? ["status", "windowHours", "windowStart", "windowEnd", "reportingNodes", "roundedBytes"]
    : ["status", "windowHours", "windowStart", "windowEnd", "reportingNodes", "suppressionReason"])
    && value.windowHours === hours
    && Number.isFinite(start) && Number.isFinite(end)
    && end - start === hours * HOUR_MS
    && end <= isoMillis(relay.generatedAt) - relay.delayHours * HOUR_MS
    && safeCount(value.reportingNodes);
  if (!base) return false;
  if (available) {
    const rounded = decimalU64(value.roundedBytes);
    const bucket = decimalU64(relay.rounding.bucketBytes);
    return value.reportingNodes >= relay.minimumCohort && rounded > 0n && rounded % bucket === 0n;
  }
  return value.status === "suppressed"
    && ["minimum-cohort", "unavailable"].includes(value.suppressionReason)
    && value.roundedBytes === undefined;
}

function validRelay(value, observedAt) {
  const generatedAt = isoMillis(value?.generatedAt);
  return exactKeys(value, ["definition", "unit", "generatedAt", "delayHours", "minimumCohort", "rounding", "windows"])
    && value.definition === "payload-bytes-relayed"
    && value.unit === "bytes"
    && Number.isFinite(generatedAt)
    && generatedAt >= observedAt - HOUR_MS
    && generatedAt <= observedAt + 5 * 60_000
    && value.delayHours >= 6
    && Number.isInteger(value.minimumCohort) && value.minimumCohort >= 5
    && exactKeys(value.rounding, ["method", "bucketBytes"])
    && value.rounding.method === "ceiling"
    && decimalU64(value.rounding.bucketBytes) > 0n
    && exactKeys(value.windows, ["sixHour", "twentyFourHour"])
    && validRelayWindow(value.windows.sixHour, 6, value)
    && validRelayWindow(value.windows.twentyFourHour, 24, value);
}

export function validGroveV2Snapshot(value, { now = Date.now(), maxAgeMs = 60 * 60_000 } = {}) {
  const observedAt = isoMillis(value?.observedAt);
  const history = value?.history;
  const historyValid = Array.isArray(history) && history.length >= 1 && history.length <= 97
    && history.every((sample, index) => {
      const at = isoMillis(sample?.at);
      const prior = index > 0 ? isoMillis(history[index - 1].at) : -Infinity;
      return exactKeys(sample, ["at", "announced"]) && at > prior && at <= observedAt && safeCount(sample.announced);
    });
  return exactKeys(value, ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "relay", "attestation"])
    && value.schema === "shade-tree-public-grove-v2"
    && value.network === GROVE_V2_NETWORK
    && Number.isFinite(observedAt)
    && observedAt <= now + 5 * 60_000
    && observedAt >= now - maxAgeMs
    && exactKeys(value.source, ["bootnodeReachable", "directoryVerified", "definition", "cadenceMinutes"])
    && value.source.bootnodeReachable === true
    && value.source.directoryVerified === true
    && value.source.definition === "announced-within-ttl"
    && value.source.cadenceMinutes === 15
    && exactKeys(value.nodes, ["announced"]) && safeCount(value.nodes.announced)
    && exactKeys(value.growth, ["windowHours", "announcedNodeHours", "samples"])
    && value.growth.windowHours === 24
    && (value.growth.announcedNodeHours === null
      || (Number.isInteger(value.growth.announcedNodeHours) && value.growth.announcedNodeHours >= 0 && value.growth.announcedNodeHours <= 2_400_000))
    && value.growth.samples === history?.length
    && exactKeys(value.privacy, ["identities", "locations", "traffic", "stablePositions", "futureSharedStatsMinReportingNodes"])
    && value.privacy.identities === false && value.privacy.locations === false && value.privacy.traffic === false
    && value.privacy.stablePositions === false && value.privacy.futureSharedStatsMinReportingNodes === 5
    && historyValid && isoMillis(history.at(-1).at) === observedAt
    && validRelay(value.relay, observedAt)
    && exactKeys(value.attestation, ["algorithm", "keyId", "signature"])
    && value.attestation.algorithm === "Ed25519" && value.attestation.keyId === GROVE_KEY_ID
    && /^[A-Za-z0-9+/]{86}==$/.test(value.attestation.signature);
}

export function groveV2SigningPayload(snapshot) {
  return {
    schema: snapshot.schema,
    network: snapshot.network,
    observedAt: snapshot.observedAt,
    source: {
      bootnodeReachable: snapshot.source.bootnodeReachable,
      directoryVerified: snapshot.source.directoryVerified,
      definition: snapshot.source.definition,
      cadenceMinutes: snapshot.source.cadenceMinutes,
    },
    nodes: { announced: snapshot.nodes.announced },
    growth: {
      windowHours: snapshot.growth.windowHours,
      announcedNodeHours: snapshot.growth.announcedNodeHours,
      samples: snapshot.growth.samples,
    },
    privacy: {
      identities: snapshot.privacy.identities,
      locations: snapshot.privacy.locations,
      traffic: snapshot.privacy.traffic,
      stablePositions: snapshot.privacy.stablePositions,
      futureSharedStatsMinReportingNodes: snapshot.privacy.futureSharedStatsMinReportingNodes,
    },
    history: snapshot.history.map((sample) => ({ at: sample.at, announced: sample.announced })),
    relay: {
      definition: snapshot.relay.definition,
      unit: snapshot.relay.unit,
      generatedAt: snapshot.relay.generatedAt,
      delayHours: snapshot.relay.delayHours,
      minimumCohort: snapshot.relay.minimumCohort,
      rounding: {
        method: snapshot.relay.rounding.method,
        bucketBytes: snapshot.relay.rounding.bucketBytes,
      },
      windows: {
        sixHour: { ...snapshot.relay.windows.sixHour },
        twentyFourHour: { ...snapshot.relay.windows.twentyFourHour },
      },
    },
  };
}

export function verifyGroveV2Snapshot(snapshot, publicKey = GROVE_PUBLIC_KEY) {
  try {
    return verifyBytes(null, Buffer.from(JSON.stringify(groveV2SigningPayload(snapshot)), "utf8"), publicKey, Buffer.from(snapshot.attestation.signature, "base64"));
  } catch { return false; }
}

async function boundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GROVE_V2_MAX_BYTES) fail("upstream-too-large");
  if (!response.body) fail("upstream-empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GROVE_V2_MAX_BYTES) { await reader.cancel().catch(() => {}); fail("upstream-too-large"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof GroveV2SnapshotError) throw error;
    fail("upstream-encoding");
  }
}

export async function loadGroveV2Snapshot(fetchImpl = globalThis.fetch, { now = Date.now() } = {}) {
  let response;
  try {
    response = await fetchImpl(GROVE_V2_SNAPSHOT_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github.raw+json", "Cache-Control": "no-cache", "User-Agent": "shade-tree-grove-api", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GROVE_V2_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") fail("upstream-timeout");
    fail("upstream-unreachable");
  }
  if (response.status !== 200) fail("upstream-http");
  const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!["application/json", "text/plain", "application/vnd.github.raw+json"].includes(mediaType)) fail("upstream-content-type");
  let snapshot;
  try { snapshot = JSON.parse(await boundedText(response)); }
  catch (error) { if (error instanceof GroveV2SnapshotError) throw error; fail("upstream-json"); }
  if (!validGroveV2Snapshot(snapshot, { now })) fail("snapshot-schema");
  if (!verifyGroveV2Snapshot(snapshot)) fail("snapshot-attestation");
  return snapshot;
}
