// Example: use the fleet WITHOUT the local client proxy — call ShadeTreeClient directly.
//
// This is the "Option A" client shape for your own code (e.g. a searxng-style agent doing
// many queries): no local proxy process, just a library call that proves and routes one tunnel.
// Each fetch mints a fresh RLN proof (fresh nullifier / slot) and rotates gateways.
//
// Prereqs:
//   - an enrolled member secret in SHADE_TREE_SECRET (or edit below),
//   - a running client Tor SOCKS (scripts/start-tor-client.sh -> 9260),
//   - the signed directory + its signer.
//
// Run:
//   SHADE_TREE_SECRET=0x… \
//   SHADE_TREE_DIRECTORY=$PWD/network/sepolia/directory.json \
//   SHADE_TREE_DIR_SIGNER=189f4511…1321 \
//   SHADE_TREE_TOR_PORT=9260 \
//   node examples/agent-fetch.mjs  https://api.ipify.org  https://cloudflare.com/cdn-cgi/trace

import { ShadeTreeClient, cleanUp } from "../client/shade-tree-client.mjs";

const urls = process.argv.slice(2);
if (!urls.length) urls.push("https://api.ipify.org");

const shadeTree = new ShadeTreeClient({
  // reads SHADE_TREE_SECRET / SHADE_TREE_DIRECTORY / SHADE_TREE_DIR_SIGNER / SHADE_TREE_TOR_PORT from env by
  // default; pass them explicitly here if you prefer.
});

for (const url of urls) {
  const t0 = Date.now();
  try {
    const res = await shadeTree.fetch(url);
    console.log(`GET ${url}  ->  ${res.status}  (${Date.now() - t0}ms)`);
    console.log(`     body: ${res.body.trim().slice(0, 120).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`GET ${url}  ->  ERROR ${e.message}`);
  }
}

cleanUp(); // terminate snarkjs workers so the process exits
