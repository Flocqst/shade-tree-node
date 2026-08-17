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
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex } from "node:stream";
import tls from "node:tls";
import https from "node:https";
import { SocksClient } from "socks";
import { currentEpoch, K_SLOTS, normLimit, requestSignal, proveForSlot, loadGroup, cleanUp, clientArtifactIds, selectArtifact } from "../lib/semaphore.mjs";
import { verifyReceipt } from "../lib/receipt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- slot pool: per-epoch group warm + one slot/request rotation ----------------
// (moved verbatim from the shim; the deterministic-retry + rotation invariants live here.)
// `K` is THIS member's tier limit (T-FEAT-8): the userMessageLimit its leaf was enrolled with.
// The pool wraps slots at K and every proof is made with `limit: K`, so a tier-2 member
// (K=32) gets 32 distinct nullifiers per epoch from the same tree, and a member configured
// with a K its leaf does not carry cannot prove at all (proveForSlot: not in group).
export function makeSlotPool({ secret, prove = proveForSlot, epochOf = currentEpoch, K = K_SLOTS, loadGroupFn = loadGroup }) {
  K = Number(normLimit(K));
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
        await prove(secret, ep, 0, requestSignal("precompute:warm", String(ep)), { group: g, limit: K });
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

  return { ensureEpoch, ensureGroup, nextSlot, K, state: () => ({ epoch, cursor }) };
}

// ---- protocol version negotiation (T-FEAT-11) -------------------------------
// The range of wire-envelope versions THIS client can emit/parse. Single source of truth on the
// client side (the gateway keeps its own PROTO_MIN/PROTO_MAX). Today both sides are exactly {3}.
// Bump CLIENT_PROTO_MAX (and teach buildEnvelope the new shape) to speak a v4; raise
// CLIENT_PROTO_MIN only to drop an old one.
export const CLIENT_PROTO_MIN = 3;
export const CLIENT_PROTO_MAX = 3;
export const CLIENT_PROTO_RANGE = { min: CLIENT_PROTO_MIN, max: CLIENT_PROTO_MAX };

// Pick the HIGHEST version both sides support. `gatewayRange` is {min,max} the client has learned
// for this gateway — from a version-reject advertisement (ack.proto), or later from the signed
// directory (deliberate follow-up, T-FEAT-10). When it is unknown (null), we optimistically send
// our own max: a true mismatch then surfaces as an explicit `unsupported-version` reject carrying
// the gateway's real range, which the caller can feed back here to re-select or fail closed.
// Returns { ok:true, version } or { ok:false, reason } — never silently downgrades to a bad guess.
export function selectProtoVersion(gatewayRange, clientRange = CLIENT_PROTO_RANGE) {
  const cMin = clientRange.min, cMax = clientRange.max;
  if (!gatewayRange || gatewayRange.min == null || gatewayRange.max == null) {
    return { ok: true, version: cMax }; // no advertisement yet: emit our best supported version
  }
  const gMin = gatewayRange.min, gMax = gatewayRange.max;
  const hi = Math.min(cMax, gMax); // highest either side will go
  const lo = Math.max(cMin, gMin); // lowest both sides still accept
  if (hi < lo) {
    return { ok: false, reason: `no-mutual-version:client=${cMin}-${cMax},gateway=${gMin}-${gMax}` };
  }
  return { ok: true, version: hi }; // highest mutually supported
}

// ---- ZK artifact-version negotiation (T-HARD-8) -----------------------------
// The client proves with one of its prover artifact sets (lib/zk-artifacts.mjs
// loadProverSets, RGOE_ZK_PROVER_ARTIFACTS, newest first; default = the shipped set) and STAMPS
// the set's content-derived id into the envelope's `artifact` field so a gateway running a
// dual-VK window verifies under the matching vkey. Which id: the newest of ours that the
// gateway advertises in its signed caps (`caps.artifacts`); with no ad, optimistically our
// newest — a real mismatch surfaces as a precise `artifact-unknown/retired` reject that
// carries the gateway's accepted list (`ack.artifacts`), recorded on `this.gatewayArtifacts`
// for the next attempt exactly like `gatewayRange`.

