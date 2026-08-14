// RgoeClient: the reputation-gated onion egress client as a LIBRARY (no proxy process).
//
// This is the shim's hardened core, callable directly. Use it when the client is your
// own code (e.g. a searxng-style agent doing many queries) and you'd rather call a
// function than run a local HTTP proxy:
//
//   import { RgoeClient } from "./client/rgoe-client.mjs";
//   const rgoe = new RgoeClient({ secret, directory: "…/directory.json", dirSigner, torPort: 9260 });
//   const res  = await rgoe.fetch("https://api.ipify.org");     // -> { status, headers, body }
//   // or lower level, for your own TLS/protocol:
//   const sock = await rgoe.connect("api.ipify.org:443");       // raw duplex, tunneled via a gateway
//
// The per-request RLN proof is irreducible (it is what makes the nullifier / rate cap /
// slashing work), so this library mints a fresh proof per connect and preserves the same
// invariants the shim does: one proof per logical request, deterministic across gateway
// failover (same signal => same share), plus slot + gateway rotation.
//
// The shim (client/shim.mjs) is now a thin HTTP-CONNECT front-end over this same class.

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex } from "node:stream";
import tls from "node:tls";
import https from "node:https";
import { SocksClient } from "socks";
import { currentEpoch, K_SLOTS, requestSignal, proveForSlot, loadGroup, cleanUp } from "../lib/semaphore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- slot pool: per-epoch group warm + one slot/request rotation ----------------
// (moved verbatim from the shim; the deterministic-retry + rotation invariants live here.)
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
    // Background warm: cache the group + prime the prover so request-time proving is as
    // fast as it can be (the signal-bound proof itself cannot be precomputed).
    Promise.resolve()
      .then(async () => {
        const g = await ensureGroup();
        await prove(secret, ep, 0, requestSignal("precompute:warm", String(ep)), { group: g });
      })
      .catch(() => { /* warm is best-effort */ });
  }

  function ensureEpoch() {
    const ep = epochOf();
    if (ep !== epoch) rollover(ep);
    return ep;
  }

  // One slot per request; wraps at K. A wrapped slot reused with a DISTINCT signal is an
  // over-spend by construction (rate cap = K/epoch) — exactly what the gateway slashes.
  function nextSlot() {
    const ep = ensureEpoch();
    const i = cursor;
    cursor = (cursor + 1) % K;
    return { epoch: ep, slot: i };
  }

  return { ensureEpoch, ensureGroup, nextSlot, state: () => ({ epoch, cursor }) };
}

// Build the envelope-v3 for one logical request. `signal` is deterministic per request
// (H(target, nonce)); the caller reuses the SAME envelope across failover so a retry
// reproduces the SAME share (deterministic-retry invariant).
export async function buildEnvelope({ secret, target, pool, prove = proveForSlot }) {
  const nonce = randomBytes(16).toString("hex");
  const signal = requestSignal(target, nonce);
  const { epoch, slot } = pool.nextSlot();
  const group = await pool.ensureGroup();
  const { proof, nullifier, externalNullifier, share } = await prove(secret, epoch, slot, signal, { group });
  // The nonce rides in the envelope so the gateway can recompute the signal and BIND the proof to
  // this target (verifyEnvelope check 2b). It reveals nothing (it is random per request) and it is
  // what stops a captured proof from being redirected to a different target.
  return { envelope: { v: 3, target, nonce, proof, nullifier, externalNullifier, share }, signal, slot };
}

// Read one newline-terminated line, never waiting forever (a gateway that accepts but
// never replies must surface as an error, not a hang). Returns { line, rest }.
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

// If the ack chunk carried early tunnel bytes after the newline, prepend them to the
// readable side so nothing is lost (e.g. the target's first TLS record). Returns a Duplex
// that tls.connect({ socket }) and .pipe() both accept.
function tunnelStream(socket, rest) {
  if (!rest || !rest.length) return socket;
  const dup = new Duplex({
    read() {},
    write(chunk, enc, cb) { socket.write(chunk, enc, cb); },
    final(cb) { socket.end(cb); },
    destroy(err, cb) { socket.destroy(err); cb(err); },
  });
  dup.push(rest);
  socket.on("data", (c) => dup.push(c));
  socket.on("end", () => dup.push(null));
  socket.on("error", (e) => dup.destroy(e));
  return dup;
}

export class RgoeClient {
  constructor(opts = {}) {
    this.secret = opts.secret || process.env.RGOE_SECRET;
    if (!this.secret) throw new Error("RgoeClient: `secret` (or RGOE_SECRET) is required");
    this.torHost = opts.torHost || process.env.RGOE_TOR_HOST || "127.0.0.1";
    this.torPort = Number(opts.torPort || process.env.RGOE_TOR_PORT || 9250);
    this.dialAttempts = Number(opts.dialAttempts || 4);
    // Gateway selection: a pinned onion, or a signed directory (fleet rotation).
    this.onion = (opts.onion || process.env.RGOE_ONION || "").replace(/\.onion$/, "") || null;
    const dir = opts.directory || process.env.RGOE_DIRECTORY || null;
    const signer = opts.dirSigner || process.env.RGOE_DIR_SIGNER || null;
    // selection.mjs captures these at import; set them BEFORE its (lazy) import.
    if (dir) process.env.RGOE_DIRECTORY = dir;
    if (signer) process.env.RGOE_DIR_SIGNER = signer;
    this._selection = null;
    this.pool = makeSlotPool({ secret: this.secret });
    this.pool.ensureEpoch(); // warm the current epoch in the background
  }

