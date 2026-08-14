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
// from), never the egress `target`, never the request nonce, never `share.x`.
//
// A nullifier is H(identitySecret, externalNullifier) (lib/rln.mjs): a per-EPOCH,
// per-request value that is PSEUDORANDOM and UNLINKABLE to the member (ROADMAP #1 — this is
// the same property that already lets a single gateway dedup on the nullifier without
// learning who the member is, or tying two of their requests together). Sharing it adds NO
// linkability beyond what the admitting gateway already has: a peer learns only "some
// request with nullifier N happened in epoch E" — exactly what N's own gateway learns, and
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

import { EPOCH_SECONDS } from "../lib/semaphore.mjs";
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
    close() { try { sub.unsubscribe?.(); } catch { /* best-effort */ } },
  };
}

// main()-side factory: return a configured FleetTally, or null when none is wired. This run
// ships NO real cross-host transport (that gossip layer is the follow-up), so by design this
// returns null and the gateway keeps EXACTLY today's per-gateway behavior. The seam exists so
// a future transport drops in here without touching makeSpentSet. Off by default is the point:
// RGOE_FLEET_TALLY set with no bundled transport logs a note and stays off (fail-open).
export function makeConfiguredFleetTally({ env = process.env, transport = null } = {}) {
  if (transport) return makeFleetTally({ transport });
  const want = env.RGOE_FLEET_TALLY;
  if (want && String(want) !== "0" && String(want) !== "") {
    log.warn("RGOE_FLEET_TALLY set but no cross-host tally transport is bundled yet (follow-up); staying per-gateway (fail-open)", { requested: String(want) });
  }
  return null; // default + unconfigured: per-gateway behavior, byte-identical
}
