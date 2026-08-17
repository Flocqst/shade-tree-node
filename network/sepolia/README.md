# Sepolia deployment record

The live deployment on Ethereum Sepolia (chainId 11155111). Machine-readable artifacts
alongside: [`contracts.json`](contracts.json) (contract addresses + deploy tx/block),
[`bootnode.json`](bootnode.json) (fleet discovery record), [`directory.json`](directory.json)
(signed gateway fleet). This README is the human-readable index; the JSON files are the
source of truth the client/gateway read (`RGOE_NETWORK=sepolia`, see `network/README.md`).

## Staking contracts

Status: **live** (`release: rln-v3`) — deployed at block 11279842 by
`0x3261DaF3672Dc8E6063b6960C161Fdc8a6Fc2ff7`. Params: bond 0.001 ETH, unbonding 300s.
Supersedes the pre-RLN deployment `0x35719A47…98EC` (block 11274471); see the `note` in
`contracts.json`.

| Contract | Address |
|---|---|
| StakedReputationSet | [`0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC`](https://sepolia.etherscan.io/address/0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC) |
| RateCommitmentHasher | `0x08F9a754D2cBdfB7805cFF2475632BEC4612ae6D` |
| MockWithdrawVerifier | `0x5A6FD01d009989ff9E567fa2bC55253500ddbDB2` |
| GatewayRegistry | **not deployed** (`contracts.gatewayRegistry: null`; docs/GO-LIVE.md GAP-2 / Phase 3). Record it after the broadcast with `rgoe record-deploy --network sepolia --from-broadcast broadcast/DeployRegistry.s.sol/11155111/run-latest.json`. |

## Bootnode

[`bootnode.json`](bootnode.json) is the committed discovery record (`{onion, signer,
admission, staticDirectory}`; schema in `network/README.md`). Status: **pending** — the
existing gateway fleet below is discovered through the static signed `directory.json`
(the record's `staticDirectory` carries that directory's pinned signer, so
`RGOE_NETWORK=sepolia` already resolves `RGOE_DIRECTORY` + `RGOE_DIR_SIGNER`). No bootnode
onion for the existing fleet is recorded in this repo. When the T-DEPLOY-1 bootnode is
live (docs/GO-LIVE.md row 7.1), set `onion` + `signer` to the NEW fleet's values,
`admission` to what its unit enforces, and `status: live` — onions and pubkeys only, never
IPs.

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
