// The registrar: sell membership leaves for a stablecoin over HTTP 402 (T-FEAT-7, Layer 1 of
// docs/PAYMENTS.md as shipped 2026-08-17). A loopback HTTP service the operator publishes as an
// extra port of an onion this box already runs (HiddenServicePort 8878 127.0.0.1:8878, bootstrap
// SHADE_TREE_REGISTRAR=1): the BOOTNODE onion on a bootnode+gateway box, the GATEWAY onion on a
// gateway-only box (T-FEAT-9: every provider may run its own registrar + its own PaidAccessSet
// and sell access on its own terms; the gateway then advertises `caps.pay`). It speaks the
// machine-payment 402 rails the provider ENABLES (SHADE_TREE_PAY_PROTOCOLS, default both) over one
// settlement primitive:
//
//   x402 v2   402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE     (payments/wire.mjs)
//   MPP       402 + WWW-Authenticate: Payment / Authorization: Payment / Payment-Receipt
//   settle    EIP-3009 transferWithAuthorization: the BUYER signs typed data (needs the coin, no
//             gas); the OPERATOR submits it and pays the gas (payments/eip3009.mjs)
//   insert    PaidAccessSet.insert(commitment, limit) from the operator key -> the buyer's leaf is
//             in the on-chain paid tree; the gateway trusts that root (ship/pay-client) and the
//             buyer egresses with the ordinary RLN proof. Redemption is unchanged.
//
// THE OPERATOR IS THE FACILITATOR. There is no hosted verify/settle party: this process verifies
// the typed-data signature and submits the transfer itself (self-hosted x402 facilitator; the MPP
// server role). A hosted facilitator is optional and NOT used — the "no facilitator party" rule
// of docs/PAYMENTS.md holds: the buyer touches the chain and the operator, nobody else.
//
// What the registrar VERIFIES before it spends gas (both rails):
//   - shape of the wire object (payments/wire.mjs parse*), protocol version / scheme / network / asset
//   - the offer: to == payTo, value == price(limit), limit is a sold tier, body.limit == paid tier
//   - validAfter <= now < validBefore - settle buffer (so the tx can still mine)
//   - EIP-712 signature recovers to `from` over the TOKEN's domain (probed at boot: on-chain
//     DOMAIN_SEPARATOR() must equal our computed one, else refuse to start)
//   - authorizationState(from, nonce) == false on chain (unused nonce), balanceOf(from) >= value
//   - the commitment is not already an active leaf (never take money for a leaf we can't insert)
//   - eth_call simulation of transferWithAuthorization succeeds
// Then, serialized on the operator key: settle tx -> wait 1 confirmation -> insert tx -> wait.
//
// Idempotency + crash safety: every order is keyed by (asset, from, nonce) in a small JSON store
// (SHADE_TREE_REGISTRAR_STORE, atomic tmp+rename like the bootnode's). A settle that mined but whose
// insert did not is RESUMED on boot and on the next identical POST; an identical replay of a
// finished order returns the stored receipt (200) without a second insert; the same nonce with a
// different commitment is refused (409). The chain is the second replay guard: the token burns
// the nonce, so a captured authorization can never move funds twice.
//
// Config (all SHADE_TREE_*; docs/CONFIG.md "Registrar"):
//   SHADE_TREE_REGISTRAR_KEY          operator hot key (settles + inserts; pays gas)             REQUIRED
//   SHADE_TREE_PAID_ACCESS_CONTRACT   PaidAccessSet address (operator-insert-only tree)         REQUIRED
//   SHADE_TREE_RPC_URL                execution JSON-RPC (or the SHADE_TREE_NETWORK record's)          REQUIRED
//   SHADE_TREE_PAY_ASSET              EIP-3009 ERC-20 (Sepolia USDC 0x1c7D4B19…7238, or the test tUSD) REQUIRED
//   SHADE_TREE_PAY_PRICES             per-tier price in the asset's atomic units: "8=100000,32=400000" REQUIRED
//   SHADE_TREE_PAY_TO                 recipient of the stablecoin (default: the operator address)
//   SHADE_TREE_PAY_PROTOCOLS          rails to serve: x402,mpp (default both) or either alone (T-FEAT-9); a
//                               disabled rail gets no challenge and its payload is refused 400
//   SHADE_TREE_REGISTRAR_PORT         loopback port (default 8878)
//   SHADE_TREE_REGISTRAR_ONION        this service's onion (resource URL + MPP realm; default 127.0.0.1)
//   SHADE_TREE_REGISTRAR_STORE        JSON order store path (default payments/registrar-state.local.json)
//   SHADE_TREE_PAY_TIMEOUT            challenge/authorization validity, seconds (maxTimeoutSeconds; default 600)
//   SHADE_TREE_PAY_SETTLE_BUFFER      seconds of validBefore headroom a payment must still have (default 20)
//   SHADE_TREE_PAY_CONFIRMATIONS      confirmations to wait per tx (default 1)
//   SHADE_TREE_PAY_ASSET_NAME / SHADE_TREE_PAY_ASSET_VERSION   EIP-712 domain overrides (default: token name()/version())
//   SHADE_TREE_REGISTRAR_PAY_RATE / _PAY_BURST     token bucket in front of POST /pay (default 1/s, burst 10)
//   SHADE_TREE_REGISTRAR_QUOTE_RATE / _QUOTE_BURST token bucket in front of quotes (default 20/s, burst 100)
//   SHADE_TREE_REGISTRAR_MAX_INFLIGHT  concurrent settlements (default 8; over => 503 + Retry-After)
//   SHADE_TREE_REGISTRAR_HEADERS_TIMEOUT_MS / _REQUEST_TIMEOUT_MS / _KEEPALIVE_TIMEOUT_MS /
//   _MAX_HEADER_BYTES / _CONN_CHECK_MS   HTTP slow-client limits (same defaults as the bootnode)

