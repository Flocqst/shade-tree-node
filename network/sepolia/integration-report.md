# Sepolia integration test — full step-by-step trace

A live end-to-end run of the whole protocol on Ethereum Sepolia + the real gateway:
**two members stake, one uses the gateway normally, one over-spends its rate cap and is
slashed on-chain.** Reproduce with `node scripts/integration-sepolia.mjs`. Result:
**PASS** — honest member's bond intact, over-spender's bond slashed, total wall-clock
~56s (dominated by Sepolia block times).

## Cast of addresses

| Role | Address |
|---|---|
| StakedReputationSet (Sepolia) | [`0x35719A477655A5Aaac7A2aAA11A3167eFa3398EC`](https://sepolia.etherscan.io/address/0x35719A477655A5Aaac7A2aAA11A3167eFa3398EC) |
| Deployer / faucet sink | `0x3261DaF3672Dc8E6063b6960C161Fdc8a6Fc2ff7` |
| Gateway slasher (hot key) | `0xc8606C75E003EDA7C0a377B4708AbEC6EB7a7f02` |
| Alice staking wallet (honest) | `0x2ec9838Ea920Dc33D2771F4d29CBF6e7784929F9` |
| Bob staking wallet (abuser) | `0xaaa30436B0710F918A2Cd63adF3878275b21325c` |
| Alice leaf commitment (Poseidon(secret)) | `53738480558908380555…` |
| Bob leaf commitment (Poseidon(secret)) | `13421454852350268623…` |

Membership is proven in zero knowledge against `group/members.json` (the identity view);
the on-chain leaf is `Poseidon(secret)` (the staking/slash view). Same member, two views
(the documented Plan-B seam; a production RLN circuit unifies them).

## Step by step (timestamps UTC, elapsed from t0)

**Pre-run funding.** Deployer funded from a faucet (tx `0xcd7f…69b1`). Deployer → each
member wallet 0.01 ETH: Alice `0x054bb92dead0f72eec9a38aa5a0ac172939ebafb3c77e4db5ffb17bc6a1a7dd1`,
Bob `0x08df8b77917e47cec5b7b38c947ff1015db38e9f1930cd21d4f94677c27c7987`.

| t | Actor | Event |
|---|---|---|
| +0.2s | setup | Contract `0x3571…98EC`, bond 0.001 ETH, RPC publicnode Sepolia. |
| +0.3s | Alice | `register(Poseidon(secret))` + 0.001 ETH bond submitted |
| **+9.8s** | Alice | **staked**: tx [`0x7451c24c…5c64`](https://sepolia.etherscan.io/tx/0x7451c24c8777cad45dfbb13ebc110f51c115bd6bcce24306a10efdce9fc35c64), block 11274571 |
| +9.8s | Bob | `register(Poseidon(secret))` + 0.001 ETH bond submitted |
| **+19.1s** | Bob | **staked**: tx [`0x62a2eafc…b5f5`](https://sepolia.etherscan.io/tx/0x62a2eafc8b38a490f7112cb7541da3bd88aea7d354fe8f116700bd1cec1ab5f5), block 11274572 |
| +19.2s | chain | `activeCount = 2` — both bonds held on-chain |
| +19.6s | gateway | online on 127.0.0.1:8443, epoch window 120s, slasher wired to Sepolia |
| +20.3s | Alice | req 1: **client forms envelope** — slot 0, nullifier `142456785964…`, built in 710ms |
| +20.5s | gateway | `PASS egress→example.com:443` — **client got ack `{ok:true}`, round-trip 250ms** |
| +20.8s | Alice | req 2: slot 1, nullifier `967298054765…` → `PASS api.ipify.org`, ack ok, **73ms** |
| +21.1s | Alice | req 3: slot 2, nullifier `488878363899…` → `PASS cloudflare.com`, ack ok, **67ms** |
| +21.1s | Alice | 3/3 within the K-slot budget — normal use, no slash |
| +21.4s | Bob | over-spend 1/2: slot 0, first signal, nullifier `165906939032…` → `PASS`, ack ok |
| +21.7s | Bob | over-spend 2/2: **slot 0 again, a second distinct signal → same nullifier = the rate violation** |
| +22.8s | gateway | reconstructs Bob's secret from the two shares → **submits slash** tx `0x70a670…d6b9` |
| **+55.6s** | gateway | **SLASH mined** block 11274574; Bob's over-spend request answered `{ok:false,"over-spend-slashed"}` |
| +56.1s | verify | Alice bond on-chain = **0.001 ETH (intact)** |
| +56.1s | verify | Bob bond on-chain = **0.0 ETH (slashed)** |
| +56.3s | verify | slasher balance +0.001 ETH (received Bob's forfeited bond) |
| +56.3s | **result** | **PASS** |

Slash tx: [`0x70a670093401b4675d3535d9738675928a3949b8858beac4daa20691c831d6b9`](https://sepolia.etherscan.io/tx/0x70a670093401b4675d3535d9738675928a3949b8858beac4daa20691c831d6b9).

## What this proves, exactly

1. **Staking is real and on-chain** — two independent wallets registered Poseidon
   commitments with bonds; `activeCount` went to 2.
2. **The client↔gateway message loop works** — the shim forms a v2 envelope
   (Semaphore membership proof + slot nullifier + RLN share), sends it, and gets a signed
   `{ok:true}` back in tens of milliseconds after the first (warm) request.
3. **Per-request slot rotation** — Alice's three requests each used a distinct slot →
   distinct, mutually-unlinkable nullifier. Honest use never trips the gate.
4. **Over-spend is detected and punished without deanonymizing honest members** — Bob
   reusing a slot revealed a second Shamir share; the gateway reconstructed his secret,
   derived his on-chain leaf, and slashed his bond in a real Sepolia transaction. Only the
   cheater is exposed, and only to his pseudonymous leaf.
5. **The economic outcome settles on-chain** — Bob's bond is gone, Alice's is intact, the
   forfeited bond moved to the slasher.

## Bugs found + fixed during this run (for the next rounds)

- **Client hang (root cause):** `verifyEnvelope` did `.map` on `recentRoots`, which the
  gateway keeps as a `Set` → `TypeError` thrown outside the gateway's try/catch → no reply
  → the client waited forever. The anvil e2e passed an array, so it never surfaced. Fixed:
  `Array.from(recentRoots)`, plus the gateway now replies on any throw and the shim has a
  readLine timeout + a per-request start log so a hang can never be silent again.
- **Slasher couldn't find the contract:** `makeSlasher` read `deployed.StakedReputationSet`
  but `Deploy.s.sol` writes `stakedReputationSet` (lowercase) → silent dry-run. Fixed the
  key casing so on-chain slashing works from `deployed.local.json` without forcing the
  membership root source on-chain.
