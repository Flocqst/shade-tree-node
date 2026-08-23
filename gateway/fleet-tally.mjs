// Cross-fleet shared spent-nullifier tally (T-FEAT-20 — the T-FEAT-12 residual).
//
// T-FEAT-12 gave ONE gateway a per-gateway seen-envelope cache, so an exact-envelope
// replay to the SAME gateway outside the honest-retry window is rejected. But a
// non-colluding fleet has no SHARED spent-set: a malicious relay can capture a member's
// envelope and fan it out to PEER gateways, and each peer sees it once and egresses it.
// This module closes that by letting gateways share a per-epoch spent-NULLIFIER tally, so
// a nullifier admitted at gateway A propagates and gateway B rejects the same envelope
// (replayed-envelope) once the tally has reached it — the rate cap + replay defense now
// hold FLEET-WIDE, not just per gateway.
//
// ---- what crosses the wire, and why it is NOT a linkability channel ----------
// The ONLY data a gateway shares is the pair (nullifier, epoch). Nothing else — never the
// member's identity/commitment, never `share.y` (the secret evaluation a slash reconstructs
// from), never the egress `target`, never the tunnel nonce, never `share.x`.
//
// A nullifier is H(identitySecret, externalNullifier) (lib/rln.mjs): a per-EPOCH,
// per-tunnel value that is PSEUDORANDOM and UNLINKABLE to the member (ROADMAP #1 — this is
// the same property that already lets a single gateway dedup on the nullifier without
// learning who the member is, or tying two of their tunnels together). Sharing it adds NO
// linkability beyond what the admitting gateway already has: a peer learns only "some
// tunnel with nullifier N happened in epoch E" — exactly what N's own gateway learns, and
// N reveals neither identity nor target. Crucially, because `share.y` never crosses the
// wire, a peer CANNOT reconstruct the identitySecret from the tally, so the tally is not a
// slashing/deanonymization side channel either. (This is why fleet-wide slashing is a
// deliberate NON-goal — see the fail-open note below.)
//
// ---- transport is INJECTABLE (the propagation model) -------------------------
// The tally speaks to the fleet through a minimal, injectable transport interface:
//
//     transport.publish(nullifier, epoch)      -> announce a locally-admitted nullifier
//     transport.subscribe(cb) -> unsubscribe    -> receive peers' announcements: cb(nullifier, epoch)
//
// That two-method seam is all a FleetTally needs, so it is testable with TWO in-process
// gateways sharing one loopback transport (makeLoopbackTransport below) WITHOUT any real
// network code. REAL cross-host gossip (a signed pub/sub over the bootnode or a gossip mesh,
// composing with the T-FEAT-1 federation) is a deliberate FOLLOW-UP: it implements the SAME
// publish/subscribe interface and drops in unchanged. Nothing here binds a socket.
//
// ---- fail-OPEN, not fail-closed (documented decision) ------------------------
// A gateway that cannot reach the tally (partition, a throwing/slow transport, a peer that
// never gossips) DEGRADES to the per-gateway T-FEAT-12 defense — it never denies service.
// Rationale: the shared tally is defense-in-DEPTH that amplifies the replay/rate defense
// across the fleet; it is NOT an admission authority. Fail-closed would let a single
// unreachable tally (or one broken/malicious peer) turn a fleet-wide outage or a DoS on
// legitimate members, which is strictly worse than the marginal window in which a replay
// might slip through before propagation. So has()/record() swallow transport errors and the
// caller (makeSpentSet) treats any tally failure as "not spent elsewhere" and proceeds
// locally. Availability wins; the local cache still holds the per-gateway line.
//
// Because slashing needs TWO shares under one nullifier and `share.y` never crosses the
// tally, a DISTRIBUTED over-spend (the two shares landing on DIFFERENT gateways) is rejected
// fleet-wide (the second gateway sees the nullifier already spent -> replayed-envelope) but
// NOT slashed there — only the gateway that holds BOTH shares can reconstruct + slash. That
// is the correct privacy/availability trade: fleet-wide we degrade an over-spend to a reject,
// never leaking the share bytes a cross-gateway slash would require.
//
// ---- bounded + epoch-scoped --------------------------------------------------
// State is a Map<epochKey, { set:Set<nullifier>, at:number }>. Old epoch buckets are pruned
// once they age past ttlMs (default 2 epochs, matching the spent-set TTL and the verifier's
// one-epoch skew window — by then a bucket's externalNullifier is already stale at verify).
// Each bucket is also size-capped (maxPerEpoch) so a peer flooding garbage nullifiers cannot
// grow memory without bound; past the cap we stop recording (fail-open: we lose some dedup,
// we never crash or deny). `now` is injectable for deterministic tests.

