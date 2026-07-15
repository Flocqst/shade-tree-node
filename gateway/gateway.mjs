// The gateway: a reputation-gated egress proxy, published as a Tor onion service.
//
// It listens on 127.0.0.1:8443 (Tor maps <addr>.onion:80 -> here). For each
// incoming connection it:
//   1. reads a single newline-terminated v2 JSON envelope
//      { v, target, slot, proof, nullifier, scope, share },
//   2. verifies it CHEAP-FIRST (docs/NEXT-VERSION.md, adversarial-review #4):
//        scope is a valid slot for the current/previous epoch  (cheap)
//        proof.merkleTreeRoot ∈ recent-roots                   (cheap)
//        membership verifyProof                                (expensive SNARK)
//      all bundled behind lib verifyEnvelope(),
//   3. collects the RLN share per (scope, nullifier): the first share egresses; an
//      identical replay is deduped (no slash); a SECOND DISTINCT signal reconstructs
//      the secret and slashes the member's on-chain stake,
//   4. on success opens a raw :443 TCP tunnel to `target` from THIS host's IP and
//      pipes bytes both ways (TLS stays end-to-end client<->target),
//   5. on any failure writes a short error envelope and drops the connection.
//
// The reputation root is read from a RootProvider (the on-chain StakedReputationSet,
// via lib/root-provider.mjs) so TRUSTED_ROOT is a recent-roots SET refreshed on
// membership change, not a static members.json. Without RGOE_GROUP_CONTRACT it falls
// back to members.json so the PoC path still works.

import net from "node:net";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyEnvelope, loadGroupOnchain, loadGroup, currentEpoch, EPOCH_SECONDS, MEMBERS_PATH } from "../lib/semaphore.mjs";
import { reconstructSecret, deriveCommitment } from "../lib/rln.mjs";
import { makeRootProvider } from "../lib/root-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8443;
const MAX_ENVELOPE = 64 * 1024;

// ---- recent-roots: the accepted admission roots, refreshed on change --------
// A proof against any root inside the freshness window verifies. On-chain: fed by
// the RootProvider. PoC fallback: the single members.json root, re-read on change.
let recentRoots = new Set();

async function initRoots() {
  if (process.env.RGOE_GROUP_CONTRACT) {
    const provider = makeRootProvider(); // node|light per RGOE_ROOT_PROVIDER
    const refresh = async () => {
      const { recentRoots: roots } = await loadGroupOnchain(provider);
      recentRoots = new Set((roots || []).map(String));
    };
    await refresh();
    provider.onChange?.(() => refresh().catch((e) => console.log(`root refresh failed (${e.message}); keeping recent-roots`)));
    console.log(`root source: on-chain RootProvider (${process.env.RGOE_ROOT_PROVIDER || "node"}), ${recentRoots.size} recent root(s)`);
    return { count: null };
  }
  // PoC fallback: members.json is the root source; refresh on file change.
  const load = async () => {
    const { root, count } = await loadGroup();
    recentRoots = new Set([String(root)]);
    return count;
  };
  let count = await load();
  try {
    watch(MEMBERS_PATH, { persistent: false }, () => load().then((c) => { count = c; }).catch(() => {}));
  } catch { /* watch is best-effort */ }
  console.log(`root source: members.json (PoC fallback), ${count} members`);
  return { count };
}

