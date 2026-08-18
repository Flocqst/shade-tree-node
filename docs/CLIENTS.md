# Client modes: shim vs. library (and a planned no-tooling path)

The gateway needs a **fresh RLN proof per request** — that is what makes the nullifier,
the per-epoch rate cap, and the slashing work, so *something* client-side must mint it. What
varies is where that "something" lives. There are two shipped shapes and one planned.

## The irreducible part

Every request carries one Groth16 proof bound to a fresh `(epoch, slot)` nullifier. You
cannot set it once and reuse it: reusing a nullifier with a different signal is exactly the
over-spend the gateway slashes on. So any client — proxy, library, or CLI — regenerates the
proof per request. Both shapes below share the same hardened core (`client/rgoe-client.mjs`):
one proof per logical request, deterministic across gateway failover (same signal → same
share), plus slot + gateway rotation.

## Option A — library (`RgoeClient`): no proxy process

Use this when the client is **your own code** (e.g. an agent doing many queries). No local
proxy; just call a function. `client/rgoe-client.mjs`:

```js
import { RgoeClient, cleanUp } from "./client/rgoe-client.mjs";

const rgoe = new RgoeClient({
  secret,                                   // enrolled member secret (or RGOE_SECRET)
  directory: "…/network/sepolia/directory-bootnode.json",   // a signed directory (the live fleet's cold-path export)
  dirSigner: "d79f78c3…3a73",               // pins the directory signer (network/sepolia/bootnode.json)
  torPort: 9260,                            // client Tor SOCKS
  // or: onion: "…"  to pin a single gateway instead of fleet rotation
});

const res = await rgoe.fetch("https://api.ipify.org");   // { status, headers, body }
// lower level — bring your own TLS/protocol over the raw tunnel:
const sock = await rgoe.connect("api.ipify.org:443");    // duplex, tunneled via a gateway
// sock.rgoe = { onion, slot, nullifier }

cleanUp();  // terminate snarkjs workers so the process can exit
```

- `fetch(url, { method, headers, body })` → HTTPS over the tunnel; **TLS is end-to-end** to
  the target (the gateway relays ciphertext only). `https://` only (the gateway egresses :443).
- `connect("host:443")` → the raw duplex tunnel, if you want your own protocol.
- Each call rotates gateway + slot and reuses one proof across failover.

Simplest form against the live fleet: run with `RGOE_NETWORK=sepolia` in the environment and
construct `new RgoeClient({ secret, torPort })`; the SDK honours the record too
(`client/selection.mjs` applies it before reading env), so the bootnode onion + signer come
from `network/sepolia/bootnode.json` and the client discovers the fleet live over Tor.

Runnable example: `examples/agent-fetch.mjs`. Verified live end to end (returns rotating
fleet gateway IPs, laptop IP absent from gateway logs).

## Leaf source + admission filtering + `--max-anon` (T-FEAT-9, both options)

Your leaf lives in ONE set — `members.json` (**invited**), a `StakedReputationSet` (**staked**), or
the `PaidAccessSet` (**paid**) — and each gateway advertises WHICH of those it admits as signed caps
(`admits`, in the anonymity order invited > staked > paid; `docs/adr/0008`). The client:

- discovers your **leaf source** (`makeLeafSourceLoader`: members.json first, then the staked sets,
  then the paid set — `RGOE_LEAF_SOURCE=invited|staked|paid` / `{ leafSource }` / `--leaf-source`
  pins the set if your leaf is in several), and
- routes ONLY to gateways whose `admits` include it (`selectCandidates(req, { leafSource, maxAnon })`
  → `filterByAdmission`). A gateway that advertises no policy is assumed to admit any path during
  the rollout (logged once); if NO gateway admits your leaf source the client fails closed:
  `no gateway admits a paid leaf (your leaf source); fleet: abcd..=[invited,staked] efgh..=[invited] …`.