import http from "node:http";
import { EPOCH_SECONDS } from "../lib/semaphore.mjs";
import { postOverTor } from "../bootnode/fetch.mjs";
import { log } from "../lib/log.mjs";

const DEFAULT_TTL_MS = 2 * EPOCH_SECONDS * 1000;
const DEFAULT_MAX_PER_EPOCH = 200_000; // generous; guards a garbage-flood, never a real fleet

// A synchronous in-process fan-out bus standing in for real network gossip. Every FleetTally
// that subscribes to the SAME instance shares a spent-set. publish(nullifier, epoch) delivers
// to EVERY subscriber synchronously (including the publisher — harmless, since ingest is a
// Set and idempotent), which makes "propagated" deterministic in tests. The interface is
// exactly { publish(nullifier, epoch), subscribe(cb) } — nothing else crosses it — so a real
// async cross-host transport is a drop-in replacement.
export function makeLoopbackTransport() {
  const subs = new Set(); // each entry: { cb }
  return {
    publish(nullifier, epoch) {
      for (const s of subs) {
        try { s.cb(nullifier, epoch); } catch (e) { log.warn("fleet-tally loopback subscriber threw", { err: e && e.message }); }
      }
    },
    subscribe(cb) {
      const s = { cb };
      subs.add(s);
      return { unsubscribe: () => subs.delete(s) };
    },
    _size: () => subs.size,
  };
}

// Build a FleetTally over an injected transport. Returns the seam makeSpentSet consults:
//   has(nullifier, epoch)     -> boolean: is this nullifier already spent fleet-wide (live epoch)?
//   record(nullifier, epoch)  -> mark locally-admitted AND publish to peers
//   prune(), size(), close()
// All of has/record are guarded: a throwing transport degrades to local-only (fail-open).
export function makeFleetTally({
  transport,
  ttlMs = DEFAULT_TTL_MS,
  maxPerEpoch = DEFAULT_MAX_PER_EPOCH,
  now = () => Date.now(),
} = {}) {
  if (!transport || typeof transport.publish !== "function" || typeof transport.subscribe !== "function") {
    throw new Error("makeFleetTally: transport must implement { publish(nullifier, epoch), subscribe(cb) }");
  }
  const buckets = new Map(); // epochKey -> { set:Set<string>, at:number }
  const epochKeyOf = (epoch) => (epoch == null ? "_" : String(epoch));

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
  }

  // The single mutation path: both a local record() and an inbound peer announcement funnel
  // here, so the two can never diverge. Idempotent (a Set) and bounded (maxPerEpoch cap).
  function ingest(nullifier, epoch) {
    const k = epochKeyOf(epoch);
    let b = buckets.get(k);
    if (!b) { b = { set: new Set(), at: now() }; buckets.set(k, b); }
    if (b.set.has(String(nullifier))) return;      // already known — idempotent
    if (b.set.size >= maxPerEpoch) return;         // flood cap — fail-open (lose dedup, never crash)
    b.set.add(String(nullifier));
  }

  // Subscribe FIRST so peer announcements start landing immediately.
  const sub = transport.subscribe((nullifier, epoch) => {
    try { ingest(nullifier, epoch); } catch (e) { log.warn("fleet-tally ingest threw", { err: e && e.message }); }
  });

  return {
    // Consulted by makeSpentSet BEFORE it admits a first-locally-seen nullifier. Any transport
    // trouble is swallowed -> false (fail-open: treat as "not spent elsewhere", admit locally).
    has(nullifier, epoch) {
      try {
        prune();
        const b = buckets.get(epochKeyOf(epoch));
        return !!b && b.set.has(String(nullifier));
      } catch (e) {
        log.warn("fleet-tally has() failed; degrading to per-gateway defense", { err: e && e.message });
        return false;
      }
    },
    // Called when THIS gateway admits a first-seen nullifier: record locally (so our own has()
    // reflects it regardless of transport self-delivery) AND announce to peers. Publish failure
    // is swallowed (fail-open) — the local T-FEAT-12 cache still defends this gateway.
    record(nullifier, epoch) {
      try {
        ingest(nullifier, epoch);
        prune();
        transport.publish(nullifier, epoch);
      } catch (e) {
        log.warn("fleet-tally record()/publish failed; peers may not learn this nullifier", { err: e && e.message });
      }
    },
    prune,
    size() { let n = 0; for (const b of buckets.values()) n += b.set.size; return n; },
    // Tear down: unsubscribe AND close the transport if it owns resources (the real HTTP
    // transport binds a listener + tracks sockets; the loopback has no close and is skipped).
    // This keeps gateway.mjs unchanged — a single tally.close() reclaims everything.
    close() {
      try { sub.unsubscribe?.(); } catch { /* best-effort */ }
      try { transport.close?.(); } catch { /* best-effort */ }
    },
  };
}

