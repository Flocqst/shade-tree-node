# you've been handed a key

> **Which path is this?** This is the original single-gateway PoC path (`scripts/join.sh`,
> a pinned onion, the committed `group/members.json`). **The live fleet path is shorter and is
> what you want today** — the bootnode fleet went live on 2026-08-17 (`docs/GO-LIVE-LOG-2026-08-17.md`),
> and its discovery record is committed as `network/sepolia/bootnode.json`, so joining is:
>
> ```bash
> npm install
> bash scripts/start-tor-client.sh                    # laptop tor, SOCKS 9260 (or use system tor: RGOE_TOR_PORT=9050)
> RGOE_SECRET=<your-secret> RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node bin/rgoe.mjs client
> curl -x http://127.0.0.1:8888 https://api.ipify.org         # a fleet gateway's clean IP
> ```
>
> `RGOE_NETWORK=sepolia` fills the bootnode onion + pinned signer from the record
> (`network/README.md`); the client fetches the live signed directory over Tor and rotates
> across every gateway it lists. Full member guide: [`docs/post/JOIN.md`](post/JOIN.md) /
> [`docs/QUICKSTART.md`](QUICKSTART.md). Use the rest of this page only if the operator
> handed you the PoC bundle and a secret for the PoC set.

> **Which path is this?** This is the original single-gateway PoC path (`scripts/join.sh`,
> a pinned onion, the committed `group/members.json`). The current fleet path — live
> discovery through a bootnode, on-chain admission, the `rgoe` CLI — is
> [`docs/post/JOIN.md`](post/JOIN.md) / [`docs/QUICKSTART.md`](QUICKSTART.md). Use this page
> only if the operator handed you the PoC bundle and a secret for the PoC set.

> **Buy access** (no key handed to you, no stake): the fleet also admits PAID members — you pay the
> operator over HTTP 402 rails and your leaf is inserted into the paid set; then
> `RGOE_NETWORK=sepolia rgoe client --limit <your tier>` finds it there and proves against it. The
> flow, the rails and the anonymity caveats: [`docs/PAYMENTS.md`](PAYMENTS.md).

Someone added you to a private reputation set. That key lets you browse out through a clean IP on a server in New York, while proving you belong to the set and never telling the server who you are. No login, no account, and none of your own IP ever reaches it.

Here is the whole thing.

## what you need

- node 18 or newer
- tor installed locally (`brew install tor`, or `apt install tor`)
- the bundle you were sent (`rgoe-gateway-deploy.tgz`), unpacked
- your secret: one `export RGOE_SECRET=...` line, sent to you privately

## run it

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

## use it

Point anything at the proxy on port 8888:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org            # shows the gateway's clean IP
curl -x http://127.0.0.1:8888 "https://www.google.com/search?q=zk+proofs"
```

Your traffic goes: your laptop, into Tor, to a rendezvous point, to the server's hidden service. The server checks your proof and then makes the request from its own clean IP. The server never sees your IP. Google never sees Tor. Your search stays inside TLS the whole way, so the server sees only `www.google.com:443`, never the query.

## what your key actually is

It is a bearer credential. Whoever holds it can browse as a member until the set is rotated, so keep it to yourself. It is not tied to your name anywhere, but it is yours.

You get your own rate budget per day and a tag (a nullifier) that lets the server count your requests without knowing they are yours. Across days that tag changes, so your requests do not link over time.

## stop it

```bash
bash scripts/stop.sh
pkill -f torrc.client
```

Want to see exactly what happens to your bytes? Open `docs/walkthrough.html` in a browser and step through it. Everything in there is the real running system.
