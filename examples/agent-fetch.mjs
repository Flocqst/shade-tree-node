// Example: use the fleet WITHOUT the shim proxy — call RgoeClient directly.
//
// This is the "Option A" client shape for your own code (e.g. a searxng-style agent doing
// many queries): no local proxy process, just a library call that proves + routes per
// request. Each fetch mints a fresh RLN proof (fresh nullifier / slot) and rotates gateways,
// so the anonymity + rate-limit properties are identical to the shim.
//
// Prereqs:
//   - an enrolled member secret in RGOE_SECRET (or edit below),
//   - a running client Tor SOCKS (scripts/start-tor-client.sh -> 9260),
//   - the signed directory + its signer.
//
// Run:
//   RGOE_SECRET=0x… \
//   RGOE_DIRECTORY=$PWD/network/sepolia/directory.json \
//   RGOE_DIR_SIGNER=189f4511…1321 \
//   RGOE_TOR_PORT=9260 \
//   node examples/agent-fetch.mjs  https://api.ipify.org  https://cloudflare.com/cdn-cgi/trace

import { RgoeClient, cleanUp } from "../client/rgoe-client.mjs";

const urls = process.argv.slice(2);
if (!urls.length) urls.push("https://api.ipify.org");

const rgoe = new RgoeClient({
  // reads RGOE_SECRET / RGOE_DIRECTORY / RGOE_DIR_SIGNER / RGOE_TOR_PORT from env by
  // default; pass them explicitly here if you prefer.
});

for (const url of urls) {
  const t0 = Date.now();
  try {
    const res = await rgoe.fetch(url);
    console.log(`GET ${url}  ->  ${res.status}  (${Date.now() - t0}ms)`);
    console.log(`     body: ${res.body.trim().slice(0, 120).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`GET ${url}  ->  ERROR ${e.message}`);
  }
}

cleanUp(); // terminate snarkjs workers so the process exits
