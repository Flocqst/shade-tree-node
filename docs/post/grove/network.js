/* global AbortController, atob, crypto, document, navigator, TextEncoder, window */

const LIVE_URL = "/api/grove";
const FALLBACK_URL = "/grove/network.fallback.json";
const FETCH_TIMEOUT_MS = 9_000;
const POLL_INTERVAL_MS = 5 * 60 * 1_000;
const PUBLIC_KEY_RAW = "377fAP+xg5aKu7AzQa7yB3NMpFpquPSIgs3TcQtVSYI=";
const KEY_ID = "grove-2026-08";
const stage = document.getElementById("network-stage");
const canvas = document.getElementById("network-canvas");
const fallback = document.getElementById("canopy-fallback");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let mounted = false;
let sceneController = null;
let sceneSeed = null;
let publicKeyPromise = null;
let lastLiveObservedAt = null;
let loadActive = false;
let pollTimer = 0;

const exactKeys = (value, keys) => value && typeof value === "object"
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safeCount = (value) => Number.isInteger(value) && value >= 0 && value <= 100_000;
const isoMillis = (value) => {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

function validSnapshot(value) {
  const observedAt = isoMillis(value?.observedAt);
  const history = value?.history;
  const historyValid = Array.isArray(history)
    && history.length >= 1
    && history.length <= 96
    && history.every((sample, index) => {
      const at = isoMillis(sample?.at);
      const prior = index > 0 ? isoMillis(history[index - 1].at) : -Infinity;
      return exactKeys(sample, ["at", "announced"])
        && Number.isFinite(at)
        && at > prior
        && at <= observedAt
        && safeCount(sample.announced);
    });
  return value
    && exactKeys(value, ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "attestation"])
    && value.schema === "shade-tree-public-grove-v1"
    && typeof value.network === "string"
    && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value.network)
    && Number.isFinite(observedAt)
    && observedAt <= Date.now() + 5 * 60_000
    && exactKeys(value.source, ["bootnodeReachable", "directoryVerified", "definition", "cadenceMinutes"])
    && value.source?.bootnodeReachable === true
    && value.source?.directoryVerified === true
    && value.source?.definition === "announced-within-ttl"
    && value.source?.cadenceMinutes === 15
    && exactKeys(value.nodes, ["announced"])
    && safeCount(value.nodes.announced)
    && exactKeys(value.growth, ["windowHours", "announcedNodeHours", "samples"])
    && value.growth.windowHours === 24
    && (value.growth.announcedNodeHours === null || (Number.isInteger(value.growth.announcedNodeHours) && value.growth.announcedNodeHours >= 0 && value.growth.announcedNodeHours <= 2_400_000))
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
    && value.attestation.keyId === KEY_ID
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
    history: snapshot.history.map((sample) => ({ at: sample.at, announced: sample.announced })),
  };
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function verifyAttestation(snapshot) {
  try {
    publicKeyPromise ||= crypto.subtle.importKey(
      "raw",
      base64Bytes(PUBLIC_KEY_RAW),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "Ed25519" },
      await publicKeyPromise,
      base64Bytes(snapshot.attestation.signature),
      new TextEncoder().encode(JSON.stringify(signingPayload(snapshot))),
    );
  } catch {
    return false;
  }
}

async function fetchSnapshot(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
    const value = await response.json();
    if (!validSnapshot(value) || !await verifyAttestation(value)) throw new Error("invalid public snapshot");
    return value;
  } finally {
    window.clearTimeout(timeout);
  }
}

function ageParts(iso) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return { short: "now", long: "just now", minutes };
  if (minutes < 60) return { short: `${minutes}m`, long: `${minutes} min ago`, minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { short: `${hours}h`, long: `${hours} hr ago`, minutes };
  const days = Math.floor(hours / 24);
  return { short: `${days}d`, long: `${days} days ago`, minutes };
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function drawFallback(snapshot) {
  fallback.replaceChildren();
  const count = Math.min(snapshot.nodes.announced, 28);
  const random = randomFrom(hashSeed(`${snapshot.observedAt}:${count}`));
  for (let index = 0; index < count; index += 1) {
    const angle = index * 2.399963 + random() * 0.8;
    const progress = Math.sqrt((index + 0.7) / Math.max(1, count));
    const x = 41 + Math.cos(angle) * progress * 31 + (random() - 0.5) * 8;
    const y = 48 + Math.sin(angle) * progress * 34 + (random() - 0.5) * 8;
    const size = Math.max(17, 36 - Math.sqrt(count) * 2 + random() * 9);
    const tree = document.createElement("span");
    tree.className = "fallback-tree";
    tree.style.setProperty("--x", `${x}%`);
    tree.style.setProperty("--y", `${y}%`);
    tree.style.setProperty("--size", `${size}%`);
    tree.style.setProperty("--turn", `${Math.round((random() - 0.5) * 12)}deg`);
    fallback.append(tree);
  }
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value; });
}

