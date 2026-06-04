// The gateway: a reputation-gated egress proxy, published as a Tor onion service.
//
// It listens on 127.0.0.1:8443 (Tor maps <addr>.onion:80 -> here). For each
// incoming connection it:
//   1. reads a single newline-terminated JSON envelope { v, target, proof },
//   2. verifies the zk proof: valid + against OUR reputation set + current epoch,
//   3. enforces a per-nullifier rate budget for the epoch (the RLN rate limit),
//   4. on success: opens a raw TCP tunnel to `target` from THIS host's IP and
//      pipes bytes both ways (TLS stays end-to-end client<->target; the gateway
//      sees only the host:port, never the plaintext),
//   5. on any failure: writes a short error envelope and drops the connection.
//
// The destination site sees the gateway's IP, not a Tor exit and not the client.
// Because only rate-limited, in-set members can egress, the gateway's IP stays
// clean instead of degrading into a blocklisted open proxy. That is the whole
// point: the reputation gate is what manufactures the scarcity that keeps an IP
// reputable, without ever identifying the user.

import net from "node:net";
import { loadGroup, checkProof, currentEpoch, EPOCH_SECONDS } from "../lib/semaphore.mjs";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8443;
const RATE_LIMIT = Number(process.env.RGOE_RATE_LIMIT || 30); // redemptions / member / epoch
const MAX_ENVELOPE = 64 * 1024;

// Per-epoch nullifier -> count. Anonymous: we never learn which member a
// nullifier belongs to, only that "this anonymous member has spent N this hour".
// Old epochs are swept so memory stays bounded.
const budget = new Map(); // scope(string) -> Map<nullifier, count>

function spend(scope, nullifier) {
  let perScope = budget.get(scope);
  if (!perScope) {
    perScope = new Map();
    budget.set(scope, perScope);
  }
  const used = perScope.get(nullifier) || 0;
  if (used >= RATE_LIMIT) return { ok: false, used };
  perScope.set(nullifier, used + 1);
  return { ok: true, used: used + 1 };
}

function sweepEpochs() {
  const keep = new Set([String(currentEpoch()), String(currentEpoch() - 1n)]);
  for (const scope of budget.keys()) if (!keep.has(scope)) budget.delete(scope);
}
setInterval(sweepEpochs, EPOCH_SECONDS * 1000).unref();

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

let TRUSTED_ROOT = null;

async function handle(socket) {
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

  const check = await checkProof(env.proof, TRUSTED_ROOT);
  if (!check.ok) {
    console.log(`DROP  ${check.reason}  target=${env.target}`);
    reply(socket, { ok: false, err: "gate:" + check.reason });
    return socket.destroy();
  }

  const tgt = validTarget(env.target);
  if (!tgt) {
    reply(socket, { ok: false, err: "bad-target" });
    return socket.destroy();
  }

  const spent = spend(check.scope, check.nullifier);
  if (!spent.ok) {
    console.log(`DROP  rate-limited  null=${check.nullifier.slice(0, 10)}.. used=${spent.used}`);
    reply(socket, { ok: false, err: "rate-limited" });
    return socket.destroy();
  }

  const upstream = net.connect(tgt.port, tgt.host, () => {
    console.log(`PASS  egress->${tgt.host}:${tgt.port}  null=${check.nullifier.slice(0, 10)}.. ${spent.used}/${RATE_LIMIT} epoch=${check.scope}`);
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
}

async function main() {
  const { root, count } = await loadGroup();
  TRUSTED_ROOT = root;
  const server = net.createServer(handle);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`gateway up on ${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`reputation set: ${count} members, root ${root.slice(0, 18)}..`);
    console.log(`rate budget: ${RATE_LIMIT} redemptions / member / ${EPOCH_SECONDS}s epoch`);
    console.log(`egress policy: :443 only (metadata-only TLS tunnel)`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