  async _sel() {
    if (!this._selection) this._selection = await import("./selection.mjs");
    return this._selection;
  }

  // Ordered candidate onions to try this request: pin, else the directory selection
  // (weighted pick first, then failovers), else a local tor/hs/hostname (dev).
  async _candidateOnions() {
    if (this.onion) return [this.onion];
    const sel = await this._sel();
    if (sel.directoryEnabled()) {
      const cands = await sel.selectCandidates();
      if (cands.length) return cands.map((c) => c.onion.replace(/\.onion$/, ""));
    }
    try {
      const host = (await readFile(join(HERE, "..", "tor", "hs", "hostname"), "utf8")).trim();
      return [host.replace(/\.onion$/, "")];
    } catch {
      throw new Error("RgoeClient: no gateway — set { onion } or { directory, dirSigner }");
    }
  }

  // Dial one gateway onion over Tor SOCKS, retrying through onion cold-start.
  async _dial(onion, attempts = this.dialAttempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: { host: this.torHost, port: this.torPort, type: 5 },
          command: "connect",
          destination: { host: onion + ".onion", port: 80 },
          timeout: 120000,
        });
        return socket;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastErr;
  }

  // connect("host:port", { onEvent }) -> a raw duplex stream tunneled to the target via a
  // gateway. Builds ONE proof and reuses the SAME envelope across gateway failover
  // (deterministic retry). Throws if the gate refuses or no gateway is reachable. TLS stays
  // end-to-end: do your own tls.connect({ socket }) — the gateway sees only ciphertext.
  // onEvent(e) is an optional progress hook: e.phase ∈ {prove,dial,gate}, e.status.
  async connect(target, { onEvent, onion } = {}) {
    const emit = (e) => { try { onEvent?.(e); } catch { /* progress is best-effort */ } };
    // opts.onion pins a specific gateway for this request (else directory/pin/local order).
    const onions = onion ? [String(onion).replace(/\.onion$/, "")] : await this._candidateOnions();

    emit({ phase: "prove", status: "start" });
    const { envelope, slot } = await buildEnvelope({ secret: this.secret, target, pool: this.pool });
    // Surface the real proof material for anyone who wants the cryptographic detail: the
    // Groth16 public signals (what the gateway verifies) + the proof points.
    const sp = envelope.proof.snarkProof;
    emit({
      phase: "prove", status: "done", slot, nullifier: envelope.nullifier,
      pub: sp.publicSignals,                         // { y, root, nullifier, x, externalNullifier }
      pi: { a: sp.proof.pi_a, b: sp.proof.pi_b, c: sp.proof.pi_c },
      epoch: String(envelope.proof.epoch), rlnIdentifier: String(envelope.proof.rlnIdentifier),
    });
    const wire = JSON.stringify(envelope) + "\n";
    const sel = this.onion ? null : await this._sel();

    let sock = null, usedOnion = null, lastErr = null;
    for (const cand of onions) {
      const t0 = Date.now();
      emit({ phase: "dial", status: "start", onion: cand });
      try {
        sock = await this._dial(cand);
        usedOnion = cand;
        sel?.reportResult?.(cand, { ok: true, latencyMs: Date.now() - t0 });
        emit({ phase: "dial", status: "done", onion: cand, latencyMs: Date.now() - t0 });
        break;
      } catch (e) {
        lastErr = e;
        sel?.reportResult?.(cand, { ok: false });
        emit({ phase: "dial", status: "failover", onion: cand, error: e.message });
      }
    }
    if (!sock) { emit({ phase: "dial", status: "error", error: (lastErr && lastErr.message) || "no gateway" }); throw lastErr || new Error("no gateway reachable"); }
    sock.setNoDelay(true);

    emit({ phase: "gate", status: "start", onion: usedOnion });
    sock.write(wire);
    const { line, rest } = await readLine(sock);
    let ack;
    try { ack = JSON.parse(line); } catch { sock.destroy(); throw new Error("bad gateway ack: " + line.slice(0, 80)); }
    if (!ack.ok) { emit({ phase: "gate", status: "refused", error: ack.err }); sock.destroy(); throw new Error("gate refused: " + ack.err); }
    emit({ phase: "gate", status: "done", onion: usedOnion });

    const tunnel = tunnelStream(sock, rest);
    tunnel.rgoe = { onion: usedOnion, slot, nullifier: envelope.nullifier };
    return tunnel;
  }

  // fetch(url, opts) -> { status, headers, body }. HTTPS over the tunnel (end-to-end TLS
  // to the target; the gateway only relays ciphertext). opts: { method, headers, body }.
  async fetch(url, opts = {}) {
    const emit = (e) => { try { opts.onEvent?.(e); } catch { /* best-effort */ } };
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("RgoeClient.fetch: https:// only (the gateway egresses :443)");
    const port = u.port || 443;
    const socket = await this.connect(`${u.hostname}:${port}`, { onEvent: opts.onEvent, onion: opts.onion });
    emit({ phase: "egress", status: "start", target: u.hostname });
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: u.hostname,
          port,
          path: (u.pathname || "/") + (u.search || ""),
          method: opts.method || "GET",
          headers: opts.headers || {},
          createConnection: () => tls.connect({ socket, servername: u.hostname }),
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            emit({ phase: "egress", status: "done", httpStatus: res.statusCode });
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), gateway: socket.rgoe });
          });
        }
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }
}

export { cleanUp };