import http from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { log } from "../lib/log.mjs";
import { registry as metrics } from "../lib/metrics.mjs";
import { networkDefault } from "../lib/network-record.mjs";
import { parsePayProtocols } from "../lib/admission.mjs";
import { makeAnnounceBucket, makeGracefulShutdown } from "../bootnode/server.mjs";
import { EIP3009_ABI, tokenDomain, recoverAuthorization, splitSignature, isAddress, isUintString, sameAddress } from "./eip3009.mjs";
import {
  parsePrices, priceOf, tierList, caip2, contentDigest,
  x402PaymentRequired, encodeX402Header, parseX402Payment, x402Settlement,
  mppChallenge, parseMppCredential, mppReceipt, mppProblem,
} from "./wire.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// BN254 scalar field: a commitment (Poseidon output) is a field element.
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const isCommitment = (v) => isUintString(v) && BigInt(v) < FIELD_P;

// The PaidAccessSet surface the registrar uses (contracts/PaidAccessSet.sol, T-FEAT-7 1/3).
export const PAID_ACCESS_SET_ABI = Object.freeze([
  "function insert(uint256 commitment, uint256 limit)",
  "function insertBatch(uint256[] commitments, uint256[] limits)",
  "function currentRoot() view returns (uint256)",
  "function limitOf(uint256 commitment) view returns (uint256)",
  "function leafCount() view returns (uint256)",
  "function allowedLimits() view returns (uint256[])",
  "function operator() view returns (address)",
  "event Inserted(uint256 indexed commitment, uint256 limit, uint256 index, uint256 root)",
]);

// ---- metrics ------------------------------------------------------------------------------
const M = {
  quotes: metrics.counter("shade_tree_registrar_quotes_total", "402 quotes served, labeled route=quote|pay."),
  payments: metrics.counter("shade_tree_registrar_payments_total", "POST /pay outcomes, labeled protocol=x402|mpp result=inserted|replayed|rejected|failed (+ reason)."),
  settleTxs: metrics.counter("shade_tree_registrar_txs_total", "Operator transactions sent, labeled kind=settle|insert result=ok|failed."),
};

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ---- the order store ---------------------------------------------------------------------
// { version: 1, mppSecret: <hex>, orders: { "<asset>:<from>:<nonce>": Order } }
// Order: { asset, from, nonce, commitment, limit, protocol, state, settleTx, insertTx, leafIndex,
//          root, createdAt, updatedAt, error? }   state: settling | settled | inserted | failed
export function makeStore(path) {
  let data = { version: 1, mppSecret: null, orders: {} };
  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && parsed.version === 1 && parsed.orders && typeof parsed.orders === "object") data = { ...data, ...parsed };
      else log.warn("registrar store: unrecognized shape, starting empty", { store: path });
    } catch (e) {
      log.error("registrar store: unreadable, starting empty", { store: path, err: e.message });
    }
  }
  // The MPP challenge-binding secret lives WITH the orders so a restart keeps unexpired challenges
  // valid (core draft: rotate only with an overlap; we simply persist).
  if (!data.mppSecret) data.mppSecret = randomBytes(32).toString("hex");
  function persist() {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      log.error("registrar store: write failed (continuing)", { err: e.message });
    }
  }
  persist();
  const key = (asset, from, nonce) => `${asset.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
  return {
    path,
    mppSecret: () => data.mppSecret,
    get: (asset, from, nonce) => data.orders[key(asset, from, nonce)] || null,
    put(order) {
      order.updatedAt = Date.now();
      data.orders[key(order.asset, order.from, order.nonce)] = order;
      persist();
      return order;
    },
    byNonce: (nonce) => Object.values(data.orders).filter((o) => o.nonce.toLowerCase() === String(nonce).toLowerCase()),
    all: () => Object.values(data.orders),
    size: () => Object.keys(data.orders).length,
  };
}

// ---- the offer (price list) --------------------------------------------------------------
// Everything a quote is rendered from. `assetName`/`assetVersion`/`decimals`/`chainId` are
// filled by probeAsset() from the chain unless overridden by env.
export function makeOffer(env = process.env) {
  if (!isAddress(env.SHADE_TREE_PAY_ASSET || "")) throw new Error("SHADE_TREE_PAY_ASSET must be the EIP-3009 token address (e.g. Sepolia USDC 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238)");
  const tiers = parsePrices(env.SHADE_TREE_PAY_PRICES);
  const port = envInt("SHADE_TREE_REGISTRAR_PORT", 8878);
  const onion = env.SHADE_TREE_REGISTRAR_ONION ? String(env.SHADE_TREE_REGISTRAR_ONION).replace(/\.onion$/, "") + ".onion" : null;
  const host = onion ? `${onion}:${port}` : `127.0.0.1:${port}`;
  return {
    asset: ethers.getAddress(env.SHADE_TREE_PAY_ASSET),
    tiers,
    protocols: parsePayProtocols(env.SHADE_TREE_PAY_PROTOCOLS), // T-FEAT-9: throws on an unknown rail
    payTo: env.SHADE_TREE_PAY_TO ? ethers.getAddress(env.SHADE_TREE_PAY_TO) : null, // null => operator address (set in main)
    maxTimeoutSeconds: envInt("SHADE_TREE_PAY_TIMEOUT", 600),
    settleBufferSec: envInt("SHADE_TREE_PAY_SETTLE_BUFFER", 20),
    realm: env.SHADE_TREE_REGISTRAR_REALM || (onion || "shade-tree-registrar"),
    resourceUrl: `http://${host}/pay`,
    description: "shade-tree egress membership leaf (PaidAccessSet insert)",
    chainId: null, assetName: env.SHADE_TREE_PAY_ASSET_NAME || null, assetVersion: env.SHADE_TREE_PAY_ASSET_VERSION || null, decimals: null,
    port,
  };
}

