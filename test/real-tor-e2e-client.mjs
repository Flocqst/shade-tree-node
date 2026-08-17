// T-TEST-1 client runner: drive the JS REFERENCE client (client/rgoe-client.mjs) through a
// REAL published .onion gateway over Tor SOCKS, mint a real RLN membership proof per request,
// and assert the gateway ACCEPTS (ok ack + open tunnel). The gateway proxies the CONNECT to a
// local sink; the harness (test/real-tor-e2e.sh) asserts the sink received the connection.
//
// This is a THIN driver: it adds no protocol logic. It only instantiates RgoeClient exactly as
// a real caller would and reports the handshake outcome as JSON on the last line of stdout so
// the shell harness can parse it. No source under client/ is touched.
//
//   env RGOE_SECRET  member app secret (its rateCommitment leaf must be in group/members.json)
//       RGOE_ONION   gateway onion (with or without the .onion suffix)
//       RGOE_TOR_PORT Tor SOCKS port to dial over
//   argv[2]          target "host:port" (the local sink the gateway egresses to)
//
// Exit 0 + `{"accept":true,...}` on an accepted egress; nonzero + `{"accept":false,...}` otherwise.

import { RgoeClient } from "../client/rgoe-client.mjs";
import { cleanUp } from "../lib/semaphore.mjs";

const target = process.argv[2] || "127.0.0.1:9443";
const secret = process.env.RGOE_SECRET;
const onion = process.env.RGOE_ONION;
if (!secret) { console.error("real-tor-e2e-client: RGOE_SECRET is required"); process.exit(2); }
if (!onion) { console.error("real-tor-e2e-client: RGOE_ONION is required"); process.exit(2); }

// A generous per-request dial budget: v3 HS descriptor propagation is slow on a cold onion, so
// give the SOCKS dial several attempts before the whole run is retried by the shell.
const dialAttempts = Number(process.env.RGOE_DIAL_ATTEMPTS || 6);

function emit(e) {
  // Surface each phase so a CI log shows the real cryptographic + network progress.
  const parts = [`[client] ${e.phase}/${e.status}`];
  if (e.onion) parts.push(`onion=${String(e.onion).slice(0, 16)}..`);
  if (e.slot != null) parts.push(`slot=${e.slot}`);
  if (e.nullifier) parts.push(`nullifier=${String(e.nullifier).slice(0, 12)}..`);
  if (e.latencyMs != null) parts.push(`latencyMs=${e.latencyMs}`);
  if (e.error) parts.push(`error=${e.error}`);
  console.error(parts.join(" "));
}

async function main() {
  const client = new RgoeClient({ secret, onion, torPort: Number(process.env.RGOE_TOR_PORT || 9050), dialAttempts });
  const t0 = Date.now();
  const tunnel = await client.connect(target, { onEvent: emit });
  // Reaching here means the gateway replied `{ ok: true }` (an ACCEPT) and opened the tunnel —
  // which the gateway only does AFTER it has connected out to the target sink. Push one byte so
  // there is genuine payload on the wire, then close cleanly.
  await new Promise((resolve) => { tunnel.write(Buffer.from("rgoe-e2e\n")); tunnel.end(resolve); });
  const rgoe = tunnel.rgoe || {};
  console.log(JSON.stringify({
    accept: true,
    target,
    onion: rgoe.onion,
    slot: rgoe.slot,
    nullifier: rgoe.nullifier ? String(rgoe.nullifier) : null,
    ms: Date.now() - t0,
  }));
}

main()
  .then(() => { cleanUp(); process.exit(0); })
  .catch((e) => {
    console.error("[client] egress FAILED:", e && e.message);
    console.log(JSON.stringify({ accept: false, target, error: (e && e.message) || String(e) }));
    cleanUp();
    process.exit(1);
  });