- `--max-anon` / `RGOE_MAX_ANON=1` / `{ maxAnon: true }`: the maximum-anonymity mode. Only gateways
  whose `admits` is EXACTLY `["invited"]` (their whole population is invited; a policy-less gateway
  cannot prove it and is excluded), and the client REFUSES to run with a staked/paid leaf before any
  proof or dial — `--max-anon: your leaf is in the paid set (the buyer address -> operator transfer
  and tier bucket are public); an invited-only gateway would reject it (wrong-group-root)…`. No
  invited-only gateway in the directory: `--max-anon: no invited-only gateway in the directory …
  fleet: …` (on the sepolia demo fleet neither gateway is invited-only, so an invited member with
  `--max-anon` gets exactly this refusal — the correct outcome, `network/sepolia/README.md`).
- A pinned `onion` is honoured as-is (its policy is unknown to the client; a mismatch surfaces as
  the gateway's `wrong-group-root`), except that `--max-anon` still refuses a staked/paid leaf.
- Events: `onEvent({ phase:"select", status:"done", leafSource, maxAnon, candidates:[{onion, admits}] })`
  once selection settles (the shim logs it as `SELECT <target> leaf=paid candidates=…`); `tunnel.rgoe.leafSource`.

```bash
RGOE_NETWORK=sepolia rgoe client --secret <hex> --max-anon            # invited-only gateways, or a precise refusal
RGOE_NETWORK=sepolia rgoe client --secret <hex> --leaf-source paid --limit 32   # prove from the paid set; paid-admitting gateways only
```

## Option B — shim (`client/shim.mjs`): a local proxy for unmodified tools

Use this when the client is a **stock tool** you can't change (browser, curl, any
`http_proxy`-aware app). The shim is now a thin HTTP-CONNECT front-end over the same
`RgoeClient`:

```bash
RGOE_SECRET=0x… RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node client/shim.mjs   # = `rgoe client --network sepolia`
# then: curl -x http://127.0.0.1:8888 https://api.ipify.org
```

`RGOE_NETWORK=sepolia` is the default way in since the 2026-08-17 go-live: it fills the
discovery inputs (the live bootnode onion + pinned signer, and the contract addresses) from the
committed record `network/sepolia/bootnode.json` (`network/README.md`,
`docs/GO-LIVE-LOG-2026-08-17.md`), and the shim discovers the fleet through the bootnode over
Tor. Add `RGOE_LIMIT=32` (`--limit 32`) if your leaf is a tier-32 one; a bought leaf is found in
the paid set automatically (`docs/PAYMENTS.md`). Explicit env still wins over the record.

Env, if you want to set the pieces yourself: `RGOE_SECRET`, then one discovery source:
`RGOE_BOOTNODE_ONION`+`RGOE_DIR_SIGNER` (live fleet), `RGOE_DIRECTORY`+`RGOE_DIR_SIGNER` (a
static signed directory, e.g. the cold path `network/sepolia/directory-bootnode.json`), or
`RGOE_ONION` (pin one gateway); plus `RGOE_TOR_HOST`/`RGOE_TOR_PORT`. **Gotcha:** in
directory mode you must set `RGOE_DIR_SIGNER` or the shim silently falls back to a stale local
`tor/hs/hostname`.

## Planned — stock HTTP CONNECT + `Proxy-Authorization` (no custom client at all)

Teach the gateway to also speak a standard HTTP CONNECT proxy and read the proof from a
`Proxy-Authorization: RLN <base64>` header, so plain `curl -x http://<onion>:80` works with
no shim and no library — you just need a one-shot `rgoe-prove <target>` to mint the header:

```bash
curl -x http://<onion>:80 \
  --proxy-header "Proxy-Authorization: RLN $(rgoe-prove example.com:443)" \
  https://example.com
```

This removes the client software **for scripted one-shot requests**. It does **not** serve
multi-request clients (a browser/agent that sets the proxy once) safely: `Proxy-Authorization`
is static, but the proof must be fresh per request — reusing it across targets either breaks
the rate cap or self-slashes. So B is a great gateway interface + a clean one-shot path, but
multi-request clients still need A (library) or the shim. Not built yet.

Note: the proof (~400+ bytes) does **not** fit SOCKS5 username/password (RFC 1929 caps each
at 255 bytes), which is why B rides on HTTP CONNECT, not SOCKS auth.