// Probe the token: name()/version()/decimals(), then PROVE the EIP-712 domain we will sign-check
// against is the token's (DOMAIN_SEPARATOR() equality). Fails closed on a mismatch, so a token
// with an unexpected domain (or no EIP-3009 at all) can never yield a "verified" signature the
// contract would then reject after we spent a slot on it.
export async function probeAsset(offer, token, provider) {
  const net = await provider.getNetwork();
  offer.chainId = Number(net.chainId);
  if (!offer.assetName) offer.assetName = await token.name();
  if (!offer.assetVersion) {
    try { offer.assetVersion = await token.version(); } catch { throw new Error("token has no version(): set SHADE_TREE_PAY_ASSET_VERSION (USDC = \"2\")"); }
  }
  offer.decimals = Number(await token.decimals());
  const want = ethers.TypedDataEncoder.hashDomain(tokenDomain({ name: offer.assetName, version: offer.assetVersion, chainId: offer.chainId, asset: offer.asset }));
  const got = await token.DOMAIN_SEPARATOR();
  if (String(got).toLowerCase() !== want.toLowerCase()) {
    throw new Error(`token DOMAIN_SEPARATOR mismatch (on-chain ${got}, computed ${want} from name=${JSON.stringify(offer.assetName)} version=${JSON.stringify(offer.assetVersion)} chainId=${offer.chainId}); set SHADE_TREE_PAY_ASSET_NAME/SHADE_TREE_PAY_ASSET_VERSION`);
  }
  // authorizationState must exist (EIP-3009). A non-3009 token reverts here.
  await token.authorizationState(ethers.ZeroAddress, ethers.ZeroHash);
  return offer;
}

