# Status update (2026-06-07)

Where the reputation-gated onion egress stands: live and verified. This is the
short version of what works, what is missing, and how to actually use it from your
own machine. For the full writeup see the [README](../README.md) and
[DEPLOY.md](DEPLOY.md); for the request lifecycle open
[walkthrough.html](walkthrough.html).

## Architecture status

### Working today

- **v3 onion-service egress, gated by a zero-knowledge proof of membership.**
  Semaphore v4 group membership with epoch-scoped nullifiers (RLN-style anonymous
  rate limiting). Prove you are in the set, egress; everyone else is dropped.
- **Live on a server.** Deployed to a DigitalOcean droplet (Ubuntu 24.04, NYC).
  Tor from the official repo with `pow: yes`, so the onion proof-of-work DoS
  defense is on. The gateway and its tor run as durable `systemd` services that
  survive reboot.
- **The gateway never learns the client IP.** Reached by Tor rendezvous, no exit
  node. Verified on the box: the gateway binds loopback, sees `127.0.0.1` for every
  request, and the client IP appears in zero logs.
- **Anonymous per-member rate limiting.** The nullifier lets the gateway count a
  member's requests without knowing who they are.
- **Forged sets and bad proofs are rejected** with precise reasons (trusted-root
  check, proof verification, epoch check).
- **Two-machine deploy and friend onboarding.** `run-gateway.sh` (server),
  `run-client.sh` (laptop), `join.sh` (one-command for a friend), plus
  `verify.sh` / `gateway-status.sh` receipts on both ends.

### Missing, in priority order

- **Self-generated identities. This is the one that matters.** The PoC enroll tool
  hands the operator each member's secret, so anonymity against the operator is not
  real yet. Members must generate their own identity client-side and submit only a
  commitment. Until then, you trust the operator.
- **Unlinkable rate limiting.** Within an epoch a member's requests share one
  nullifier and are linkable to each other. Decouple the rate window from the
  linkability window by hiding the nullifier scope and range-proving it. Scoped in
  the README's Future upgrades.
- **Replay within an epoch is allowed by design.** The cached proof is re-sent each
  request. Production RLN binds a fresh share per message and slashes over-rate
  secrets.
- **Real admission policy.** Enrollment is still a local command. Production needs a
  ceremony: stake, invite, accrued standing, or proof-of-personhood.
- **Scale past one clean IP.** A single egress IP at volume still looks botlike.
  Scaling is a fleet-of-clean-IPs problem, out of scope for the PoC.
- **Operational hardening.** Onion-key backup, set-rotation tooling, and monitoring
  are not built yet.

## Deployment and test results

Deployed live and verified end to end, with both the client and the gateway log
agreeing to the request. A laptop request egressed from the droplet's clean IP and
the gateway logged the matching `PASS`. The path crosses six real Tor relays (a
3-hop client half and a 3-hop service half that splice at a shared rendezvous
relay), with no exit node anywhere.

Four hypotheses were run as real requests against the live gateway. All confirmed.

| | Hypothesis | Result |
|---|---|---|
| H1 | Distinct members egress independently | 5 members, all admitted, 5 distinct nullifiers |
| H2 | Only a valid proof in our set gets in | no-proof, garbage, forged-group, and non-member all rejected with reasons |
| H3 | A member cannot exceed its budget | budget 4: 4 admitted, then 4 rate-limited, exactly at the cap |
| H4 | Spam cannot ban you or leak egress | 25 junk envelopes all rejected, 0 leaked, a real member admitted immediately after |

Gateway-side tally over the run: **16 PASS, 32 DROP, 7 distinct members**, drops
broken down as 26 invalid-proof, 4 rate-limited, 1 wrong-group-root, 1 no-proof.

**End-to-end latency**, measured from the laptop through the full path to Google and
back (laptop, shim, Tor rendezvous, droplet gateway, Google, return):

| | time |
|---|---|
| direct to Google, no tunnel (baseline) | ~0.15 s |
| through the gated path, warm | ~1.7 to 2.2 s |
| first request after starting the client (one-time setup) | ~7 s |

The warm overhead is the six-hop Tor path plus the gateway's own clearnet fetch.
The one-time cost is circuit and rendezvous setup, paid once per client session, not
per request. This is the price of having no exit node and never exposing the client
IP, and for a search egress it is well within usable.

Headline on abuse: there is nothing to IP-ban, because the gateway never sees a
client IP. The only lever against a member is its per-epoch budget, and that touches
only that one nullifier. Junk is cheap to reject, a failed proof costs a verify and
never an egress.

## How to use the egress from your own computer

You need three things: this repo, the gateway's onion address, and your membership
key. The operator who runs the egress sends you the **onion address** and the
**key** privately. Do not commit or post either one; the key is a bearer credential,
so whoever holds it can egress as that member until the set is rotated.

Prerequisites: Node 18+ and tor installed locally (`brew install tor`, or
`apt install tor`).

```bash
git clone https://github.com/dmarzzz/reputation-gated-onion-egress
cd reputation-gated-onion-egress
npm install
bash scripts/join.sh <gateway-onion>.onion <your-membership-key>
```

`join.sh` starts a local tor and a small proxy, then runs a check. When it prints
`PASS` next to the gateway's IP, you are out. The first run pays a one-time SNARK
artifact download and a ~5s proof; after that it is fast.

Then point any tool at the proxy on port 8888:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org            # shows the gateway's clean IP, not yours
curl -x http://127.0.0.1:8888 "https://www.google.com/search?q=zk+proofs"
```

Your traffic goes through Tor to the gateway, which checks your proof and forwards
from its own clean IP. The gateway never sees your IP; the destination sees the
gateway's IP, never yours or a Tor exit. Stop everything with
`bash scripts/stop.sh && pkill -f torrc.client`. The standalone handout for a new
user is [JOIN.md](JOIN.md).
