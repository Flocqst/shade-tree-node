// The client shim: a local HTTP CONNECT proxy that adds a reputation proof and
// routes to the gateway onion over Tor.
//
// Point any tool at it:  http_proxy=http://127.0.0.1:8888  https_proxy=...
// or  curl -x http://127.0.0.1:8888 https://example.com
//
// For each CONNECT host:port it:
//   1. picks the next PRECOMPUTED slot proof for this epoch (one slot per request),
//   2. binds a deterministic signal to the request and evaluates the RLN share,
//   3. picks a gateway from the fleet (rotation) and dials gateway.onion:80 via Tor,
//   4. sends the v2 envelope { v, target, slot, proof, nullifier, scope, share },
//   5. on gateway "ok", tells the local client "200 Connection established" and
//      pipes bytes; the local client then does TLS straight to the target.
//
// Two anti-correlation rotations run together (docs/NEXT-VERSION.md B):
//   - GATEWAY rotation: a different onion per CONNECT (client/selection.mjs), so no
//     one operator sees all of a member's traffic.
//   - SLOT rotation: a different per-request nullifier per CONNECT, so even colluding
//     operators cannot rejoin a member's requests across a shared per-epoch key.
// Rotation alone does not defeat collusion; per-request slot nullifiers do (FLEET.md).
//
// The K slot proofs for an epoch are precomputed in the BACKGROUND at rollover, so
// proving (~1-2s) is never on the request path: the hot path just picks the next
// unused slot and evaluates the cheap request-bound share.
//
// Deterministic-retry invariant (docs/NEXT-VERSION.md A, load-bearing): the signal is
// H(target, requestNonce), fixed for one logical request and REUSED on every failover.
// A retry reproduces the SAME share (same evaluation point), so a rogue gateway cannot
// induce a retry storm to manufacture a distinct over-spend and slash an honest member.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { SocksClient } from "socks";
import { currentEpoch, K_SLOTS, requestSignal, proveForSlot, loadGroup } from "../lib/semaphore.mjs";
import { directoryEnabled, selectCandidates, reportResult } from "./selection.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.RGOE_SHIM_PORT || 8888);
const TOR_SOCKS_HOST = process.env.RGOE_TOR_HOST || "127.0.0.1";
const TOR_SOCKS_PORT = Number(process.env.RGOE_TOR_PORT || 9250);

async function gatewayOnion() {
  if (process.env.RGOE_ONION) return process.env.RGOE_ONION.replace(/\.onion$/, "");
  const host = (await readFile(join(HERE, "..", "tor", "hs", "hostname"), "utf8")).trim();
  return host.replace(/\.onion$/, "");
}

// The per-CONNECT try order. In directory mode (RGOE_DIRECTORY set) this is a
// weighted-random pick over the live fleet followed by the rest as failovers; the
// shim dials them in order and fails over on dial timeout. RGOE_ONION still forces
// a single gateway (debug pin), and with no directory the single-onion path is
// unchanged. Rotation is free: the slot proof is gateway-independent, so every
// candidate reuses the same envelope.
async function candidateOnions() {
  if (!process.env.RGOE_ONION && directoryEnabled()) {
    const cands = await selectCandidates();
    if (cands.length) return cands.map((c) => c.onion);
  }
  return [await gatewayOnion()];
}

// ---- slot pool: per-epoch precompute (group + prover warm), rotate one slot/request --
//
// IMPORTANT (reconciled against the real lib): Track 2's membership proof BINDS the
// request signal (proveForSlot sets the Semaphore `message` to the signal, and
// verifyEnvelope enforces proof.message === share.x). So the proof CANNOT be
// precomputed before the request signal is known — the spec's "precompute the K
// proofs" is infeasible for a signal-bound proof, and proving lands at request time.
// What we DO precompute per epoch is the reusable, signal-independent work: the Group
// (members.json / on-chain tree) is loaded and cached once, and one throwaway proof is
// run in the BACKGROUND at rollover to warm the snarkjs artifacts, so the first real
// request is not slow. Slot rotation and the deterministic signal still hold.
export function makeSlotPool({ secret, prove = proveForSlot, epochOf = currentEpoch, K = K_SLOTS, loadGroupFn = loadGroup }) {
  let epoch = null;
  let cursor = 0;
  let group = null;
  let groupPromise = null;

  async function ensureGroup() {
    if (group) return group;
    if (!groupPromise) groupPromise = Promise.resolve(loadGroupFn()).then((g) => (group = g.group));
    return groupPromise;
  }

  function rollover(ep) {
    epoch = ep;
    cursor = 0;
    group = null;
    groupPromise = null;
    // Background warm: cache the group and prime the prover so request-time proving is
    // as fast as it can be (the signal-bound proof itself cannot be precomputed).
    Promise.resolve()
      .then(async () => {
        const g = await ensureGroup();
        await prove(secret, ep, 0, requestSignal("precompute:warm", String(ep)), { group: g });
      })
      .catch(() => { /* warm is best-effort */ });
  }

  function ensureEpoch() {
    const ep = epochOf();
    if (ep !== epoch) rollover(ep); // background; not awaited
    return ep;
  }

  // One slot per request: advance the cursor. After K requests the cursor wraps; a
  // wrapped slot reused with a DISTINCT signal is an over-spend by construction (rate
  // cap = K per epoch) and is exactly what the gateway reconstructs + slashes on.
  function nextSlot() {
    const ep = ensureEpoch();
    const i = cursor;
    cursor = (cursor + 1) % K;
    return { epoch: ep, slot: i };
  }

  return { ensureEpoch, ensureGroup, nextSlot, state: () => ({ epoch, cursor }) };
}