async function renderSnapshot(snapshot, { bundled = false } = {}) {
  const count = snapshot.nodes.announced;
  const age = ageParts(snapshot.observedAt);
  const cadence = Number(snapshot.source.cadenceMinutes) || 15;
  const researchFleet = snapshot.network === "sepolia";
  const stale = bundled || age.minutes > cadence * 3;
  document.body.classList.toggle("is-stale", stale);
  document.body.classList.remove("is-unavailable");
  setText("[data-node-count]", String(count));
  const renderCap = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches ? 24 : 48;
  const compactLabel = window.matchMedia("(max-width: 360px)").matches;
  let elderLabel = compactLabel ? "Elder Tree · not counted" : "Elder Tree · discovery · not counted";
  if (count > renderCap) {
    elderLabel = compactLabel
      ? `Elder · not counted · ${renderCap}/${count} shown`
      : `Elder Tree · discovery · not counted · ${renderCap} of ${count} nodes shown`;
  }
  setText("[data-elder-label]", elderLabel);
  setText("[data-hero-count]", String(count));
  setText("[data-hero-tree-word]", count === 1 ? "tree" : "trees");
  setText("[data-hero-tail]", researchFleet ? "in the research Grove." : "in the Grove.");
  setText("[data-canopy-label]", stale ? "Last verified canopy" : "Current canopy");
  setText("[data-node-hours]", snapshot.growth?.announcedNodeHours == null ? "n/a" : String(snapshot.growth.announcedNodeHours));
  setText("[data-view-age]", age.short);
  setText("[data-snapshot-cadence]", `${cadence}-minute snapshots`);
  const state = bundled
    ? `Signed pre-v4 reference · ${age.long}`
    : stale
      ? `${researchFleet ? "Pre-v4 research census" : "Signed census"} · ${age.long} · stale`
      : `${researchFleet ? "Research census" : "Census"} verified · ${age.long}`;
  setText("[data-view-state]", state);
  drawFallback(snapshot);

  if (!mounted) {
    mounted = true;
    try {
      await mountScene(snapshot);
    } catch {
      stage.classList.remove("is-live");
    }
  } else if (sceneController && sceneSeed !== `${snapshot.observedAt}:${count}`) {
    sceneController.updateSnapshot(snapshot);
    sceneSeed = `${snapshot.observedAt}:${count}`;
  }
}

async function mountScene(snapshot) {
  if (navigator.connection?.saveData) return;
  const lowQuality = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const probe = document.createElement("canvas");
  const context = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true })
    || probe.getContext("webgl", { failIfMajorPerformanceCaveat: true });
  if (!context) return;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  const { mountNetworkGrove } = await import("./scene.js");
  sceneController = mountNetworkGrove({
    stage,
    canvas,
    snapshot,
    reducedMotion,
    quality: lowQuality ? "low" : "high",
  });
  sceneSeed = `${snapshot.observedAt}:${snapshot.nodes.announced}`;
}

function scheduleNextLoad() {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    if (document.hidden) {
      scheduleNextLoad();
      return;
    }
    load();
  }, POLL_INTERVAL_MS);
}

async function load() {
  if (loadActive) return;
  loadActive = true;
  // This pulse represents the browser checking the same-origin signed aggregate. The browser
  // never contacts the onion bootnode. A separate pulse is used when observedAt proves that the
  // upstream observer published a new census.
  document.body.classList.add("is-checking");
  stage.classList.add("is-querying");
  sceneController?.beginQuery();
  try {
    const snapshot = await fetchSnapshot(LIVE_URL);
    const freshCensus = lastLiveObservedAt !== null && lastLiveObservedAt !== snapshot.observedAt;
    await renderSnapshot(snapshot);
    sceneController?.finishQuery(snapshot, { freshCensus });
    lastLiveObservedAt = snapshot.observedAt;
  } catch {
    sceneController?.failQuery();
    try {
      await renderSnapshot(await fetchSnapshot(FALLBACK_URL), { bundled: true });
    } catch {
      document.body.classList.add("is-unavailable");
      setText("[data-view-state]", "Public view unavailable");
      setText("[data-view-age]", "Unavailable");
    }
  } finally {
    loadActive = false;
    document.body.classList.remove("is-checking");
    stage.classList.remove("is-querying");
    scheduleNextLoad();
  }
}

load();

function onPageHide() {
  window.clearTimeout(pollTimer);
}

function onPageShow(event) {
  if (!event.persisted) return;
  load();
}

window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);