// ============================================================================
// Real cross-host transport (T-FEAT-20b) — HTTP push over the SAME publish/subscribe seam.
// ============================================================================
//
// The loopback transport above proves the FleetTally UNIT with two in-process gateways. This
// is the real thing: a tiny inbound HTTP endpoint each gateway exposes, plus an outbound POST
// to each CONFIGURED peer gateway. It implements EXACTLY { publish(nullifier, epoch),
// subscribe(cb) } and drops into makeConfiguredFleetTally, so gateway.mjs is UNCHANGED.
//
// ---- why HTTP push (the design choice) ---------------------------------------
// Direct 1-HOP push to a configured peer set — NOT multi-hop flood gossip. Chosen over a
// forwarding mesh because it is the simplest thing that is also robust and bounded:
//   * A nullifier crosses the wire at most ONCE per peer per admit. No forwarding => no
//     gossip storm / exponential amplification / loop-suppression bookkeeping to get wrong.
//   * The inbound handler ONLY records to the local tally; it NEVER re-publishes. So a peer's
//     announcement dies at us — the fan-out topology is exactly the operator's peer list.
//   * Reuses the project's existing Tor request path (bootnode/fetch.mjs postOverTor): a peer
//     that is an `.onion` is reached over Tor (no exit, peer never learns our IP); a bare
//     host:port peer is reached with a plain node:http POST (localhost / private-net / test).
// For a full fleet each gateway lists the others as peers (federation already discovers them,
// T-FEAT-1). A relay/pubsub could layer on later behind the SAME seam — this is the minimal
// robust transport, not a ceiling.
//
// ---- what crosses the wire (privacy invariant, enforced) ---------------------
// The POST body is EXACTLY JSON `{"nullifier":<n>,"epoch":<e>}` — the two positional args
// publish() receives, nothing more. The tally never hands publish() anything else (see
// record()), and the inbound handler READS ONLY msg.nullifier + msg.epoch (any extra field a
// peer stuffs in is ignored, never stored, never acted on). So neither direction can carry
// member / share.y / share.x / target / nonce.
//
// ---- trust model + bounded damage (semi-trusted peers) -----------------------
// Peers are SEMI-trusted: they are fleet gateways the operator configured (or federation
// discovered), not the open internet. The transport assumes a peer can be down, slow, or
// actively malicious, and bounds the blast radius:
//   * FAIL-OPEN, both directions. Outbound POSTs are fire-and-forget with a per-peer timeout;
//     a refused/500/slow/partitioned peer is swallowed (logged) and NEVER blocks admission —
//     publish() returns synchronously and admit() proceeds on the local defense. Inbound parse
//     errors / oversized bodies are dropped, never crash the endpoint.
//   * A malicious peer FLOODING fake nullifiers can at worst fill THIS gateway's per-epoch
//     bucket up to maxPerEpoch (the FleetTally flood cap) — memory stays bounded, and past the
//     cap we simply stop recording (lose dedup, never deny). It cannot cause a fleet-wide
//     outage. The only "harm" is a false-positive replay-reject on a nullifier it injected —
//     but a live nullifier is H(identitySecret, externalNullifier), per-tunnel pseudorandom
//     and unpredictable, so a flooder cannot pre-image a FUTURE honest member's nullifier to
//     get it pre-rejected. Its garbage collides with nothing real. Damage stays on the flooder.
//   * Response reads are byte-capped so a hostile peer cannot stream an unbounded reply at us.
//   * No new linkability: same argument as the loopback — only the per-tunnel pseudorandom
//     nullifier + epoch crosses, which the admitting gateway already holds.

