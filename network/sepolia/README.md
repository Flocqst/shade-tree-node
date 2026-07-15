# Sepolia deployment record

The live deployment on Ethereum Sepolia (chainId 11155111). Machine-readable artifacts
alongside: [`contracts.json`](contracts.json) (staking contract addresses),
[`directory.json`](directory.json) (signed gateway fleet). This README is the
human-readable index; the JSON files are the source of truth the client/gateway read.

## Staking contracts

Status: **pending funding** — the deployer `0x3261DaF3672Dc8E6063b6960C161Fdc8a6Fc2ff7`
has 0 Sepolia ETH. Once funded, `docs/DEPLOYMENT.md` Part A deploys and rewrites
`contracts.json` with live addresses + block. Params: bond 0.001 ETH, unbonding 300s.

| Contract | Address |
|---|---|
| StakedReputationSet | _pending_ |
| MockCommitmentHasher | _pending_ |
| MockWithdrawVerifier | _pending_ |

## Gateway fleet

Three reputation-gated onion egress gateways on DigitalOcean (nyc3), provisioned via
`~/agent-devops` (`rgoe_gateway` role). Membership gates on the committed
`group/members.json`; the client rotates across all three per request. **All three
live** (Tor + gateway systemd units active, onions published). The signed
[`directory.json`](directory.json) is the machine-readable source of truth.

| Gateway | DO droplet | IPv4 | Onion | Status |
|---|---|---|---|---|
| gateway-1 | egress-01 | 165.227.118.154 | `kjeyt2gtzcvnbshedns5wvtahtqbqwlmw4e56ku3iuqiykf5mwwdqdad.onion` | live |
| gateway-2 | egress-02 | 167.172.224.177 | `oi73kttiriqhfmoxo42pstfobrhbjxko3gzzs54bovwhs2ayuw64imad.onion` | live |
| gateway-3 | rgoe-03 | 167.172.237.22 | `spoe2hmwp62w5bg74by7plx54rn4rzjro4bq6qzv5q6ewi4lqlovlbqd.onion` | live |

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
