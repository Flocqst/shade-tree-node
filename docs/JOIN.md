# you've been handed a key

Someone added you to a private reputation set, or you are about to buy your way into one. That
key lets you browse out through a clean IP on a server the operator runs, while proving you
belong to the set and never telling the server who you are. No login, no account, and none of
your own IP ever reaches it.

There are two pages here. **The live fleet** (first) is what you want today: it went live on
2026-08-17 (`docs/GO-LIVE-LOG-2026-08-17.md`), two gateways behind a bootnode, discovery record
committed as `network/sepolia/bootnode.json`. **The June PoC bundle** (further down, marked
legacy) is kept for people who still hold a PoC secret; read the note there before trying it.

## the live fleet: what you need

- node 18 or newer, then `npm install` in this repo (`npm link` if you want `rgoe` on PATH,
  otherwise `node bin/rgoe.mjs` everywhere)
- tor installed locally (`brew install tor`, or `apt install tor`); `bash scripts/start-tor-client.sh`
  starts one on SOCKS 9260, or use a system tor with `RGOE_TOR_PORT=9050`
- one of: your secret (one `export RGOE_SECRET=...` line, sent to you privately), a wallet to buy
  with, or Sepolia ETH to stake with

## the live fleet: run it

```bash
npm install
bash scripts/start-tor-client.sh                                  # laptop tor, SOCKS 9260
RGOE_SECRET=<your-secret> RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 rgoe client
curl -x http://127.0.0.1:8888 https://api.ipify.org               # a fleet gateway's clean IP
```

`RGOE_NETWORK=sepolia` fills the bootnode onion, its pinned signer and the contract addresses
from the committed record (`network/README.md`); the client fetches the live signed directory
over Tor and rotates across every gateway it lists (two today, New York and San Francisco). The
gate is fail-closed: without a valid membership proof every connection is dropped, and the
address of the fleet buys nothing on its own. If you were handed a secret for the committed
member set, this is all you do. Full member guide: [`docs/post/JOIN.md`](post/JOIN.md) /
[`docs/QUICKSTART.md`](QUICKSTART.md).

## the live fleet: use it

Point anything at the proxy on port 8888:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org            # shows the gateway's clean IP
curl -x http://127.0.0.1:8888 "https://www.google.com/search?q=zk+proofs"
```

Your traffic goes: your laptop, into Tor, to a rendezvous point, to the gateway's hidden service. The gateway checks your proof and then makes the request from its own clean IP. It never sees your IP. Google never sees Tor. Your search stays inside TLS the whole way, so the gateway sees only `www.google.com:443`, never the query.

## buy access (no key handed to you)

The operator also sells access, so you can buy your own leaf. You need a wallet that holds the
fleet's settle asset on its chain (Sepolia today, a test EIP-3009 token; the fleet's `/health`
on the bootnode says which asset and what the tiers cost) but **no ETH, no gas**: you only sign,
the operator submits and pays. Then:

```bash
rgoe enroll                                     # your secret + your commitment, locally; keep the secret
rgoe pay --network sepolia --limit 8 \
  --key-file buyer.key --secret-file ./.secret  # x402 (default) or --protocol mpp
# -> paid (x402): settleTx 0x…  insertTx 0x…  leafIndex N  root …
RGOE_NETWORK=sepolia rgoe client --secret <your secret> --limit 8   # egress as usual (--limit 32 if you bought tier 32:
                                                                    # the client finds your leaf in the PAID set and proves against it)
