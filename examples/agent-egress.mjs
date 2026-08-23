// Example: an AI agent (or any of your own code) egressing through the fleet with NO
// local proxy process; the library style. This closes the loop back to the project's
// origin use case: a SearXNG-style client doing many queries from a clean, gated egress IP
// without ever revealing who it is (see the README "problem" section + docs/ADAPTERS.md).
//
// It constructs a ShadeTreeClient from env, does one HTTPS fetch to an echo-IP service, and
// prints the egress IP. That IP is a GATEWAY's, not this machine's: the request went out
// over Tor (no exit node, so the gateway never learned your IP) carrying a fresh RLN
// membership proof (fresh nullifier + slot), and the gateway relayed only ciphertext
// (TLS stays end-to-end to the target).
//
// NOTE: this needs a LIVE fleet to actually run (a bootnode announcing at least one live
// gateway, plus a local client Tor SOCKS). It PARSES and constructs the client without a
// fleet, but shadeTree.fetch() will error until a gateway is reachable. Stand up the fleet
// first with docs/QUICKSTART.md.
//
// Prereqs (all from env; flags on `shade-tree client` map to these same vars):
//   SHADE_TREE_SECRET          an enrolled member secret     (`shade-tree enroll`)
//   SHADE_TREE_BOOTNODE_ONION  the bootnode's v3 onion        (live directory over Tor)
//   SHADE_TREE_DIR_SIGNER      the bootnode's pinned signer pubkey (verifies the directory)
//   SHADE_TREE_TOR_PORT        client Tor SOCKS port          (optional; default 9250,
//                                                        the bundled client-tor helper is 9260)
//
// Run:
//   SHADE_TREE_SECRET=0x… \
//   SHADE_TREE_BOOTNODE_ONION=<56-char>.onion \
//   SHADE_TREE_DIR_SIGNER=<bootnode-signer-pubkey> \
//   node examples/agent-egress.mjs

import { ShadeTreeClient, cleanUp } from "../client/shade-tree-client.mjs";

for (const v of ["SHADE_TREE_SECRET", "SHADE_TREE_BOOTNODE_ONION", "SHADE_TREE_DIR_SIGNER"]) {
  if (!process.env[v]) {
    console.error(`set ${v} (see the header of this file / docs/ADAPTERS.md)`);
    process.exit(1);
  }
}

// Reads SHADE_TREE_SECRET / SHADE_TREE_BOOTNODE_ONION / SHADE_TREE_DIR_SIGNER / SHADE_TREE_TOR_PORT from env.
// SHADE_TREE_BOOTNODE_ONION selects live directory discovery: the client pulls the signed
// gateway set over Tor, verifies it against SHADE_TREE_DIR_SIGNER, and rotates per tunnel.
const shadeTree = new ShadeTreeClient();

try {
  const t0 = Date.now();
  // Each direct-library fetch opens a fresh tunnel, mints a fresh proof, and picks a possibly
  // different gateway. Proxy integrations rotate when their HTTP client opens a new CONNECT tunnel.
  const res = await shadeTree.fetch("https://api.ipify.org?format=json");
  const egressIp = JSON.parse(res.body).ip;
  const via = res.gateway?.onion ? `${String(res.gateway.onion).slice(0, 16)}..onion` : "gateway";
  console.log(`egress IP: ${egressIp}   (via ${via}, ${Date.now() - t0}ms)`);
  console.log("that is the gateway's clean IP, not this machine's; the gateway never saw yours.");
} catch (e) {
  console.error(`fetch failed: ${e.message}`);
  console.error("is the fleet live? (bootnode + a reachable gateway + client Tor SOCKS). See docs/QUICKSTART.md");
  process.exitCode = 1;
} finally {
  cleanUp(); // terminate snarkjs workers so the process exits
}