// Build the envelope for one logical request. `signal` is deterministic per request
// (H(target, nonce)); the caller reuses the SAME envelope across failover so a retry
// reproduces the SAME share (deterministic-retry invariant). `version` is the negotiated
// wire version (default = our max, 3 today, so the emitted envelope is byte-for-byte the v3 wire
// plus the `artifact` id — a field older gateways ignore). `artifact` is the negotiated artifact
// id (default = the prover's newest set; `null` = prove with the default set but omit the field,
// i.e. the exact pre-T-HARD-8 wire).
export async function buildEnvelope({ secret, target, pool, prove = proveForSlot, version = CLIENT_PROTO_MAX, artifact }) {
  const nonce = randomBytes(16).toString("hex");
  const signal = requestSignal(target, nonce);
  const { epoch, slot } = pool.nextSlot();
  const group = await pool.ensureGroup();
  // `limit` = the pool's tier K (T-FEAT-8); a pool without one (older fakes) proves at the default.
  const proved = await prove(secret, epoch, slot, signal, { group, artifact: artifact ?? undefined, limit: pool.K ?? K_SLOTS });
  const { proof, nullifier, externalNullifier, share } = proved;
  // The nonce rides in the envelope so the gateway can recompute the signal and BIND the proof to
  // this target (verifyEnvelope check 2b). It reveals nothing (it is random per request) and it is
  // what stops a captured proof from being redirected to a different target. `v` is FIRST so the
  // gateway's version gate reads it without parsing the rest. `artifact` names the ZK artifact set
  // the proof was made with (T-HARD-8): the id the prover actually used (echoed back by
  // proveForSlot), or the requested one for a prover that does not echo; omitted when `null`.
  const artifactId = artifact === null ? null : (proved.artifact ?? artifact ?? null);
  const envelope = artifactId
    ? { v: version, target, nonce, artifact: artifactId, proof, nullifier, externalNullifier, share }
    : { v: version, target, nonce, proof, nullifier, externalNullifier, share };
  return { envelope, signal, slot, artifact: artifactId };
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

// ---- per-request SOCKS circuit isolation (T-FEAT-17) ----------------------------
// Tor with `IsolateSOCKSAuth` (bootnode/deploy/torrc.hardened, T-HARD-7) forks a SEPARATE
// circuit per distinct SOCKS username/password pair. The client sends NO auth today, so
// every request through a given SocksPort may share ONE circuit — collapsing the
// per-request gateway + slot rotation's unlinkability back onto a shared Tor path. Fix:
// give each REQUEST a unique SOCKS credential, so each request rides its own circuit.
//
// socksAuthForRequest(seed) -> { userId, password }, two opaque 16-byte hex tags Tor only
// compares for equality:
//   - seed given (the request nonce): the credential is DERIVED deterministically from it,
//     so it is DISTINCT across different requests (different nonces) yet STABLE across every
//     dial attempt / gateway failover of ONE logical request.
//   - seed omitted: a fresh random credential (each call = a new circuit).
//
// RETRY / CIRCUIT DECISION: we seed from the request nonce (connect() passes envelope.nonce)
// so a RETRY of the same logical request — an onion cold-start retry inside _dial, or a
// failover to another gateway — REUSES THE SAME circuit identity, mirroring the
// deterministic-retry invariant (same signal => same share across failover). We deliberately
// prefer this over a fresh circuit per dial ATTEMPT: cross-request unlinkability is the
// property that matters, and it is fully bought by distinct requests getting distinct
// credentials; pinning one request to one circuit identity avoids fanning a single request
// across multiple guards/circuits (extra correlation vantage points) for no unlinkability
// gain. (A fresh-per-attempt credential is also safe — just call with no seed — but that is
// not the safer default.)
//
// CAVEAT — a Tor daemon WITHOUT IsolateSOCKSAuth, or any plain no-auth SOCKS5 proxy: the
// socks lib always advertises NoAuth and only ADDS username/password to its method list when
// a credential is present; if the server selects NoAuth it proceeds WITHOUT sending the
// credential (an ordinary SOCKS5 connect). So these credentials are harmless — Tor without
// the flag just ignores them, and a no-auth proxy never negotiates them. Tor WITH the flag
// selects username/password (to enable isolation) and forks a circuit per credential.
export function socksAuthForRequest(seed) {
  if (seed == null) {
    return { userId: randomBytes(16).toString("hex"), password: randomBytes(16).toString("hex") };
  }
  const tag = (label) =>
    createHash("sha256").update("rgoe-socks-isolation:" + label + ":").update(String(seed)).digest("hex").slice(0, 32);
  return { userId: tag("uid"), password: tag("pwd") };
}

export class RgoeClient {
  constructor(opts = {}) {
    this.secret = opts.secret || process.env.RGOE_SECRET;
    if (!this.secret) throw new Error("RgoeClient: `secret` (or RGOE_SECRET) is required");
    this.torHost = opts.torHost || process.env.RGOE_TOR_HOST || "127.0.0.1";
    this.torPort = Number(opts.torPort || process.env.RGOE_TOR_PORT || 9250);
    this.dialAttempts = Number(opts.dialAttempts || 4);
    // Per-request SOCKS circuit isolation (T-FEAT-17): default ON, harmless without
    // IsolateSOCKSAuth. Disable with { socksIsolation: false } or RGOE_SOCKS_ISOLATION=0.
    this.socksIsolation = opts.socksIsolation !== false && process.env.RGOE_SOCKS_ISOLATION !== "0";
    // Injectable SOCKS client (tests pass a fake); defaults to the real `socks` lib.
    this._socks = opts.socksClient || SocksClient;
    // Gateway selection: a pinned onion, or a signed directory (fleet rotation).
    this.onion = (opts.onion || process.env.RGOE_ONION || "").replace(/\.onion$/, "") || null;
    const dir = opts.directory || process.env.RGOE_DIRECTORY || null;
    const signer = opts.dirSigner || process.env.RGOE_DIR_SIGNER || null;
    // selection.mjs captures these at import; set them BEFORE its (lazy) import.
    if (dir) process.env.RGOE_DIRECTORY = dir;
    if (signer) process.env.RGOE_DIR_SIGNER = signer;
    this._selection = null;
    // Known gateway protocol range (T-FEAT-11), if the caller learned one out-of-band. null =>
    // unknown; the client optimistically sends its max and reacts to any version-reject. A future
    // directory that carries the range (follow-up) would populate this per candidate.
    this.gatewayRange = opts.gatewayRange || null;
    // ZK artifact ids (T-HARD-8): `artifacts` = the ORDERED (newest first) ids this client can
    // prove with (default: the configured prover sets, RGOE_ZK_PROVER_ARTIFACTS or the shipped
    // set); `gatewayArtifacts` = a gateway's accepted list learned out-of-band or from a reject.
    this.artifacts = opts.artifacts || null; // null => clientArtifactIds() lazily (loads no circuit)
    this.gatewayArtifacts = opts.gatewayArtifacts || null;
    // Injectable prover (tests pass a fake); defaults to the real lib proveForSlot.
    this._prove = opts.prove || proveForSlot;
    // This member's tier limit (T-FEAT-8): { limit } or RGOE_LIMIT; default K_SLOTS (RGOE_SLOTS, 8).
    // Must equal the limit the member's leaf was enrolled with (`rgoe enroll --limit`).
    this.limit = Number(normLimit(opts.limit ?? process.env.RGOE_LIMIT ?? K_SLOTS));
    this.pool = makeSlotPool({ secret: this.secret, K: this.limit });
    this.pool.ensureEpoch(); // warm the current epoch in the background
  }

  async _sel() {
    if (!this._selection) this._selection = await import("./selection.mjs");
    return this._selection;
  }

  // Ordered candidates to try this request: pin, else the directory selection (weighted pick
  // first, then failovers), else a local tor/hs/hostname (dev). Each is { onion, artifacts? }
  // where `artifacts` is the gateway's SIGNED accepted-artifact ad from the directory (T-HARD-8),
  // when it advertises one.
  async _candidates() {
    if (this.onion) return [{ onion: this.onion, artifacts: this.gatewayArtifacts }];
    const sel = await this._sel();
    if (sel.directoryEnabled()) {
      const cands = await sel.selectCandidates();
      if (cands.length) return cands.map((c) => ({ onion: c.onion.replace(/\.onion$/, ""), artifacts: c.artifacts || null }));
    }
    try {
      const host = (await readFile(join(HERE, "..", "tor", "hs", "hostname"), "utf8")).trim();
      return [{ onion: host.replace(/\.onion$/, ""), artifacts: null }];
    } catch {
      throw new Error("RgoeClient: no gateway — set { onion } or { directory, dirSigner }");
    }
  }

  // The artifact id to prove with for this request (T-HARD-8): the newest of OUR sets that the
  // first candidate advertising an accepted set will verify (else, with no ad anywhere, our newest
  // — falling back to a reject-learned `gatewayArtifacts`). ONE envelope is reused across failover,
  // so the pick is made once, against the first advertising candidate; a later candidate that
  // rejects it does so with a precise reason (terminal, like a version reject).
  _pickArtifact(cands) {
    const mine = this.artifacts || clientArtifactIds();
    const ad = (cands.find((c) => Array.isArray(c.artifacts) && c.artifacts.length) || {}).artifacts || this.gatewayArtifacts;
    return selectArtifact(ad, mine);
  }

  // Dial one gateway onion over Tor SOCKS, retrying through onion cold-start.
  // `socksAuth` (T-FEAT-17) is the per-request SOCKS credential; it is reused for EVERY
  // attempt here (and by connect() across gateway failover) so a retry rides the SAME Tor
  // circuit identity. null => legacy no-auth dial. See socksAuthForRequest above.
  async _dial(onion, attempts = this.dialAttempts, socksAuth = null) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const proxy = { host: this.torHost, port: this.torPort, type: 5 };
        if (socksAuth) { proxy.userId = socksAuth.userId; proxy.password = socksAuth.password; }
        const { socket } = await this._socks.createConnection({
          proxy,
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
    const cands = onion ? [{ onion: String(onion).replace(/\.onion$/, ""), artifacts: this.gatewayArtifacts }] : await this._candidates();
    const onions = cands.map((c) => c.onion);

    // Negotiate the wire version (T-FEAT-11): pick the highest version this client and the gateway
    // both support. With no known gateway range this is just our max (v3 today); if the ranges are
    // disjoint we fail closed HERE with a precise reason, before proving or dialing.
    const pv = selectProtoVersion(this.gatewayRange);
    if (!pv.ok) {
      emit({ phase: "prove", status: "error", error: pv.reason });
      throw new Error("version negotiation failed: " + pv.reason);
    }
    // Negotiate the ZK artifact set (T-HARD-8): the newest of ours the gateway advertises it
    // accepts; disjoint => fail closed HERE, before proving or dialing.
    const pa = this._pickArtifact(cands);
    if (!pa.ok) {
      emit({ phase: "prove", status: "error", error: pa.reason });
      throw new Error("artifact negotiation failed: " + pa.reason);
    }

    emit({ phase: "prove", status: "start", artifact: pa.id });
    const { envelope, slot } = await buildEnvelope({ secret: this.secret, target, pool: this.pool, prove: this._prove, version: pv.version, artifact: pa.id });
    // Surface the real proof material for anyone who wants the cryptographic detail: the
    // Groth16 public signals (what the gateway verifies) + the proof points.
    const sp = envelope.proof.snarkProof;
    emit({
      phase: "prove", status: "done", slot, nullifier: envelope.nullifier,
      pub: sp.publicSignals,                         // { y, root, nullifier, x, externalNullifier }
      pi: { a: sp.proof.pi_a, b: sp.proof.pi_b, c: sp.proof.pi_c },
      epoch: String(envelope.proof.epoch), rlnIdentifier: String(envelope.proof.rlnIdentifier),
      artifact: envelope.artifact,
    });
    const wire = JSON.stringify(envelope) + "\n";
    const sel = this.onion ? null : await this._sel();

    // One SOCKS credential for the whole logical request (derived from its nonce), reused
    // across every gateway failover below so a retry keeps the SAME Tor circuit identity
    // while DIFFERENT requests get DIFFERENT circuits (T-FEAT-17).
    const socksAuth = this.socksIsolation ? socksAuthForRequest(envelope.nonce) : null;

    let sock = null, usedOnion = null, lastErr = null;
    for (const cand of onions) {
      const t0 = Date.now();
      emit({ phase: "dial", status: "start", onion: cand });
      try {
        sock = await this._dial(cand, this.dialAttempts, socksAuth);
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
    if (!ack.ok) {
      emit({ phase: "gate", status: "refused", error: ack.err, proto: ack.proto });
      sock.destroy();
      // A version reject advertises the gateway's real range in ack.proto (T-FEAT-11). Surface the
      // precise mutual-range failure so a caller can widen support or pin a compatible gateway, and
      // remember the range for the next attempt to this client.
      if (ack.proto && typeof ack.err === "string" && /^(unsupported|bad)-version/.test(ack.err)) {
        this.gatewayRange = ack.proto;
        const re = selectProtoVersion(ack.proto);
        throw new Error(`gate refused: ${ack.err} (gateway speaks ${ack.proto.min}-${ack.proto.max}; ${re.ok ? "retry as v" + re.version : re.reason})`);
      }
      // An artifact reject (T-HARD-8) advertises the gateway's accepted artifact ids in
      // ack.artifacts. Remember them and surface whether we hold a mutual set (retry with it) or
      // not (upgrade/downgrade the client's prover artifacts) — never a bare `invalid-proof` guess.
      if (Array.isArray(ack.artifacts) && typeof ack.err === "string" && /^gate:(artifact-(unknown|retired)|bad-artifact)/.test(ack.err)) {
        this.gatewayArtifacts = ack.artifacts;
        const re = selectArtifact(ack.artifacts, this.artifacts || clientArtifactIds());
        throw new Error(`gate refused: ${ack.err} (gateway accepts artifacts ${ack.artifacts.join(",") || "(none)"}; ${re.ok ? "retry with " + re.id : re.reason})`);
      }
      throw new Error("gate refused: " + ack.err);
    }
    emit({ phase: "gate", status: "done", onion: usedOnion });

    // Optional signed egress success receipt (T-FEAT-13). Purely ADDITIVE: a receipt is present
    // only when the gateway runs with RGOE_RECEIPTS=1, and its absence never affects the tunnel
    // (today's gateways send `{ ok: true }` with no `receipt` — nothing here fires). When present,
    // verify it against the ONION WE DIALED (self-authenticating pubkey) and the CURRENT epoch, so
    // it counts only as fresh liveness/quality evidence for THIS gateway. A bad receipt is NOT
    // fatal (the egress already succeeded) — it is surfaced as evidence via onEvent + tunnel.rgoe
    // for a quality-aware selection layer (T-FEAT-4) to weigh.
    const receipt = this._verifyReceipt(ack.receipt, usedOnion, emit);

    // Fold this verified-or-bogus receipt outcome into the LOCAL, per-gateway quality tally
    // (T-FEAT-22's accumulation engine; wired here by T-FEAT-23). Gate on receipt.present so a
    // legacy gateway running with receipts OFF sends none, is never reported, and is never
    // entered into (or penalized in) the tally — keeping this fully ADDITIVE. reportReceipt is
    // itself a no-op unless RGOE_RECEIPT_SCORING is armed, so this stays byte-identical to today
    // when the flag is off (no tally file is ever written). It is pulled from the SAME lazily
    // imported selection.mjs the client already uses (config captured at import; see _sel + the
    // constructor) rather than a static top-level import that would evaluate selection.mjs before
    // the constructor could set its directory/signer env.
    if (receipt.present) {
      const { reportReceipt } = await this._sel();
      reportReceipt(usedOnion, { valid: receipt.valid === true });
    }

    const tunnel = tunnelStream(sock, rest);
    tunnel.rgoe = { onion: usedOnion, slot, nullifier: envelope.nullifier, receipt, artifact: envelope.artifact };
    return tunnel;
  }

  // Verify an optional gateway success receipt (T-FEAT-13). Returns a small evidence record
  //   { present, valid, reason?, epoch?, onion? }
  // and emits a "receipt" progress event. `present:false` is the normal legacy case (a gateway
  // with receipts off), NOT a failure. Verification binds the receipt to the dialed onion and the
  // current epoch; a bad receipt is reported (valid:false + reason) but never throws, because the
  // egress already succeeded and a receipt is best-effort quality evidence, not a gate.
  _verifyReceipt(receipt, usedOnion, emit = () => {}) {
    if (!receipt) { const ev = { present: false }; emit({ phase: "receipt", status: "absent", onion: usedOnion }); return ev; }
    let v;
    try {
      v = verifyReceipt(receipt, { onion: usedOnion, epoch: currentEpoch() });
    } catch (e) {
      v = { ok: false, reason: "verify-threw:" + e.message };
    }
    const ev = v.ok
      ? { present: true, valid: true, onion: v.onion, epoch: v.epoch }
      : { present: true, valid: false, reason: v.reason };
    emit({ phase: "receipt", status: v.ok ? "verified" : "invalid", onion: usedOnion, reason: v.ok ? undefined : v.reason, epoch: v.ok ? v.epoch : undefined });
    return ev;
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