```

`--dry-run` shows the operator's 402 challenge and the exact authorization you would sign, and
signs nothing. Tier 32 = a bigger per-epoch budget (`--limit 32`, priced higher). Both rails
were bought and used live on 2026-08-17.

Read this before you pay: **the payment is public.** On chain, your wallet address pays the
operator's address the tier's price, and the operator inserts your leaf right after. Nobody can
tell which of your later requests are yours (the gateway sees a zero-knowledge proof, not your
leaf, and every request has a fresh nullifier) but "this address bought access from this
operator" is visible to anyone. If that matters to you, pay from a **fresh address** funded
through a large shared pool (Railgun, Privacy Pools, a CEX withdrawal; your call, the protocol
does not pick one). `docs/PAYMENTS.md` has the whole leak ledger.

## stake instead (Sepolia ETH, refundable bond)

```bash
rgoe enroll --limit 8                                            # or --limit 32
rgoe register-member <commitment> --limit 8 --network sepolia   # posts bondFor(8) into StakedReputationSet
RGOE_NETWORK=sepolia rgoe client --secret <your secret> --limit 8
```

Over-spend your tier's budget in one epoch and the gateway reconstructs your secret and slashes
the bond on chain; that is the deal (`docs/ONCHAIN.md`).

## what your key actually is

It is a bearer credential. Whoever holds it can browse as a member until the set is rotated (or the leaf is slashed), so keep it to yourself. It is not tied to your name anywhere, but it is yours.

You get your own rate budget per epoch (your tier) and a tag (a nullifier) that lets the gateway count your requests without knowing they are yours. Across epochs that tag changes, so your requests do not link over time.

## stop it

Ctrl-C the client; `pkill -f torrc.client` if you started the laptop tor with `start-tor-client.sh`.

Want to see exactly what happens to your bytes? Open `docs/walkthrough.html` in a browser and step through it (recorded on the June PoC; the request path is the same).

---

# legacy: the June 2026 PoC bundle

> **Read first.** This is the original single-gateway PoC path (`scripts/join.sh`, a pinned
> onion, the committed `group/members.json`). **It does not work since 2026-08-17.** The PoC box
> was reused for the live fleet's bootnode + gateway-1 (`docs/GO-LIVE-LOG-2026-08-17.md`,
> Phase 1.1): the PoC gateway process was killed at go-live and, for a few hours, the PoC onion
> mapped to the new gateway on the same box; then the "Box-1 tidy" stopped the PoC tor that
> published that onion, so the PoC onion is dark (the PoC checkout and its HS keys were left in
> place, not deleted). Your PoC secret is still good if its leaf is in the committed
> `group/members.json` (the fleet admits that set): use the live-fleet path above. Some early
> PoC secrets were never in the committed set; if yours is refused, ask the operator for a new
> one, or buy/stake a leaf. `scripts/join.sh` and `scripts/run-client.sh` (code, unchanged)
> still default to the PoC onion; that default is not the fleet, override with
> `RGOE_NETWORK=sepolia rgoe client` instead. The rest of this page is kept as a record.

## what you need (legacy)

- node 18 or newer
- tor installed locally (`brew install tor`, or `apt install tor`)
- the bundle you were sent (`rgoe-gateway-deploy.tgz`), unpacked
- your secret: one `export RGOE_SECRET=...` line, sent to you privately

## run it (legacy)

```bash
cd reputation-gated-onion-egress
npm install
bash scripts/join.sh <your-secret>
```

The gateway address is already built in, so you only need your secret. For the
record, the gateway onion is:

```
ezguggje6sbldhw4pl5nudwg2mrwkb5zzyu3a26qc4eka2ur24bv3eqd.onion
```

(If the operator points you at a different box, pass it ahead of your secret:
`bash scripts/join.sh <other-gateway>.onion <your-secret>`.) Knowing the address
buys nothing on its own. The gate is fail-closed, so without a valid membership
proof every connection is dropped. That command starts a local Tor and a small
proxy, then runs a check that asserts your egress really comes out of the PoC
gateway's clearnet IP: `join.sh` sets `RGOE_EXPECT_IP` to that IP (`204.48.28.220`)
and `verify.sh` compares it to what `api.ipify.org` saw. The IP is printed here
for exactly that reason — it is the receipt you compare against, not something
you connect to. When it prints `PASS` next to that IP, you are out. (Different
gateway? Set `RGOE_EXPECT_IP` to its IP, or unset it to skip the assertion.)

## use it (legacy)

Point anything at the proxy on port 8888:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org            # shows the gateway's clean IP
curl -x http://127.0.0.1:8888 "https://www.google.com/search?q=zk+proofs"
```

Your traffic goes: your laptop, into Tor, to a rendezvous point, to the server's hidden service. The server checks your proof and then makes the request from its own clean IP. The server never sees your IP. Google never sees Tor. Your search stays inside TLS the whole way, so the server sees only `www.google.com:443`, never the query.

## stop it (legacy)

```bash
bash scripts/stop.sh
pkill -f torrc.client
```