// ---- the settlement engine ---------------------------------------------------------------
// Transport-independent (the selftest drives it directly and through the HTTP server).
//   verifyAndSettle({ protocol, limit, commitment, authorization, signature, meta }) ->
//     { ok:true, replayed, order } | { ok:false, status, reason, detail }
export function makeEngine({ offer, token, set, wallet, provider, store, confirmations = 1, now = () => Date.now(), maxInflight = 8 }) {
  const domain = () => tokenDomain({ name: offer.assetName, version: offer.assetVersion, chainId: offer.chainId, asset: offer.asset });
  const inflight = new Set(); // order keys currently being settled/inserted
  let txChain = Promise.resolve(); // serialize operator txs (one signer, one nonce sequence)
  const withTxLock = (fn) => { const p = txChain.then(fn, fn); txChain = p.catch(() => {}); return p; };
  const fail = (status, reason, detail) => ({ ok: false, status, reason, detail });

  async function insertLeaf(order) {
    // Resume-safe: if a previous attempt's insert did land, don't insert twice.
    const already = await set.limitOf(order.commitment);
    if (already !== 0n) {
      order.state = "inserted";
      order.leafIndex = order.leafIndex ?? null;
      order.root = (await set.currentRoot()).toString();
      store.put(order);
      return order;
    }
    const tx = await withTxLock(async () => {
      await set.insert.staticCall(order.commitment, order.limit); // surface a revert before paying gas
      return set.insert(order.commitment, order.limit);
    });
    order.insertTx = tx.hash;
    store.put(order);
    const rcpt = await tx.wait(confirmations);
    if (!rcpt || rcpt.status !== 1) { M.settleTxs.inc({ kind: "insert", result: "failed" }); throw new Error("insert tx reverted"); }
    M.settleTxs.inc({ kind: "insert", result: "ok" });
    // Inserted(commitment, limit, index, root): index + the root right after OUR insert (the
    // event's root, not a later currentRoot(), so a concurrent insert can't confuse the receipt).
    let leafIndex = null, root = null;
    for (const lg of rcpt.logs) {
      try {
        const parsed = set.interface.parseLog({ topics: lg.topics, data: lg.data });
        if (parsed && parsed.name === "Inserted" && parsed.args.commitment.toString() === order.commitment) { leafIndex = Number(parsed.args.index); root = parsed.args.root.toString(); break; }
      } catch { /* not ours */ }
    }
    if (leafIndex == null) leafIndex = Number(await set.leafCount()) - 1;
    order.leafIndex = leafIndex;
    order.root = root || (await set.currentRoot()).toString();
    order.state = "inserted";
    store.put(order);
    log.info("registrar: leaf inserted", { commitment: order.commitment, limit: order.limit, leafIndex, insertTx: tx.hash, root: order.root, protocol: order.protocol });
    return order;
  }

  async function settle(order, auth, signature) {
    const { v, r, s } = splitSignature(signature);
    const args = [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s];
    const tx = await withTxLock(async () => {
      await token.transferWithAuthorization.staticCall(...args); // simulate (spec: verify step 6)
      return token.transferWithAuthorization(...args);
    });
    order.settleTx = tx.hash;
    order.state = "settling";
    store.put(order);
    log.info("registrar: settle tx sent", { payer: auth.from, value: auth.value, settleTx: tx.hash, protocol: order.protocol });
    const rcpt = await tx.wait(confirmations);
    if (!rcpt || rcpt.status !== 1) { order.state = "failed"; order.error = "settle-reverted"; store.put(order); M.settleTxs.inc({ kind: "settle", result: "failed" }); throw new Error("settle tx reverted"); }
    M.settleTxs.inc({ kind: "settle", result: "ok" });
    order.state = "settled";
    order.settleBlock = rcpt.blockNumber;
    store.put(order);
    return order;
  }

  async function verifyAndSettle({ protocol, limit, commitment, authorization: auth, signature, meta = {} }) {
    if (!isCommitment(commitment)) return fail(400, "bad-commitment", "commitment must be a decimal field element");
    if (!priceOf(offer, limit)) return fail(400, "unknown-limit", `tier ${limit} is not sold here (${tierList(offer).join(", ")})`);
    const key = `${offer.asset}:${auth.from}:${auth.nonce}`.toLowerCase();
    const existing = store.get(offer.asset, auth.from, auth.nonce);
    if (existing) {
      const same = existing.commitment === commitment && Number(existing.limit) === Number(limit);
      if (!same) return fail(409, "nonce-used", "this authorization nonce was already used for a different order");
      if (inflight.has(key)) return fail(409, "in-progress", "this order is being settled; retry shortly");
      if (existing.state === "inserted") return { ok: true, replayed: true, order: existing };
      if (existing.state === "settled") {
        // Crash between settle and insert: resume the insert (no second payment).
        inflight.add(key);
        try { await insertLeaf(existing); return { ok: true, replayed: true, order: existing }; }
        catch (e) { existing.error = e.shortMessage || e.message; store.put(existing); return fail(502, "insert-failed", "settled but insert failed; retry /pay with the same authorization or ask the operator"); }
        finally { inflight.delete(key); }
      }
      // failed / settling-unknown: fall through and re-verify (a stale 'settling' with an unused
      // nonce means the tx never landed; the buyer's authorization is still good).
    }
    if (inflight.size >= maxInflight) return fail(503, "busy", "too many settlements in flight");

    // Time window: validAfter <= now < validBefore - buffer (the tx must still be able to mine).
    const nowSec = Math.floor(now() / 1000);
    if (BigInt(auth.validAfter) > BigInt(nowSec)) return fail(402, "not-yet-valid", "authorization.validAfter is in the future");
    if (BigInt(auth.validBefore) <= BigInt(nowSec + offer.settleBufferSec)) return fail(402, "expired", `authorization.validBefore must be > now + ${offer.settleBufferSec}s`);
    // The signature over the TOKEN's domain must recover to `from`.
    const signer = recoverAuthorization(domain(), auth, signature);
    if (!signer || !sameAddress(signer, auth.from)) return fail(402, "bad-signature", "signature does not recover to authorization.from");
    // On-chain state: unused nonce, funded payer, insertable commitment.
    let used, bal, active;
    try {
      [used, bal, active] = await Promise.all([token.authorizationState(auth.from, auth.nonce), token.balanceOf(auth.from), set.limitOf(commitment)]);
    } catch (e) {
      return fail(502, "rpc-error", "chain read failed: " + (e.shortMessage || e.message));
    }
    if (used) return fail(402, "nonce-used", "authorization nonce already used on chain");
    if (bal < BigInt(auth.value)) return fail(402, "insufficient_funds", "payer balance below the price");
    if (active !== 0n) return fail(409, "already-member", "this commitment is already an active leaf of the paid set");

    const order = existing || { asset: offer.asset, from: ethers.getAddress(auth.from), nonce: auth.nonce.toLowerCase(), commitment, limit: Number(limit), protocol, createdAt: now() };
    order.protocol = protocol; order.meta = { ...(order.meta || {}), ...meta };
    inflight.add(key);
    try {
      try { await settle(order, auth, signature); }
      catch (e) {
        order.state = order.settleTx ? order.state : "failed";
        order.error = e.shortMessage || e.reason || e.message;
        store.put(order);
        return fail(402, "settle-failed", "transferWithAuthorization would revert or failed: " + shortErr(e));
      }
      try { await insertLeaf(order); }
      catch (e) {
        order.error = e.shortMessage || e.message; store.put(order);
        return fail(502, "insert-failed", "payment settled but the leaf insert failed; the registrar retries on boot, or POST again with the same authorization");
      }
      return { ok: true, replayed: false, order };
    } finally {
      inflight.delete(key);
    }
  }

  // Boot: finish what a crash interrupted. Orders 'settling' are resolved from chain truth
  // (authorizationState); 'settled' ones get their insert.
  async function recover() {
    let resumed = 0, failed = 0;
    for (const order of store.all()) {
      try {
        if (order.state === "settling") {
          const used = await token.authorizationState(order.from, order.nonce);
          if (!used) { order.state = "failed"; order.error = "settle never landed"; store.put(order); failed++; continue; }
          order.state = "settled"; store.put(order);
        }
        if (order.state === "settled") { await insertLeaf(order); resumed++; }
      } catch (e) {
        failed++;
        log.error("registrar: recovery failed for an order", { from: order.from, nonce: order.nonce, err: e.shortMessage || e.message });
      }
    }
    return { resumed, failed };
  }

  return { verifyAndSettle, recover, inflight: () => inflight.size, domain };
}
const shortErr = (e) => String(e.shortMessage || e.reason || e.message || e).slice(0, 200);