// Build the v2 envelope for one logical request. `signal` is deterministic per request
// (H(target, nonce)) and the caller reuses the SAME envelope across failover, so a
// retry reproduces the SAME share (no new evaluation point) — the deterministic-retry
// invariant. proof + nullifier + scope + share all come from one proveForSlot call, so
// the envelope is internally coherent (proof.message === share.x) for verifyEnvelope.
export async function buildEnvelope({ secret, target, pool, prove = proveForSlot }) {
  const nonce = randomBytes(16).toString("hex"); // stable for THIS logical request
  const signal = requestSignal(target, nonce);
  const { epoch, slot } = pool.nextSlot();
  const group = await pool.ensureGroup();
  const { proof, nullifier, scope, share } = await prove(secret, epoch, slot, signal, { group });
  return { envelope: { v: 2, target, slot, proof, nullifier, scope, share }, signal };
}

// Dial the gateway onion via Tor SOCKS, retrying through cold start. Right after
// tor (re)starts, the onion descriptor takes a little while to propagate to the
// hashring before the first rendezvous can complete, so the first dial can time
// out. Retry a few times with a generous timeout before giving up.
async function dialOnion(onion, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: { host: TOR_SOCKS_HOST, port: TOR_SOCKS_PORT, type: 5 },
        command: "connect",
        destination: { host: onion + ".onion", port: 80 },
        timeout: 120000,
      });
      return socket;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.log(`  onion not ready (${e.message}), retry ${i + 1}/${attempts - 1}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

// Read one newline-terminated line, but never wait forever: a gateway that accepts the
// stream yet never replies (a server-side bug, or a black-holing rogue) must surface as
// an error the shim reports, not an indefinite hang. Times out after `ms`.
function readLine(socket, ms = 30000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error("gateway did not respond within " + ms + "ms")); }, ms);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      cleanup();
      resolve({ line: buf.subarray(0, nl).toString("utf8"), rest: buf.subarray(nl + 1) });
    };
    const onErr = (e) => { cleanup(); reject(e); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
    }
    socket.on("data", onData);
    socket.once("error", onErr);
  });
}

function startShim() {
  const SECRET = process.env.RGOE_SECRET;
  if (!SECRET) {
    console.error("set RGOE_SECRET (from `node group/enroll.mjs`) before starting the shim");
    process.exit(1);
  }

  const pool = makeSlotPool({ secret: SECRET });
  pool.ensureEpoch(); // warm the current epoch's slots in the background at startup

  const server = http.createServer();

  server.on("connect", async (req, clientSocket, head) => {
    const target = req.url; // "host:port"
    console.log(`REQ     ${target}`); // start marker: a hang after this points at the dial/gateway
    try {
      const onions = await candidateOnions();
      // ONE slot + ONE deterministic signal for this logical request; the same
      // envelope (same share) is reused across every gateway failover below.
      const { envelope } = await buildEnvelope({ secret: SECRET, target, pool });
      const wire = JSON.stringify(envelope) + "\n";

      // Dial candidates in order, failing over to the next gateway on dial timeout.
      // Once a socket is up we are committed to it (bytes may flow); we only fail
      // over before that point, and we reuse the SAME envelope so a failover never
      // manufactures a new share (deterministic-retry invariant).
      let torSocket = null, onion = null, lastErr = null;
      for (const cand of onions) {
        const t0 = Date.now();
        try {
          torSocket = await dialOnion(cand);
          onion = cand;
          reportResult(cand, { ok: true, latencyMs: Date.now() - t0 });
          break;
        } catch (e) {
          lastErr = e;
          reportResult(cand, { ok: false });
          if (onions.length > 1) console.log(`  gateway ${cand.slice(0, 16)}..onion failed (${e.message}), failing over`);
        }
      }
      if (!torSocket) throw lastErr || new Error("no gateway reachable");
      torSocket.setNoDelay(true);

      torSocket.write(wire);
      const { line, rest } = await readLine(torSocket);
      const ack = JSON.parse(line);
      if (!ack.ok) {
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\ngate refused: ${ack.err}\n`);
        clientSocket.destroy();
        torSocket.destroy();
        console.log(`REFUSED ${target}  (${ack.err})`);
        return;
      }

      clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (rest && rest.length) clientSocket.write(rest); // unlikely, but be safe
      if (head && head.length) torSocket.write(head);
      clientSocket.pipe(torSocket);
      torSocket.pipe(clientSocket);
      clientSocket.on("error", () => torSocket.destroy());
      torSocket.on("error", () => clientSocket.destroy());
      console.log(`TUNNEL  ${target}  slot=${envelope.slot} via ${onion.slice(0, 16)}..onion`);
    } catch (e) {
      try { clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nshim error: ${e.message}\n`); } catch {}
      clientSocket.destroy();
      console.log(`ERROR   ${target}  ${e.message}`);
    }
  });

  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`shim up: http://127.0.0.1:${LISTEN_PORT}  ->  Tor SOCKS ${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}  ->  gateway.onion`);
    console.log(`slots: ${K_SLOTS}/epoch precomputed in background; per-request slot + gateway rotation`);
    console.log(`use:  curl -x http://127.0.0.1:${LISTEN_PORT} https://api.ipify.org?format=json`);
  });
}

// Only stand up the server when run directly; importing (e.g. the selftest) just
// pulls the exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) startShim();
