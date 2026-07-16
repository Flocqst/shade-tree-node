// Tiny demo backend for the reputation-gated onion egress.
//
// Serves demo/index.html and two endpoints:
//   GET /api/status  -> the demo member's address + live on-chain staked status + tor state
//   GET /api/run     -> SSE stream of the REAL flow (prove -> Tor -> gateway -> egress),
//                       ending with the gateway egress IP vs. your own IP.
//
// The proving + Tor routing are real (RgoeClient); only staking is assumed done. Config via
// env, with local fallbacks:
//   RGOE_SECRET            member secret (default keys.local.json[RGOE_DEMO_INDEX|0])
//   RGOE_DEMO_WALLET       address to show as the funder (optional, display only)
//   RGOE_DIRECTORY         signed directory json (default network/sepolia/directory.json)
//   RGOE_DIR_SIGNER        directory signer (required for fleet mode)
//   RGOE_TOR_PORT          client Tor SOCKS (default 9260)
//   RGOE_DEMO_PORT         http port (default 8790)
//
// Run:  node demo/server.mjs   (start scripts/start-tor-client.sh first, or let this spawn it)

import http from "node:http";
import net from "node:net";
import https from "node:https";
import { spawn } from "node:child_process";
import { readFile, readFileSync as rfs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { SocksClient } from "socks";
import { RgoeClient } from "../client/rgoe-client.mjs";
import { deriveCommitment, identitySecretOf, identityFor, currentEpoch, K_SLOTS, EPOCH_SECONDS } from "../lib/rln.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = Number(process.env.RGOE_DEMO_PORT || 8790);
const TOR_PORT = Number(process.env.RGOE_TOR_PORT || 9260);
const TARGET = "https://api.ipify.org";

// ---- config: member + directory ---------------------------------------------
const idx = Number(process.env.RGOE_DEMO_INDEX || 0);
const secret = process.env.RGOE_SECRET || JSON.parse(rfs(join(ROOT, "keys.local.json"), "utf8"))[idx].secret;
const wallet = process.env.RGOE_DEMO_WALLET || null;
const dep = JSON.parse(rfs(join(ROOT, "contracts", "deployed.local.json"), "utf8"));
const dirPath = process.env.RGOE_DIRECTORY || join(ROOT, "network", "sepolia", "directory.json");
const dirSigner = process.env.RGOE_DIR_SIGNER || JSON.parse(rfs(dirPath, "utf8")).signer;
const directory = JSON.parse(rfs(dirPath, "utf8"));

const leaf = deriveCommitment(identitySecretOf(identityFor(secret)));
const onionNote = (onion) => {
  const g = (directory.gateways || []).find((x) => x.onion.startsWith(onion));
  return g?.note || onion;
};

const client = new RgoeClient({ secret, directory: dirPath, dirSigner, torPort: TOR_PORT });

// DEMO SAFETY: the member has K_SLOTS nullifiers per epoch. Sending a (K+1)-th request in
// one epoch reuses a slot with a fresh signal — which is exactly the over-spend the gateway
// SLASHES on. So budget requests to K per epoch (and surface it as the live rate limit).
// Start "capped" for the boot epoch so the first real request only fires in a FRESH epoch
// with a clean slot space at the gateway. This makes restarts safe: a restarted server can
// never reuse a slot it already sent this epoch (its pool cursor reset to 0) and get the
// member slashed. Costs up to one epoch of "resets in Ns" at startup (overlaps Tor warmup).
let epUsed = { epoch: currentEpoch(), count: K_SLOTS };
function budget() {
  const ep = currentEpoch();
  if (ep !== epUsed.epoch) epUsed = { epoch: ep, count: 0 };
  const resetIn = EPOCH_SECONDS - (Math.floor(Date.now() / 1000) % EPOCH_SECONDS);
  return { remaining: Math.max(0, K_SLOTS - epUsed.count), perEpoch: K_SLOTS, resetIn };
}

// ---- on-chain status --------------------------------------------------------
const provider = new ethers.JsonRpcProvider(dep.rpcUrl);
const contract = new ethers.Contract(
  dep.stakedReputationSet,
  ["function members(uint256) view returns (uint256 bond,uint64 index,uint64 exitInitiatedAt)", "function BOND() view returns (uint256)"],
  provider
);
async function chainStatus() {
  const [m, BOND] = await Promise.all([contract.members(leaf), contract.BOND()]);
  return {
    staked: m.bond > 0n && m.exitInitiatedAt === 0n,
    bondEth: ethers.formatEther(m.bond),
    denomEth: ethers.formatEther(BOND),
    contract: dep.stakedReputationSet,
    network: "sepolia",
    leaf: leaf.toString(),
  };
}

// ---- your real IP (direct, for contrast) ------------------------------------
let realIp = null;
function fetchRealIp() {
  return new Promise((resolve) => {
    https.get(TARGET, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b.trim())); }).on("error", () => resolve(null));
  });
}