// ---- share-collecting spent-set (RLN slashing at PoC fidelity) --------------
// Keyed by (scope, nullifier). Stores the first share; a second DISTINCT evaluation
// point (distinct signal) under the same key is a provable over-spend: reconstruct
// the secret from the two shares, derive the commitment, and slash. An IDENTICAL
// replay (same share.x) is deduped and is NEVER slashed (it reveals no new point).
//
// reconstruct/derive/slash are injected so the selftest can drive this control flow
// with mocks (the real lib + on-chain slasher land at combine).
export function makeSpentSet({ reconstruct = reconstructSecret, derive = deriveCommitment, slash, ttlMs = 2 * EPOCH_SECONDS * 1000 } = {}) {
  const seen = new Map(); // key -> { xs:Set, first:share, slashed:bool, at:number }
  const keyOf = (scope, nullifier) => String(scope) + "|" + String(nullifier);

  async function admit(scope, nullifier, share) {
    if (!share || share.x == null) return { ok: false, action: "bad-share", reason: "no-share" };
    const k = keyOf(scope, nullifier);
    const e = seen.get(k);

    if (!e) {
      seen.set(k, { xs: new Set([String(share.x)]), first: share, slashed: false, at: Date.now() });
      return { ok: true, action: "first" };
    }
    if (e.slashed) return { ok: false, action: "slashed", reason: "rate-slashed" };
    if (e.xs.has(String(share.x))) return { ok: true, action: "replay" }; // idempotent honest retry

    // Distinct signal under the same (scope, nullifier): the L+1-th point. Over-spend.
    e.slashed = true; // slash exactly once for this key
    let commitment = null;
    try {
      const secret = reconstruct(e.first, share);
      commitment = derive(secret);
      if (slash) await slash(commitment, secret);
    } catch (err) {
      console.log(`slash failed for null=${String(nullifier).slice(0, 10)}..: ${err.message}`);
    }
    return { ok: false, action: "slash", reason: "over-spend-slashed", commitment };
  }

  function sweep() {
    const cutoff = Date.now() - ttlMs;
    for (const [k, e] of seen) if (e.at < cutoff) seen.delete(k);
  }

  return { admit, sweep, size: () => seen.size };
}

// ---- on-chain slash submitter (ethers, hot key) -----------------------------
// The gateway's slashing is NOT anonymous and does not need to be: RGOE_SLASH_KEY is
// an operational hot key, deliberately separate from any member secret. Address +
// rpc come from contracts/deployed.local.json (or env). ethers is imported lazily so
// the gateway still runs without it (falls back to a dry-run log).
async function readDeployed() {
  try {
    return JSON.parse(await readFile(join(HERE, "..", "contracts", "deployed.local.json"), "utf8"));
  } catch {
    return {};
  }
}

async function makeSlasher() {
  const key = process.env.RGOE_SLASH_KEY;
  const deployed = await readDeployed();
  // Accept the key Deploy.s.sol actually writes (lowercase `stakedReputationSet`) as well
  // as the older casings, so the slasher finds the contract without RGOE_GROUP_CONTRACT
  // (which would also switch the membership root source to on-chain — not what we want
  // under Plan-B membership-from-members.json).
  const address = process.env.RGOE_GROUP_CONTRACT || deployed.stakedReputationSet
    || deployed.StakedReputationSet || deployed.address;
  const rpcUrl = process.env.RGOE_RPC_URL || deployed.rpcUrl || "http://127.0.0.1:8545";
  const receiver = process.env.RGOE_SLASH_RECEIVER || null;

  if (!key || !address) {
    console.log("slash: DRY-RUN (set RGOE_SLASH_KEY + deployed.local.json/RGOE_GROUP_CONTRACT to submit on chain)");
    return async (commitment, secret) => {
      console.log(`SLASH (dry-run) commitment=${String(commitment).slice(0, 18)}.. secret=${String(secret).slice(0, 10)}..`);
    };
  }

  let ethers;
  try {
    ({ ethers } = await import("ethers"));
  } catch {
    console.log("slash: ethers not installed; DRY-RUN only (add `ethers` to package.json)");
    return async (commitment) => console.log(`SLASH (dry-run, no ethers) commitment=${String(commitment).slice(0, 18)}..`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, ["function slash(uint256 commitment, uint256 secret, address receiver)"], wallet);
  const rcv = receiver || wallet.address;
  console.log(`slash: on-chain via ${address} (receiver ${rcv})`);
  return async (commitment, secret) => {
    const tx = await contract.slash(commitment, secret, rcv);
    console.log(`SLASH tx ${tx.hash} commitment=${String(commitment).slice(0, 18)}.. (waiting)`);
    const rcpt = await tx.wait();
    console.log(`SLASH mined block ${rcpt.blockNumber} commitment=${String(commitment).slice(0, 18)}..`);
  };
}

// ---- wire protocol ----------------------------------------------------------

function readEnvelope(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > MAX_ENVELOPE) cleanup(new Error("envelope too large"));
        return;
      }
      const line = buf.subarray(0, nl).toString("utf8");
      const rest = buf.subarray(nl + 1); // any early bytes after the envelope
      cleanup(null, line, rest);
    };
    const onErr = (e) => cleanup(e);
    const onEnd = () => cleanup(new Error("closed before envelope"));
    const timer = setTimeout(() => cleanup(new Error("envelope timeout")), 30000);
    function cleanup(err, line, rest) {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      socket.removeListener("end", onEnd);
      if (err) reject(err);
      else resolve({ line, rest });
    }
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("end", onEnd);
  });
}