const DEFAULT_PUSH_TIMEOUT_MS = Number(process.env.SHADE_TREE_FLEET_TALLY_TIMEOUT_MS) || 4000;
const DEFAULT_WIRE_MAX_BYTES = 8 * 1024; // an announcement is ~a hundred bytes; this is headroom

// Plain node:http POST of a JSON body to a bare host:port peer. Bounded, timed, no reton-body.
function httpPostJson(host, port, path, body, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      { host, port, path, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } },
      (res) => {
        // We do not need the response body; just drain it (capped) so the socket can close.
        let n = 0;
        res.on("data", (c) => { n += c.length; if (n > maxBytes) { try { res.destroy(); } catch { /* noop */ } } });
        res.on("end", () => resolve());
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("fleet-tally push timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Route one announcement to one peer. `.onion` (optionally `.onion:port`) goes over Tor via the
// existing bootnode fetch path (attempts:1 so a down peer fails FAST — fail-open, no retry
// storm); anything else is treated as host:port and reached with a plain node:http POST.
function defaultPost(peer, body, { path, timeoutMs, maxBytes }) {
  const p = String(peer).trim().replace(/^https?:\/\//, "");
  if (/\.onion(:\d+)?$/.test(p)) {
    const onion = p.replace(/:\d+$/, "");
    return postOverTor(onion, path, body, { timeoutMs, maxBytes, attempts: 1 });
  }
  const [host, portStr] = p.split(":");
  return httpPostJson(host || "127.0.0.1", Number(portStr) || 80, path, body, { timeoutMs, maxBytes });
}

// Build the real transport: an inbound HTTP endpoint (subscribe side) + outbound push to peers
// (publish side). Same interface as makeLoopbackTransport, plus close()/ready for lifecycle:
//   publish(nullifier, epoch) -> POST {nullifier,epoch} to every peer (fire-and-forget, fail-open)
//   subscribe(cb) -> { unsubscribe } : cb(nullifier, epoch) on each inbound announcement
//   ready : Promise<AddressInfo>  (resolves once the listener is bound; get the ephemeral port)
//   address() : the bound address (or null before ready)
//   close()   : stop the listener, destroy tracked sockets, drop subscribers (leak-free)
// `post` is injectable for tests / alternate transports; default routes Tor-vs-plain per peer.
export function makeHttpTallyTransport({
  listen = { host: "127.0.0.1", port: 0 },
  peers = [],
  path = "/fleet-tally",
  post = null,
  timeoutMs = DEFAULT_PUSH_TIMEOUT_MS,
  maxBytes = DEFAULT_WIRE_MAX_BYTES,
} = {}) {
  const subs = new Set();        // each: { cb }
  const sockets = new Set();     // live inbound sockets, tracked for a leak-free close()
  const peerList = [...peers];
  let closed = false;
  const doPost = post || ((peer, body) => defaultPost(peer, body, { path, timeoutMs, maxBytes }));

  function deliver(nullifier, epoch) {
    for (const s of subs) {
      try { s.cb(nullifier, epoch); } catch (e) { log.warn("fleet-tally inbound subscriber threw", { err: e && e.message }); }
    }
  }

  const server = http.createServer((req, res) => {
    if (closed) { res.statusCode = 503; return res.end(); }
    if (req.method !== "POST" || (req.url || "").split("?")[0] !== path) { res.statusCode = 404; return res.end(); }
    let buf = Buffer.alloc(0);
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      buf = Buffer.concat([buf, c]);
      if (buf.length > maxBytes) { tooBig = true; res.statusCode = 413; res.end(); try { req.destroy(); } catch { /* noop */ } }
    });
    req.on("end", () => {
      if (tooBig) return;
      let msg = null;
      try { msg = JSON.parse(buf.toString("utf8")); } catch { res.statusCode = 400; return res.end(); }
      // ONLY these two fields are ever read. Any other key a peer sends is ignored entirely —
      // it is never stored and never reaches the tally. This is the wire-privacy chokepoint.
      const nOk = msg && (typeof msg.nullifier === "string" || typeof msg.nullifier === "number");
      const nullifier = nOk ? msg.nullifier : null;
      const epoch = msg && (typeof msg.epoch === "string" || typeof msg.epoch === "number") ? msg.epoch : null;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      if (nullifier == null) return; // malformed announcement: ack + drop (fail-open, never crash)
      deliver(nullifier, epoch);
    });
    req.on("error", () => { try { res.destroy(); } catch { /* noop */ } });
  });

  // SIGPIPE / half-open robustness: a peer that hangs up mid-request must not crash us.
  server.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* noop */ } });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => resolve(server.address()));
  });
  ready.catch((e) => log.warn("fleet-tally transport failed to bind; publish-only / degraded", { err: e && e.message }));

  return {
    ready,
    address() { try { return server.address(); } catch { return null; } },
    // Fire-and-forget push to every peer. NEVER throws synchronously and NEVER blocks admit:
    // each POST runs on its own microtask with a per-peer timeout, errors swallowed (fail-open).
    publish(nullifier, epoch) {
      if (closed) return;
      const body = { nullifier, epoch };
      for (const peer of peerList) {
        Promise.resolve()
          .then(() => doPost(peer, body))
          .catch((e) => log.warn("fleet-tally push to peer failed (fail-open, per-gateway defense holds)", { err: e && e.message }));
      }
    },
    subscribe(cb) {
      const s = { cb };
      subs.add(s);
      return { unsubscribe: () => subs.delete(s) };
    },
    close() {
      if (closed) return;
      closed = true;
      try { server.close(); } catch { /* noop */ }
      for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } }
      sockets.clear();
      subs.clear();
      peerList.length = 0;
    },
    _peers: peerList,
  };
}

