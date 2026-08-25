import { verify as verifyBytes } from "node:crypto";

export const GROVE_SNAPSHOT_URL = "https://raw.githubusercontent.com/dmarzzz/shade-tree-node/network-state/grove.json";
export const GROVE_MAX_BYTES = 64 * 1024;
export const GROVE_FETCH_TIMEOUT_MS = 4_000;
export const GROVE_NETWORK = "sepolia";

const GROVE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA377fAP+xg5aKu7AzQa7yB3NMpFpquPSIgs3TcQtVSYI=
-----END PUBLIC KEY-----`;
const GROVE_KEY_ID = "grove-2026-08";

export class GroveSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "GroveSnapshotError";
    this.code = code;
  }
}

function fail(code) {
  throw new GroveSnapshotError(code);
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100_000;
}

function isoMillis(value) {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

export function validGroveSnapshot(value, { now = Date.now() } = {}) {
  const observedAt = isoMillis(value?.observedAt);
  const history = value?.history;
  const historyValid = Array.isArray(history)
    && history.length >= 1
    && history.length <= 97
    && history.every((sample, index) => {
      const at = isoMillis(sample?.at);
      const prior = index > 0 ? isoMillis(history[index - 1].at) : -Infinity;
      return exactKeys(sample, ["at", "announced"])
        && Number.isFinite(at)
        && at > prior
        && at <= observedAt
        && safeCount(sample.announced);
    });

  return exactKeys(value, ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "attestation"])
    && value.schema === "shade-tree-public-grove-v1"
    && value.network === GROVE_NETWORK
    && Number.isFinite(observedAt)
    && observedAt <= now + 5 * 60_000
    && exactKeys(value.source, ["bootnodeReachable", "directoryVerified", "definition", "cadenceMinutes"])
    && value.source.bootnodeReachable === true
    && value.source.directoryVerified === true
    && value.source.definition === "announced-within-ttl"
    && value.source.cadenceMinutes === 15
    && exactKeys(value.nodes, ["announced"])
    && safeCount(value.nodes.announced)
    && exactKeys(value.growth, ["windowHours", "announcedNodeHours", "samples"])
    && value.growth.windowHours === 24
    && (value.growth.announcedNodeHours === null
      || (Number.isInteger(value.growth.announcedNodeHours)
        && value.growth.announcedNodeHours >= 0
        && value.growth.announcedNodeHours <= 2_400_000))
    && Number.isInteger(value.growth.samples)
    && value.growth.samples === history?.length
    && exactKeys(value.privacy, ["identities", "locations", "traffic", "stablePositions", "futureSharedStatsMinReportingNodes"])
    && value.privacy.identities === false
    && value.privacy.locations === false
    && value.privacy.traffic === false
    && value.privacy.stablePositions === false
    && value.privacy.futureSharedStatsMinReportingNodes === 5
    && historyValid
    && isoMillis(history.at(-1).at) === observedAt
    && exactKeys(value.attestation, ["algorithm", "keyId", "signature"])
    && value.attestation.algorithm === "Ed25519"
    && value.attestation.keyId === GROVE_KEY_ID
    && /^[A-Za-z0-9+/]{86}==$/.test(value.attestation.signature);
}

function signingPayload(snapshot) {
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
    history: snapshot.history.map((sample) => ({
      at: sample.at,
      announced: sample.announced,
    })),
  };
}

export function verifyGroveSnapshot(snapshot) {
  try {
    return verifyBytes(
      null,
      Buffer.from(JSON.stringify(signingPayload(snapshot)), "utf8"),
      GROVE_PUBLIC_KEY,
      Buffer.from(snapshot.attestation.signature, "base64"),
    );
  } catch {
    return false;
  }
}

async function boundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GROVE_MAX_BYTES) fail("upstream-too-large");
  if (!response.body) fail("upstream-empty");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GROVE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        fail("upstream-too-large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof GroveSnapshotError) throw error;
    fail("upstream-encoding");
  }
}

export async function loadGroveSnapshot(fetchImpl = globalThis.fetch, { now = Date.now() } = {}) {
  let response;
  try {
    const sourceUrl = new URL(GROVE_SNAPSHOT_URL);
    sourceUrl.searchParams.set("minute", String(Math.floor(now / 60_000)));
    response = await fetchImpl(sourceUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(GROVE_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") fail("upstream-timeout");
    fail("upstream-unreachable");
  }

  if (response.status !== 200) fail("upstream-http");
  const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "text/plain") fail("upstream-content-type");

  let snapshot;
  try {
    snapshot = JSON.parse(await boundedText(response));
  } catch (error) {
    if (error instanceof GroveSnapshotError) throw error;
    fail("upstream-json");
  }

  if (!validGroveSnapshot(snapshot, { now })) fail("snapshot-schema");
  if (!verifyGroveSnapshot(snapshot)) fail("snapshot-attestation");
  return snapshot;
}