// ---- HTTP transport ----------------------------------------------------------------------
export const HTTP_LIMITS = Object.freeze({
  headersTimeout: envInt("SHADE_TREE_REGISTRAR_HEADERS_TIMEOUT_MS", 10000),
  requestTimeout: envInt("SHADE_TREE_REGISTRAR_REQUEST_TIMEOUT_MS", 30000),
  keepAliveTimeout: envInt("SHADE_TREE_REGISTRAR_KEEPALIVE_TIMEOUT_MS", 5000),
  maxHeaderSize: envInt("SHADE_TREE_REGISTRAR_MAX_HEADER_BYTES", 8192),
  connectionsCheckingInterval: envInt("SHADE_TREE_REGISTRAR_CONN_CHECK_MS", 1000),
});
export const MAX_BODY = 4096;

function send(res, code, obj, extraHeaders = null, contentType = "application/json") {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": contentType, "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { reject(new Error("body too large")); req.pause(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Which rails this offer serves (T-FEAT-9). An offer built outside makeOffer (tests) defaults to both.
export const offerProtocols = (offer) => (Array.isArray(offer.protocols) && offer.protocols.length ? offer.protocols : ["x402", "mpp"]);
export const offerServes = (offer, protocol) => offerProtocols(offer).includes(protocol);

// The public description of the offer (402 body + /health `pay` block + the bootnode's advert).
export function offerSummary(offer) {
  return {
    protocols: offerProtocols(offer),
    chain: caip2(offer.chainId),
    chainId: offer.chainId,
    asset: offer.asset,
    assetName: offer.assetName,
    assetVersion: offer.assetVersion,
    decimals: offer.decimals,
    payTo: offer.payTo,
    tiers: offer.tiers,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    routes: { quote: "/pay/quote?limit=<tier>", pay: "POST /pay {commitment, limit} + PAYMENT-SIGNATURE | Authorization: Payment", status: "/pay/status/<nonce>" },
  };
}

// `limits` overrides HTTP_LIMITS (tests); `now` injectable.
export function makeServer(engine, { offer, store, set, limits = {}, now = () => Date.now() } = {}) {
  const lim = { ...HTTP_LIMITS, ...limits };
  if (lim.requestTimeout > 0 && lim.headersTimeout > lim.requestTimeout) lim.headersTimeout = lim.requestTimeout;
  const payBucket = makeAnnounceBucket({ rate: envInt("SHADE_TREE_REGISTRAR_PAY_RATE", 1), burst: envInt("SHADE_TREE_REGISTRAR_PAY_BURST", 10), now: () => Math.floor(now() / 1000) });
  const quoteBucket = makeAnnounceBucket({ rate: envInt("SHADE_TREE_REGISTRAR_QUOTE_RATE", 20), burst: envInt("SHADE_TREE_REGISTRAR_QUOTE_BURST", 100), now: () => Math.floor(now() / 1000) });
  metrics.gauge("shade_tree_registrar_orders", "Orders in the registrar store.").setCollect(() => store.size());
  metrics.gauge("shade_tree_registrar_inflight", "Settlements currently in flight.").setCollect(() => engine.inflight());

  const x402On = offerServes(offer, "x402"), mppOn = offerServes(offer, "mpp");
  const wantHeader = [x402On ? "PAYMENT-SIGNATURE" : null, mppOn ? "Authorization: Payment" : null].filter(Boolean).join(" or ");
  // Every 402 carries the challenge(s) of the ENABLED rails for the tiers in `limits`
  // (SHADE_TREE_PAY_PROTOCOLS, T-FEAT-9: a disabled rail gets NO challenge), plus the JSON offer as body.
  function send402(res, limitsToOffer, { digest = "", error = null, problem = null, x402Response = null, route = "quote" } = {}) {
    M.quotes.inc({ route });
    const headers = {};
    if (x402On) {
      const pr = x402PaymentRequired(offer, limitsToOffer, { error: error || `${wantHeader} header is required` });
      headers["payment-required"] = encodeX402Header(pr);
    }
    if (mppOn) {
      // One MPP challenge per tier (intent negotiation via multiple challenges is spec'd; we list
      // each as its own header line so parsers that split on the first comma still work).
      headers["www-authenticate"] = limitsToOffer.map((l) => mppChallenge(offer, l, store.mppSecret(), { digest, nowMs: now() }).header);
    }
    if (x402Response && x402On) headers["payment-response"] = encodeX402Header(x402Response);
    const body = { ...(problem || mppProblem("payment-required", `pay for a membership leaf: sign the EIP-3009 authorization from one of the challenges and POST /pay {commitment, limit} (rails: ${offerProtocols(offer).join(", ")})`)), pay: { ...offerSummary(offer), offered: limitsToOffer } };
    return send(res, 402, body, headers, "application/problem+json");
  }

  const server = http.createServer({
    headersTimeout: lim.headersTimeout, requestTimeout: lim.requestTimeout, keepAliveTimeout: lim.keepAliveTimeout,
    maxHeaderSize: lim.maxHeaderSize, connectionsCheckingInterval: lim.connectionsCheckingInterval,
  }, async (req, res) => {
    try {
      const url = new URL(req.url, "http://registrar");
      if (req.method === "GET" && url.pathname === "/health") {
        let leafCount = null, root = null;
        try { leafCount = Number(await set.leafCount()); root = (await set.currentRoot()).toString(); } catch { /* chain unreachable: still answer */ }
        return send(res, 200, { ok: true, pay: offerSummary(offer), paidAccessSet: set.target, leafCount, root, orders: store.size() });
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        const body = metrics.render();
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(body) });
        return res.end(body);
      }
      if (req.method === "GET" && url.pathname === "/pay/quote") {
        if (!quoteBucket.take()) return send(res, 429, { ok: false, err: "rate-limited" }, { "retry-after": String(quoteBucket.retryAfterSec()) });
        const q = url.searchParams.get("limit");
        const limits = q == null || q === "" ? tierList(offer) : (priceOf(offer, q) ? [Number(q)] : null);
        if (!limits) return send(res, 400, { ok: false, err: "unknown-limit", tiers: tierList(offer) });
        return send402(res, limits, { route: "quote" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/pay/status/")) {
        const nonce = decodeURIComponent(url.pathname.slice("/pay/status/".length));
        if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return send(res, 400, { ok: false, err: "bad-nonce" });
        const orders = store.byNonce(nonce).map(publicOrder);
        return orders.length ? send(res, 200, { ok: true, orders }) : send(res, 404, { ok: false, err: "not-found" });
      }
      if (req.method === "POST" && url.pathname === "/pay") {
        let raw;
        try { raw = await readBody(req); } catch { res.once("finish", () => { try { req.socket.destroy(); } catch {} }); return send(res, 413, { ok: false, err: "body too large" }); }
        let body = null;
        if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { ok: false, err: "bad-json" }); } }
        if (body !== null && (typeof body !== "object" || Array.isArray(body))) return send(res, 400, { ok: false, err: "bad-json" });
        const x402Header = req.headers["payment-signature"];
        const authHeader = req.headers["authorization"];
        const bodyLimit = body && body.limit != null ? String(body.limit) : null;
        const limits = bodyLimit == null ? tierList(offer) : (priceOf(offer, bodyLimit) ? [Number(bodyLimit)] : null);
        if (!limits) return send(res, 400, { ok: false, err: "unknown-limit", tiers: tierList(offer) });
        // No payment header: this is the challenge step of a bodied request -> 402 with the MPP
        // challenge bound to the body digest (RFC 9530) and the x402 requirements.
        if (!x402Header && !authHeader) return send402(res, limits, { digest: raw.length ? contentDigest(raw) : "", route: "pay" });
        if (!payBucket.take()) return send(res, 429, { ok: false, err: "rate-limited" }, { "retry-after": String(payBucket.retryAfterSec()) });
        if (!body || !isCommitment(body.commitment) || bodyLimit == null) return send(res, 400, { ok: false, err: "bad-body", want: "{commitment: <decimal field element>, limit: <tier>}" });
        // A payload for a rail this provider does not serve (SHADE_TREE_PAY_PROTOCOLS, T-FEAT-9) is refused
        // up front with the enabled list -- never parsed, never a challenge for the disabled rail.
        if (x402Header && !x402On) { M.payments.inc({ protocol: "x402", result: "rejected", reason: "protocol-disabled" }); return send(res, 400, { ok: false, err: "protocol-disabled", protocol: "x402", protocols: offerProtocols(offer), detail: `this registrar does not serve x402 (SHADE_TREE_PAY_PROTOCOLS=${offerProtocols(offer).join(",")}); use ${offerProtocols(offer).join(" or ")}` }); }
        if (!x402Header && authHeader && !mppOn) { M.payments.inc({ protocol: "mpp", result: "rejected", reason: "protocol-disabled" }); return send(res, 400, { ok: false, err: "protocol-disabled", protocol: "mpp", protocols: offerProtocols(offer), detail: `this registrar does not serve MPP (SHADE_TREE_PAY_PROTOCOLS=${offerProtocols(offer).join(",")}); use ${offerProtocols(offer).join(" or ")}` }); }

        // ---- x402 -----------------------------------------------------------------
        if (x402Header) {
          if (Array.isArray(x402Header) || x402Header.length > 8192) return send(res, 400, { ok: false, err: "invalid_payment_payload" });
          const parsed = parseX402Payment(x402Header, offer);
          const settlementFail = (reason, payer) => x402Settlement({ success: false, errorReason: reason, network: caip2(offer.chainId), payer });
          if (!parsed.ok) { M.payments.inc({ protocol: "x402", result: "rejected", reason: parsed.reason }); return send402(res, limits, { route: "pay", error: parsed.reason, x402Response: settlementFail(parsed.reason) }); }
          if (parsed.limit !== Number(bodyLimit)) { M.payments.inc({ protocol: "x402", result: "rejected", reason: "limit-mismatch" }); return send402(res, limits, { route: "pay", error: "limit-mismatch", x402Response: settlementFail("invalid_exact_evm_payload_authorization_value_mismatch", parsed.authorization.from) }); }
          const r = await engine.verifyAndSettle({ protocol: "x402", limit: parsed.limit, commitment: body.commitment, authorization: parsed.authorization, signature: parsed.signature });
          if (!r.ok) {
            M.payments.inc({ protocol: "x402", result: r.status >= 500 ? "failed" : "rejected", reason: r.reason });
            if (r.status === 402) return send402(res, limits, { route: "pay", error: `${r.reason}: ${r.detail}`, x402Response: settlementFail(r.reason, parsed.authorization.from) });
            return send(res, r.status, { ok: false, err: r.reason, detail: r.detail }, r.status === 503 ? { "retry-after": "5" } : null);
          }
          M.payments.inc({ protocol: "x402", result: r.replayed ? "replayed" : "inserted" });
          const settlement = x402Settlement({ success: true, transaction: r.order.settleTx || "", network: caip2(offer.chainId), payer: r.order.from });
          return send(res, 200, { ok: true, protocol: "x402", ...publicOrder(r.order), replayed: r.replayed }, { "payment-response": encodeX402Header(settlement), "cache-control": "private, no-store" });
        }
        // ---- MPP ------------------------------------------------------------------
        if (Array.isArray(authHeader) || authHeader.length > 8192) return send402(res, limits, { route: "pay", problem: mppProblem("malformed-credential", "one Authorization header of at most 8 KiB") });
        const parsed = parseMppCredential(authHeader, store.mppSecret(), offer, { bodyDigest: contentDigest(raw), nowMs: now() });
        if (!parsed.ok) {
          M.payments.inc({ protocol: "mpp", result: "rejected", reason: parsed.reason });
          const status = parsed.reason === "method-unsupported" ? 400 : 402;
          if (status !== 402) return send(res, status, mppProblem(parsed.reason, parsed.detail, status), null, "application/problem+json");
          return send402(res, limits, { route: "pay", digest: contentDigest(raw), problem: mppProblem(parsed.reason, parsed.detail) });
        }
        if (parsed.limit !== Number(bodyLimit)) { M.payments.inc({ protocol: "mpp", result: "rejected", reason: "limit-mismatch" }); return send402(res, limits, { route: "pay", digest: contentDigest(raw), problem: mppProblem("verification-failed", "body.limit does not match the challenge's tier") }); }
        const r = await engine.verifyAndSettle({ protocol: "mpp", limit: parsed.limit, commitment: body.commitment, authorization: parsed.authorization, signature: parsed.signature, meta: { challengeId: parsed.challenge.id } });
        if (!r.ok) {
          M.payments.inc({ protocol: "mpp", result: r.status >= 500 ? "failed" : "rejected", reason: r.reason });
          const code = r.reason === "expired" ? "payment-expired" : r.reason === "insufficient_funds" ? "payment-insufficient" : "verification-failed";
          if (r.status === 402) return send402(res, limits, { route: "pay", digest: contentDigest(raw), problem: mppProblem(code, `${r.reason}: ${r.detail}`) });
          return send(res, r.status, { ...mppProblem(code, `${r.reason}: ${r.detail}`, r.status), err: r.reason }, r.status === 503 ? { "retry-after": "5" } : null, "application/problem+json");
        }
        M.payments.inc({ protocol: "mpp", result: r.replayed ? "replayed" : "inserted" });
        const { header } = mppReceipt({ challengeId: parsed.challenge.id, txHash: r.order.settleTx || "", chainId: offer.chainId, nowMs: now() });
        return send(res, 200, { ok: true, protocol: "mpp", ...publicOrder(r.order), replayed: r.replayed }, { "payment-receipt": header, "cache-control": "private, no-store" });
      }
      return send(res, 404, { ok: false, err: "no-route" });
    } catch (e) {
      log.error("registrar: request failed", { err: e.message });
      return send(res, 500, { ok: false, err: "registrar-error" });
    }
  });
  server.limits = lim;
  return server;
}
// What a buyer (or anyone) may learn about an order: chain-public facts only.
function publicOrder(o) {
  return { state: o.state, asset: o.asset, payer: o.from, nonce: o.nonce, commitment: o.commitment, limit: o.limit, settleTx: o.settleTx || null, insertTx: o.insertTx || null, leafIndex: o.leafIndex ?? null, root: o.root || null };
}