// ---- tor readiness ----------------------------------------------------------
let torReady = false;
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
async function probeOnion() {
  const g = directory.gateways?.[0];
  if (!g) return false;
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: "127.0.0.1", port: TOR_PORT, type: 5 },
      command: "connect", destination: { host: g.onion, port: 80 }, timeout: 25000,
    });
    socket.destroy(); return true;
  } catch { return false; }
}
async function ensureTor() {
  if (!(await portOpen(TOR_PORT))) {
    console.log("client tor not on " + TOR_PORT + " — spawning scripts/start-tor-client.sh");
    spawn("bash", [join(ROOT, "scripts", "start-tor-client.sh")], { cwd: ROOT, stdio: "ignore", detached: true }).unref();
  }
  let streak = 0;
  for (;;) {
    if (await probeOnion()) { if (++streak >= 2) { torReady = true; console.log("tor ready (onions reachable)"); return; } }
    else { streak = 0; torReady = false; }
    await new Promise((r) => setTimeout(r, 6000));
  }
}

// ---- http -------------------------------------------------------------------
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/" || u.pathname === "/index.html") {
    readFile(join(HERE, "index.html"), (e, buf) => {
      if (e) { res.writeHead(500); return res.end("no index.html"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(buf);
    });
    return;
  }
  if (u.pathname === "/api/status") {
    try {
      const cs = await chainStatus();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...cs, wallet, torReady, target: TARGET, ...budget() }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (u.pathname === "/api/run") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const t0 = Date.now();
    const b = budget();
    if (b.remaining <= 0) {
      sse(res, { phase: "error", error: `rate cap reached — all ${b.perEpoch} slots used this epoch, resets in ${b.resetIn}s` });
      res.end();
      return;
    }
    epUsed.count++; // reserve a slot up-front (conservative: a failed run still can't reuse)
    try {
      if (!realIp) realIp = await fetchRealIp();
      sse(res, { phase: "begin", yourIp: realIp });
      const result = await client.fetch(TARGET, {
        onEvent: (e) => sse(res, { ...e, onionNote: e.onion ? onionNote(e.onion) : undefined }),
      });
      sse(res, {
        phase: "result",
        egressIp: result.body.trim(),
        httpStatus: result.status,
        gateway: result.gateway ? { onion: result.gateway.onion, note: onionNote(result.gateway.onion), slot: result.gateway.slot, nullifier: result.gateway.nullifier } : null,
        yourIp: realIp,
        latencyMs: Date.now() - t0,
      });
    } catch (e) {
      sse(res, { phase: "error", error: String(e.message || e) });
    }
    res.end();
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RGOE demo: http://127.0.0.1:${PORT}  (member leaf ${leaf.toString().slice(0, 14)}.., contract ${dep.stakedReputationSet})`);
  console.log(`target ${TARGET} via ${directory.gateways?.length || 0}-gateway fleet over Tor ${TOR_PORT}`);
});
ensureTor();
