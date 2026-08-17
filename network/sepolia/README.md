# Sepolia deployment record

The live deployment on Ethereum Sepolia (chainId 11155111). Machine-readable artifacts
alongside: [`contracts.json`](contracts.json) (staking contract addresses),
[`directory.json`](directory.json) (signed gateway fleet). This README is the
human-readable index; the JSON files are the source of truth the client/gateway read.

## Staking contracts

Status: **live** — release `rln-v3`, deployed at block 11279842 by
`0x3261DaF3672Dc8E6063b6960C161Fdc8a6Fc2ff7`. Params: bond 0.001 ETH, unbonding 300s,
`userMessageLimit` 8. [`contracts.json`](contracts.json) is the source of truth.

| Contract | Address |
|---|---|
| StakedReputationSet | [`0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC`](https://sepolia.etherscan.io/address/0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC) |
| RateCommitmentHasher (`hasher`) | `0x08F9a754D2cBdfB7805cFF2475632BEC4612ae6D` |
| MockWithdrawVerifier (`withdrawVerifier`) | `0x5A6FD01d009989ff9E567fa2bC55253500ddbDB2` |

**Superseded (history only, do not use):** the pre-RLN deployment at block 11274471 —
StakedReputationSet `0x35719A477655A5Aaac7A2aAA11A3167eFa3398EC`, MockCommitmentHasher
`0xB9c051d12750395e7541Da149e216B1542b343d2`, MockWithdrawVerifier
`0xac506585D70F8DA91C38CF271938Ee956f7CB862` — whose hasher was `Poseidon(secret)` rather than
the real RLN rateCommitment. An intermediate RLN deploy `0x7c5bcfD3…8c6E` was abandoned mid-test
(see `contracts.json` `note`). `GatewayRegistry` is not deployed on Sepolia yet
(`docs/ONCHAIN-DEPLOY.md`, GO-LIVE GAP-2).

## Gateway fleet

Three reputation-gated onion egress gateways on DigitalOcean (nyc3), provisioned via
`~/agent-devops` (`rgoe_gateway` role). Membership gates on the committed
`group/members.json`; the client rotates across all three per request. **All three
live** (Tor + gateway systemd units active, onions published). The signed
[`directory.json`](directory.json) is the machine-readable source of truth.

| Gateway | DO droplet | Onion | Status |
|---|---|---|---|
| gateway-1 | egress-01 | `kjeyt2gtzcvnbshedns5wvtahtqbqwlmw4e56ku3iuqiykf5mwwdqdad.onion` | live |
| gateway-2 | egress-02 | `oi73kttiriqhfmoxo42pstfobrhbjxko3gzzs54bovwhs2ayuw64imad.onion` | live |
| gateway-3 | rgoe-03 | `spoe2hmwp62w5bg74by7plx54rn4rzjro4bq6qzv5q6ewi4lqlovlbqd.onion` | live |

Onions are the member-facing discovery handles (they are what `directory.json` publishes).
The droplets' clearnet IPs are operational metadata and are not listed here; they live in
the agent-devops inventory. (The signed `directory.json` `note` fields from July still carry
them; that file is left byte-identical because editing it would break its signature.) A
member learns a gateway's egress IP as the result of a request anyway
(`curl -x … https://api.ipify.org`).

Directory signer (pinned in the client as `RGOE_DIR_SIGNER`):
`189f4511bad18f7d9e1fa1339b8b7ac27a7920ddf27b9a9c286b599bc0b21321`. The signer's secret
half (`group/directory-signer.key`) is gitignored. Per-droplet SSH keys are tracked in
`~/agent-devops/ansible/files/secrets/*.enc` (SOPS) + the fleet ledger; rgoe-03 was
created by OpenTofu, egress-01/02 retrofitted via the Ansible role.

## Using this deployment

```bash
export RGOE_DIRECTORY=network/sepolia/directory.json      # rotate across the fleet
export RGOE_DIR_SIGNER=189f4511bad18f7d9e1fa1339b8b7ac27a7920ddf27b9a9c286b599bc0b21321
export RGOE_SECRET=<your enrolled secret from demo-keys.local.md>
bash scripts/run-client.sh
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json   # a gateway's clean IP
# on-chain slashing (once contracts funded): set RGOE_GROUP_CONTRACT + RGOE_RPC_URL
# from contracts.json on each gateway's env.
```