// ---- main ---------------------------------------------------------------------------------
async function main() {
  const key = process.env.SHADE_TREE_REGISTRAR_KEY;
  if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) { console.error("SHADE_TREE_REGISTRAR_KEY (operator hot key, 32-byte hex) is required"); process.exit(1); }
  const rpcUrl = process.env.SHADE_TREE_RPC_URL || networkDefault("SHADE_TREE_RPC_URL");
  if (!rpcUrl) { console.error("SHADE_TREE_RPC_URL is required (or SHADE_TREE_NETWORK with a contracts.json rpcUrl)"); process.exit(1); }
  const setAddr = process.env.SHADE_TREE_PAID_ACCESS_CONTRACT || networkDefault("SHADE_TREE_PAID_ACCESS_CONTRACT");
  if (!isAddress(setAddr || "")) { console.error("SHADE_TREE_PAID_ACCESS_CONTRACT (PaidAccessSet address) is required"); process.exit(1); }
  const offer = makeOffer(process.env);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  if (!offer.payTo) offer.payTo = wallet.address;
  const token = new ethers.Contract(offer.asset, EIP3009_ABI, wallet);
  const set = new ethers.Contract(setAddr, PAID_ACCESS_SET_ABI, wallet);
  await probeAsset(offer, token, provider);
  // The set must accept every tier we sell (a sold tier the contract refuses would take money for
  // an insert that reverts; the pre-settle limitOf check can't catch a table mismatch).
  try {
    const allowed = (await set.allowedLimits()).map((n) => Number(n));
    const missing = tierList(offer).filter((l) => !allowed.includes(l));
    if (missing.length) { console.error(`SHADE_TREE_PAY_PRICES sells tiers ${missing.join(",")} that PaidAccessSet ${setAddr} does not admit (allowedLimits=${allowed.join(",")})`); process.exit(1); }
  } catch (e) { console.error(`PaidAccessSet ${setAddr} unreachable or has no allowedLimits(): ${e.shortMessage || e.message}`); process.exit(1); }
  const storePath = process.env.SHADE_TREE_REGISTRAR_STORE || join(HERE, "registrar-state.local.json");
  const store = makeStore(storePath);
  const engine = makeEngine({ offer, token, set, wallet, provider, store, confirmations: envInt("SHADE_TREE_PAY_CONFIRMATIONS", 1), maxInflight: envInt("SHADE_TREE_REGISTRAR_MAX_INFLIGHT", 8) });
  const rec = await engine.recover();
  if (rec.resumed || rec.failed) log.info("registrar: recovery", rec);

  const server = makeServer(engine, { offer, store, set });
  const openSockets = new Set();
  server.on("connection", (s) => { openSockets.add(s); s.on("close", () => openSockets.delete(s)); });
  server.listen(offer.port, "127.0.0.1", () => {
    log.info(`registrar up on 127.0.0.1:${offer.port}`, { operator: wallet.address, payTo: offer.payTo, asset: offer.asset, assetName: offer.assetName, chain: caip2(offer.chainId), tiers: offer.tiers, paidAccessSet: setAddr, store: storePath });
    log.info(`endpoints: GET /pay/quote?limit=N  POST /pay  GET /pay/status/<nonce>  GET /health  GET /metrics  (protocols: ${offer.protocols.map((p) => (p === "x402" ? "x402 v2" : "MPP evm/charge type=authorization")).join(" + ")}; SHADE_TREE_PAY_PROTOCOLS=${offer.protocols.join(",")})`);
    log.info("endpoint hardening", { ...server.limits, maxBody: MAX_BODY });
  });
  const shutdown = makeGracefulShutdown(server, { openSockets, timeoutMs: Number(process.env.SHADE_TREE_SHUTDOWN_TIMEOUT_MS || 10000), label: "registrar" });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("registrar failed:", e.shortMessage || e.message); process.exit(1); });
}
