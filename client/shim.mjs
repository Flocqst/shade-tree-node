// The client shim: a local HTTP CONNECT proxy that adds a reputation proof and
// routes to the gateway onion over Tor.
//
// Point any tool at it:  http_proxy=http://127.0.0.1:8888  https_proxy=...
// or  curl -x http://127.0.0.1:8888 https://example.com
//
// For each CONNECT host:port it:
//   1. generates (and caches per epoch) a Semaphore membership proof,
//   2. dials gateway.onion:80 via the Tor SOCKS port (no exit node in path),
//   3. sends the JSON envelope { v, target, proof },
//   4. on gateway "ok", tells the local client "200 Connection established" and
//      pipes the bytes; the local client then does TLS straight to the target.
//
// The shim never sees plaintext either: it just bridges the local socket to the
// Tor stream. Tor handles the anonymity and the addressing; this shim is the
// thin app-layer protocol that carries the reputation proof, which Tor itself has no
// place to carry.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SocksClient } from "socks";
import { proveMembership, currentEpoch } from "../lib/semaphore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.RGOE_SHIM_PORT || 8888);
const TOR_SOCKS_HOST = process.env.RGOE_TOR_HOST || "127.0.0.1";
const TOR_SOCKS_PORT = Number(process.env.RGOE_TOR_PORT || 9250);

const SECRET = process.env.RGOE_SECRET;
if (!SECRET) {
  console.error("set RGOE_SECRET (from `npm run enroll`) before starting the shim");
  process.exit(1);
}

async function gatewayOnion() {
  if (process.env.RGOE_ONION) return process.env.RGOE_ONION.replace(/\.onion$/, "");
  const host = (await readFile(join(HERE, "..", "tor", "hs", "hostname"), "utf8")).trim();
  return host.replace(/\.onion$/, "");
}

// Cache one proof per epoch. Within an epoch a member's nullifier is constant, so
// the same proof is valid for every request and the gateway counts each
// redemption against the rate budget. Proving is the only slow step (~1-2s); we
// pay it once per hour, not per request.
let cache = { epoch: null, proof: null, inflight: null };
async function getProof() {
  const epoch = currentEpoch();
  if (cache.epoch === epoch && cache.proof) return cache.proof;
  if (cache.inflight && cache.inflightEpoch === epoch) return cache.inflight;
  cache.inflightEpoch = epoch;
  cache.inflight = (async () => {
    const proof = await proveMembership(SECRET, epoch);
    cache = { epoch, proof, inflight: null };
    return proof;
  })();
  return cache.inflight;
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

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      socket.removeListener("data", onData);
      socket.removeListener("error", reject);
      resolve({ line: buf.subarray(0, nl).toString("utf8"), rest: buf.subarray(nl + 1) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

const server = http.createServer();

server.on("connect", async (req, clientSocket, head) => {
  const target = req.url; // "host:port"
  try {
    const onion = await gatewayOnion();
    const proof = await getProof();

    const torSocket = await dialOnion(onion);
    torSocket.setNoDelay(true);

    torSocket.write(JSON.stringify({ v: 1, target, proof }) + "\n");
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
    console.log(`TUNNEL  ${target}  via ${onion.slice(0, 16)}..onion`);
  } catch (e) {
    try { clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nshim error: ${e.message}\n`); } catch {}
    clientSocket.destroy();
    console.log(`ERROR   ${target}  ${e.message}`);
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`shim up: http://127.0.0.1:${LISTEN_PORT}  ->  Tor SOCKS ${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}  ->  gateway.onion`);
  console.log(`use:  curl -x http://127.0.0.1:${LISTEN_PORT} https://api.ipify.org?format=json`);
});
