// The Shade Tree client proxy: a local HTTP CONNECT proxy that adds a reputation proof and routes to
// a gateway onion over Tor. It is a thin front-end over client/shade-tree-client.mjs — proving,
// slot/gateway rotation, deterministic retry, Tor dialing, and tunneling all live in
// ShadeTreeClient. Run the proxy when you want unmodified tools to use the Grove:
//
//   HTTPS_PROXY=http://127.0.0.1:8888 curl https://example.com
//   curl -x http://127.0.0.1:8888 https://api.ipify.org
//
// Application code may also use ShadeTreeClient directly, but CONNECT is the stable integration
// surface for agents and existing HTTP clients.
//
// Two anti-correlation rotations run together (docs/NEXT-VERSION.md B), inside ShadeTreeClient:
// a different gateway onion per CONNECT tunnel and a different per-tunnel slot nullifier. The
// deterministic-retry invariant (same signal reused across failover) also lives there.

import http from "node:http";
import { ShadeTreeClient, makeSlotPool, buildEnvelope } from "./shade-tree-client.mjs";

// Re-exported for the selftest + any caller that historically imported them from the shim.
export { makeSlotPool, buildEnvelope };

const LISTEN_PORT = Number(process.env.SHADE_TREE_SHIM_PORT || 8888);

function startClientProxy() {
  if (!process.env.SHADE_TREE_SECRET) {
    console.error("set SHADE_TREE_SECRET (from `shade-tree enroll`) before starting the client proxy");
    process.exit(1);
  }

  // One client (one slot pool) for the whole proxy; it reads the SHADE_TREE_* client environment
  // (SHADE_TREE_SECRET, SHADE_TREE_ONION | SHADE_TREE_DIRECTORY+SHADE_TREE_DIR_SIGNER, SHADE_TREE_TOR_HOST/PORT).
  const client = new ShadeTreeClient();

  const server = http.createServer();

  // Plain HTTP has no end-to-end TLS and is deliberately unsupported. `shade-tree run` sets
  // HTTP_PROXY to this listener as well as HTTPS_PROXY so accidental plaintext requests fail here
  // instead of silently taking a direct route.
  server.on("request", (_req, res) => {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    res.end("Shade Tree accepts HTTPS CONNECT tunnels only.\n");
  });

  server.on("connect", async (req, clientSocket, head) => {
    const target = req.url; // "host:port"
    console.log(`REQ     ${target}`); // start marker: a hang after this points at the dial/gateway
    try {
      // ShadeTreeClient.connect builds one proof, picks a gateway (rotation + failover), dials it
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
      const via = tunnel.shadeTree?.onion ? `${String(tunnel.shadeTree.onion).slice(0, 16)}..onion` : "gateway";
      console.log(`TUNNEL  ${target}  slot=${tunnel.shadeTree?.slot} via ${via}`);
    } catch (e) {
      const msg = String(e.message || e);
      const label = msg.startsWith("gate refused") ? "REFUSED" : "ERROR  ";
      try { clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${msg}\n`); } catch {}
      clientSocket.destroy();
      console.log(`${label} ${target}  (${msg})`);
    }
  });

  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`Shade Tree client: http://127.0.0.1:${LISTEN_PORT}  ->  Tor SOCKS ${client.torHost}:${client.torPort}  ->  gateway.onion`);
    console.log(`mode: ${client.onion ? "pinned onion" : "directory fleet rotation"}; per-tunnel slot + gateway rotation`);
    console.log(`admission: leaf source=${client.leafSourcePin} (SHADE_TREE_LEAF_SOURCE; auto = whichever set holds the leaf), max-anon=${client.maxAnon ? "ON (invited-only gateways)" : "off"} (SHADE_TREE_MAX_ANON / --max-anon)`);
    console.log(`use:  curl -x http://127.0.0.1:${LISTEN_PORT} https://api.ipify.org?format=json`);
  });
}

// Only stand up the server when run directly; importing pulls the re-exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) startClientProxy();
