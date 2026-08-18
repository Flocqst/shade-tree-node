// The client shim: a local HTTP CONNECT proxy that adds a reputation proof and routes to
// a gateway onion over Tor. It is now a THIN front-end over client/rgoe-client.mjs — the
// proving, slot/gateway rotation, deterministic-retry, Tor dial and tunnel all live in
// RgoeClient. Run the shim when you want unmodified tools to use the fleet:
//
//   http_proxy=http://127.0.0.1:8888  https_proxy=... curl https://example.com
//   curl -x http://127.0.0.1:8888 https://api.ipify.org
//
// If the client is your OWN code (e.g. an agent doing many queries), skip the shim and use
// RgoeClient directly:  const rgoe = new RgoeClient({ secret, directory, dirSigner });
//   await rgoe.fetch("https://…")   /   await rgoe.connect("host:443")
//
// Two anti-correlation rotations run together (docs/NEXT-VERSION.md B), inside RgoeClient:
// a different gateway onion per request AND a different per-request slot nullifier, so even
// colluding operators cannot rejoin a member's requests across a shared per-epoch key. The
// deterministic-retry invariant (same signal reused across failover) also lives there.

import http from "node:http";
import { RgoeClient, makeSlotPool, buildEnvelope } from "./rgoe-client.mjs";

// Re-exported for the selftest + any caller that historically imported them from the shim.
export { makeSlotPool, buildEnvelope };

const LISTEN_PORT = Number(process.env.RGOE_SHIM_PORT || 8888);

function startShim() {
  if (!process.env.RGOE_SECRET) {
    console.error("set RGOE_SECRET (from `node group/enroll.mjs`) before starting the shim");
    process.exit(1);
  }

  // One client (one slot pool) for the whole shim; it reads the same RGOE_* env as before
  // (RGOE_SECRET, RGOE_ONION | RGOE_DIRECTORY+RGOE_DIR_SIGNER, RGOE_TOR_HOST/PORT).
  const client = new RgoeClient();

  const server = http.createServer();

  server.on("connect", async (req, clientSocket, head) => {
    const target = req.url; // "host:port"
    console.log(`REQ     ${target}`); // start marker: a hang after this points at the dial/gateway
    try {
      // RgoeClient.connect builds ONE proof, picks a gateway (rotation + failover), dials it
      // over Tor, sends the envelope, checks the ack, and returns a raw tunnel to the target.
      // TLS stays end-to-end client<->target.
      const tunnel = await client.connect(target, {
        // T-FEAT-9: name the leaf source + the admitted candidate list once selection settles, so a
        // "why did it go to THAT gateway" question is answerable from the log (onions only).
        onEvent: (e) => { if (e.phase === "select" && e.status === "done") console.log(`SELECT  ${target}  leaf=${e.leafSource || "?"}${e.maxAnon ? " max-anon" : ""}  candidates=${e.candidates.map((c) => `${String(c.onion).slice(0, 12)}..${c.admits ? "[" + c.admits.join(",") + "]" : "[?]"}`).join(" ")}`); },
      });

      clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head && head.length) tunnel.write(head);
      clientSocket.pipe(tunnel);
      tunnel.pipe(clientSocket);
      clientSocket.on("error", () => tunnel.destroy());
      tunnel.on("error", () => clientSocket.destroy());
      const via = tunnel.rgoe?.onion ? `${String(tunnel.rgoe.onion).slice(0, 16)}..onion` : "gateway";
      console.log(`TUNNEL  ${target}  slot=${tunnel.rgoe?.slot} via ${via}`);
    } catch (e) {
      const msg = String(e.message || e);
      const label = msg.startsWith("gate refused") ? "REFUSED" : "ERROR  ";
      try { clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${msg}\n`); } catch {}
      clientSocket.destroy();
      console.log(`${label} ${target}  (${msg})`);
    }
  });

  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`shim up: http://127.0.0.1:${LISTEN_PORT}  ->  Tor SOCKS ${client.torHost}:${client.torPort}  ->  gateway.onion`);
    console.log(`mode: ${client.onion ? "pinned onion" : "directory fleet rotation"}; per-request slot + gateway rotation`);
    console.log(`admission: leaf source=${client.leafSourcePin} (RGOE_LEAF_SOURCE; auto = whichever set holds the leaf), max-anon=${client.maxAnon ? "ON (invited-only gateways)" : "off"} (RGOE_MAX_ANON / --max-anon)`);
    console.log(`use:  curl -x http://127.0.0.1:${LISTEN_PORT} https://api.ipify.org?format=json`);
  });
}

// Only stand up the server when run directly; importing pulls the re-exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) startShim();
