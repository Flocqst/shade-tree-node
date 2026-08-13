// Selftest for lib/gateway-registry.mjs — the StakeVerifier the bootnode uses to decide
// which gateways an admission=stake policy admits. Covers both providers with no chain:
// the mock (open + allowlist) and the on-chain eth_call encode/decode against a stubbed fetch.
//
//   node lib/gateway-registry.selftest.mjs

import pkg from "js-sha3";
const { keccak256 } = pkg;
import { MockStakeVerifier, OnchainStakeVerifier, makeStakeVerifier } from "./gateway-registry.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

async function main() {
  console.log("MockStakeVerifier:");
  {
    const open = MockStakeVerifier({});
    ok(open.mode === "mock:open", "no allowlist => open mode");
    ok((await open.isStaked(A)) === true && (await open.isStaked(B)) === true, "open mode: everyone counts as staked");

    const allow = MockStakeVerifier({ allowlist: `${A}, ${B.toUpperCase()}` });
    ok(allow.mode.startsWith("mock:allowlist"), "allowlist mode reported");
    ok((await allow.isStaked(A)) === true, "allowlisted address is staked");
    ok((await allow.isStaked(B.toLowerCase())) === true, "allowlist is case-insensitive");
    ok((await allow.isStaked("0x3333333333333333333333333333333333333333")) === false, "non-listed address is not staked");
  }

  console.log("\nmakeStakeVerifier factory resolution:");
  {
    const saved = { reg: process.env.RGOE_GATEWAY_REGISTRY, mode: process.env.RGOE_STAKE_MODE };
    delete process.env.RGOE_GATEWAY_REGISTRY; delete process.env.RGOE_STAKE_MODE;
    ok(makeStakeVerifier().mode.startsWith("mock"), "no registry => mock by default");
    ok(makeStakeVerifier("mock").mode.startsWith("mock"), "explicit mock honored");
    process.env.RGOE_GATEWAY_REGISTRY = "0x000000000000000000000000000000000000dEaD";
    ok(makeStakeVerifier().mode === "onchain", "registry set => onchain by default");
    let threw = false; try { makeStakeVerifier("bogus"); } catch { threw = true; }
    ok(threw, "unknown mode rejected");
    // restore
    if (saved.reg) process.env.RGOE_GATEWAY_REGISTRY = saved.reg; else delete process.env.RGOE_GATEWAY_REGISTRY;
    if (saved.mode) process.env.RGOE_STAKE_MODE = saved.mode; else delete process.env.RGOE_STAKE_MODE;
  }

  console.log("\nOnchainStakeVerifier eth_call encode/decode (stubbed fetch):");
  {
    const realFetch = globalThis.fetch;
    const CONTRACT = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
    const selector = "0x" + keccak256("isStaked(address)").slice(0, 8);
    let lastCall = null, calls = 0;
    // stub: capture the eth_call, return true for A (nonzero word), false otherwise.
    globalThis.fetch = async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      lastCall = { url, method: body.method, params: body.params };
      // decide by the address embedded in the calldata (last 40 hex of the 32-byte arg)
      const addr = body.params[0].data.toLowerCase().slice(-40);
      const isA = addr === A.slice(2).toLowerCase();
      return { json: async () => ({ jsonrpc: "2.0", id: body.id, result: isA ? "0x" + "0".repeat(63) + "1" : "0x" + "0".repeat(64) }) };
    };
    try {
      const v = OnchainStakeVerifier({ rpcUrl: "http://stub", contract: CONTRACT, cacheMs: 10_000 });
      ok(v.mode === "onchain", "onchain mode");
      const rA = await v.isStaked(A);
      ok(rA === true, "staked address decodes to true (nonzero return word)");
      ok(lastCall.method === "eth_call" && lastCall.params[0].to.toLowerCase() === CONTRACT.toLowerCase(), "calls eth_call on the registry address");
      ok(lastCall.params[0].data.startsWith(selector), "calldata carries the isStaked(address) selector");
      ok(lastCall.params[0].data.length === 2 + 8 + 64, "calldata = 0x + 4-byte selector + 32-byte address arg");
      ok((await v.isStaked(B)) === false, "unstaked address decodes to false (zero return word)");

      // caching: a repeat within cacheMs must not hit the RPC again
      const before = calls; await v.isStaked(A);
      ok(calls === before, "result is cached within cacheMs (no duplicate RPC)");

      // bad address input rejected before any RPC
      let threw = false; try { await v.isStaked("not-an-address"); } catch { threw = true; }
      ok(threw, "malformed address is rejected");
    } finally { globalThis.fetch = realFetch; }
  }

  console.log("\nOnchainStakeVerifier fail-closed on bad RPC responses:");
  {
    const realFetch = globalThis.fetch;
    try {
      // 1. an RPC-level error must THROW, so a caller in requireStake mode rejects (never admits).
      globalThis.fetch = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "node down" } }) });
      const v1 = OnchainStakeVerifier({ rpcUrl: "http://stub", contract: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", cacheMs: 0 });
      let threw = false; try { await v1.isStaked("0x1111111111111111111111111111111111111111"); } catch { threw = true; }
      ok(threw, "an RPC error throws (caller fails closed), never silently returns staked");

      // 2. an empty "0x" (no return data, e.g. wrong address / not a contract) decodes to false.
      globalThis.fetch = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) });
      const v2 = OnchainStakeVerifier({ rpcUrl: "http://stub", contract: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", cacheMs: 0 });
      ok((await v2.isStaked("0x1111111111111111111111111111111111111111")) === false, "empty 0x return decodes to not-staked (fail-closed)");
    } finally { globalThis.fetch = realFetch; }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: gateway-registry selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
