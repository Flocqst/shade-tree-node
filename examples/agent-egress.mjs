// Example: an AI agent (or any of your own code) egressing through the fleet with NO
// local proxy process; the library style. This closes the loop back to the project's
// origin use case: a SearXNG-style client doing many queries from a clean, gated egress IP
// without ever revealing who it is (see the README "problem" section + docs/ADAPTERS.md).
//
// It constructs an RgoeClient from env, does one HTTPS fetch to an echo-IP service, and
// prints the egress IP. That IP is a GATEWAY's, not this machine's: the request went out
// over Tor (no exit node, so the gateway never learned your IP) carrying a fresh RLN
// membership proof (fresh nullifier + slot), and the gateway relayed only ciphertext
// (TLS stays end-to-end to the target).
//
// NOTE: this needs a LIVE fleet to actually run (a bootnode announcing at least one live
// gateway, plus a local client Tor SOCKS). It PARSES and constructs the client without a
// fleet, but rgoe.fetch() will error until a gateway is reachable. Stand up the fleet
// first with docs/QUICKSTART.md.
//
// Prereqs (all from env; flags on `rgoe client` map to these same vars):
//   RGOE_SECRET          an enrolled member secret     (`rgoe enroll`)
//   RGOE_BOOTNODE_ONION  the bootnode's v3 onion        (live directory over Tor)
//   RGOE_DIR_SIGNER      the bootnode's pinned signer pubkey (verifies the directory)
//   RGOE_TOR_PORT        client Tor SOCKS port          (optional; default 9250,
//                                                        the bundled client-tor helper is 9260)
//
// Run:
//   RGOE_SECRET=0x… \
//   RGOE_BOOTNODE_ONION=<56-char>.onion \
//   RGOE_DIR_SIGNER=<bootnode-signer-pubkey> \
//   node examples/agent-egress.mjs

import { RgoeClient, cleanUp } from "../client/rgoe-client.mjs";

for (const v of ["RGOE_SECRET", "RGOE_BOOTNODE_ONION", "RGOE_DIR_SIGNER"]) {
  if (!process.env[v]) {
    console.error(`set ${v} (see the header of this file / docs/ADAPTERS.md)`);
    process.exit(1);
  }
}

// Reads RGOE_SECRET / RGOE_BOOTNODE_ONION / RGOE_DIR_SIGNER / RGOE_TOR_PORT from env.
// RGOE_BOOTNODE_ONION selects live directory discovery: the client pulls the signed
// gateway set over Tor, verifies it against RGOE_DIR_SIGNER, and rotates per request.
const rgoe = new RgoeClient();

try {
  const t0 = Date.now();
  // Each fetch mints a fresh proof and picks a (possibly different) gateway. Do many of
  // these from an agent loop and every request is mutually unlinkable, even to the gateway.
  const res = await rgoe.fetch("https://api.ipify.org?format=json");
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
