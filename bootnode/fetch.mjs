// Client side of discovery: fetch the live directory from the bootnode onion over Tor.
//
// The bootnode is itself a v3 onion service, so the client reaches it the same way it reaches
// a gateway — a SOCKS dial through the local Tor daemon, no exit node, the bootnode never
// learns the client IP. Inside the tunnel it speaks plain HTTP/1.1 (the onion layer already
// provides the encryption and authentication). The returned JSON is then handed to
// lib/directory.mjs verifyDirectory(), so a lying or MITM'd bootnode cannot forge an entry.
//
// Onion services cold-start slowly right after publication (descriptor propagation), so the
// dial retries a few times, exactly like client/rgoe-client.mjs.

import { SocksClient } from "socks";

export async function fetchOverTor(onion, path, opts = {}) {
  return requestOverTor(onion, { method: "GET", path, ...opts });
}

// POST a JSON body to the bootnode onion over Tor (used by the gateway heartbeat).
export async function postOverTor(onion, path, body, opts = {}) {
  return requestOverTor(onion, { method: "POST", path, body, ...opts });
}

export async function requestOverTor(onion, { method = "GET", path = "/", body = null, torHost = "127.0.0.1", torPort = 9250, timeoutMs = 20000, attempts = 4 } = {}) {
  const host = onion.replace(/\.onion$/, "") + ".onion";
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await once(host, method, path, body, { torHost, torPort, timeoutMs });
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1000 * (i + 1), 4000)); // back off through onion cold-start
    }
  }
  throw new Error(`bootnode ${method} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
}

function once(host, method, path, body, { torHost, torPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let socket;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const timer = setTimeout(() => { try { socket?.destroy(); } catch {} reject(new Error("timeout")); }, timeoutMs);
    SocksClient.createConnection({
      proxy: { host: torHost, port: torPort, type: 5 },
      command: "connect",
      destination: { host, port: 80 },
    })
      .then(({ socket: s }) => {
        socket = s;
        let buf = Buffer.alloc(0);
        s.on("data", (c) => { buf = Buffer.concat([buf, c]); });
        s.on("end", () => { clearTimeout(timer); try { resolve(parseHttp(buf)); } catch (e) { reject(e); } });
        s.on("error", (e) => { clearTimeout(timer); reject(e); });
        let req = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n`;
        if (payload) req += `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n`;
        req += "\r\n";
        s.write(req);
        if (payload) s.write(payload);
      })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// Minimal HTTP/1.1 response parse. The bootnode always sends a Content-Length body (never
// chunked), and we close the connection per request, so header/body split is enough.
function parseHttp(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep === -1) throw new Error("no HTTP header terminator");
  const head = buf.subarray(0, sep).toString("utf8");
  const status = Number(head.split("\r\n")[0].split(" ")[1]);
  const body = buf.subarray(sep + 4).toString("utf8");
  if (status !== 200) throw new Error(`bootnode HTTP ${status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