function reply(socket, obj) {
  try { socket.write(JSON.stringify(obj) + "\n"); } catch {}
}

function validTarget(target) {
  if (typeof target !== "string") return null;
  const m = target.match(/^([a-zA-Z0-9.\-]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  // PoC egress policy: TLS ports only, so the gateway is a metadata-only tunnel
  // and never sees plaintext. Widen deliberately if you want a forward proxy.
  if (port !== 443) return null;
  return { host: m[1], port };
}

function makeHandler(spentSet) {
  return async function handle(socket) {
    socket.setNoDelay(true);
    let env;
    try {
      const { line, rest } = await readEnvelope(socket);
      env = JSON.parse(line);
      env.__rest = rest;
    } catch (e) {
      reply(socket, { ok: false, err: "bad-envelope:" + e.message });
      return socket.destroy();
    }

    // Everything after the envelope parse is guarded: any throw must REPLY, never hang
    // the client (a silent throw here is exactly the bug that left clients waiting).
    try {
      // Steps 1-3, cheap-first, inside the lib: scope-valid slot -> root ∈ recent-roots
      // -> SNARK verifyProof. Returns the nullifier/scope/slot/share to act on.
      const v = await verifyEnvelope(env, recentRoots);
      if (!v.ok) {
        console.log(`DROP  ${v.reason}  target=${env.target}`);
        reply(socket, { ok: false, err: "gate:" + v.reason });
        return socket.destroy();
      }

      const tgt = validTarget(env.target);
      if (!tgt) {
        reply(socket, { ok: false, err: "bad-target" });
        return socket.destroy();
      }

      // Step 4: slot-nullifier dedup + share collection; slashes on 2nd distinct signal.
      const res = await spentSet.admit(v.scope, v.nullifier, v.share);
      if (!res.ok) {
        console.log(`DROP  ${res.reason}  null=${String(v.nullifier).slice(0, 10)}.. slot=${v.slot}`);
        reply(socket, { ok: false, err: res.reason });
        return socket.destroy();
      }

      // Step 5: egress :443 tunnel (unchanged; TLS stays end-to-end).
      const upstream = net.connect(tgt.port, tgt.host, () => {
        console.log(`PASS  egress->${tgt.host}:${tgt.port}  null=${String(v.nullifier).slice(0, 10)}.. slot=${v.slot} scope=${String(v.scope).slice(0, 10)}..`);
        reply(socket, { ok: true });
        if (env.__rest && env.__rest.length) upstream.write(env.__rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.setNoDelay(true);
      upstream.on("error", (e) => {
        reply(socket, { ok: false, err: "upstream:" + e.code });
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
    } catch (e) {
      console.log(`ERROR  ${e.message}  target=${env.target}`);
      reply(socket, { ok: false, err: "gateway-error" });
      return socket.destroy();
    }
  };
}

async function main() {
  await initRoots();
  const slash = await makeSlasher();
  const spentSet = makeSpentSet({ slash });
  setInterval(() => spentSet.sweep(), EPOCH_SECONDS * 1000).unref();

  const server = net.createServer(makeHandler(spentSet));
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`gateway up on ${LISTEN_HOST}:${LISTEN_PORT}  (epoch ${currentEpoch()}, ${EPOCH_SECONDS}s)`);
    console.log(`egress policy: :443 only (metadata-only TLS tunnel)`);
    console.log(`rate: RLN degree-1 per slot; 2nd distinct signal on a slot => reconstruct + slash`);
  });
}

// Only run the server when invoked directly; importing (the selftest) pulls the
// exported makeSpentSet control flow with mocks.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