// Parse SHADE_TREE_FLEET_TALLY_LISTEN ("host:port" | "port") -> { host, port }. Default 127.0.0.1:0
// (Tor maps the gateway's onion to a local port; a bare port is fine for private-net/dev).
function parseListen(raw) {
  const s = String(raw || "").trim();
  if (!s) return { host: "127.0.0.1", port: 0 };
  if (s.includes(":")) { const [h, p] = s.split(":"); return { host: h || "127.0.0.1", port: Number(p) || 0 }; }
  return { host: "127.0.0.1", port: Number(s) || 0 };
}

// main()-side factory: return a configured FleetTally, or null when none is wired.
//
// OFF BY DEFAULT is the point. With no `SHADE_TREE_FLEET_TALLY_PEERS`, this returns null and the
// gateway keeps EXACTLY today's per-gateway behavior (makeSpentSet({ sharedTally:null }) is
// byte-identical to T-FEAT-12). Set `SHADE_TREE_FLEET_TALLY_PEERS` (comma-separated peer gateways —
// `.onion` over Tor, or host:port on a private net) to turn on the real HTTP-push transport;
// `SHADE_TREE_FLEET_TALLY_LISTEN` (host:port | port) sets the inbound endpoint (default 127.0.0.1:0).
// An explicit `transport` (tests) short-circuits both. The legacy SHADE_TREE_FLEET_TALLY flag with no
// peers still just logs a note and stays off (fail-open).
export function makeConfiguredFleetTally({ env = process.env, transport = null } = {}) {
  if (transport) return makeFleetTally({ transport });
  const peers = String(env.SHADE_TREE_FLEET_TALLY_PEERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (peers.length) {
    const listen = parseListen(env.SHADE_TREE_FLEET_TALLY_LISTEN);
    const path = env.SHADE_TREE_FLEET_TALLY_PATH || "/fleet-tally";
    const t = makeHttpTallyTransport({ listen, peers, path });
    log.info("fleet tally transport: HTTP push (nullifier+epoch only; 1-hop; fail-open)", { peers: peers.length, listen: `${listen.host}:${listen.port}`, path });
    return makeFleetTally({ transport: t });
  }
  const want = env.SHADE_TREE_FLEET_TALLY;
  if (want && String(want) !== "0" && String(want) !== "") {
    log.warn("SHADE_TREE_FLEET_TALLY set but no peers (SHADE_TREE_FLEET_TALLY_PEERS) configured; staying per-gateway (fail-open)", { requested: String(want) });
  }
  return null; // default + unconfigured: per-gateway behavior, byte-identical
}
