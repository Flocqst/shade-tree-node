# Sepolia deployment record

The live deployment on Ethereum Sepolia (chainId 11155111). Machine-readable artifacts
alongside: [`contracts.json`](contracts.json) (contract addresses + deploy tx/block),
[`bootnode.json`](bootnode.json) (fleet discovery record), [`directory.json`](directory.json)
(signed gateway fleet). This README is the human-readable index; the JSON files are the
source of truth the client/gateway read (`RGOE_NETWORK=sepolia`, see `network/README.md`).

## Staking contracts

Status: **live** — release `rln-v4-tiers`, deployed 2026-08-17 (blocks 11510538–11510541) by
the fleet operator hot key `0xc8606C75E003EDA7C0a377B4708AbEC6EB7a7f02`. Params: tiers
{8: 0.001 ETH, 32: 0.004 ETH} (`bondFor(limit)`), unbonding 300s (min 270), `DEFAULT_LIMIT` 8,
on-chain root at storage slot 3. [`contracts.json`](contracts.json) is the source of truth.
Live integration (two tiers, on-chain root mode, tier-32 slash):
[`integration-report-rln-v4.md`](integration-report-rln-v4.md).

| Contract | Address |
|---|---|
| StakedReputationSet (tiered, on-chain tree) | [`0xFe48De8b9aCA4386DC31C845d579ae62f04f9d25`](https://sepolia.etherscan.io/address/0xFe48De8b9aCA4386DC31C845d579ae62f04f9d25) — tx `0xa565fd77…3ba03`, block 11510541 |
| RateCommitmentHasher (`hasher`, tiered `commitmentOf(secret, limit)`) | `0x29e9D6ae8d46A9D86D6A92a43307850e0FA06586` |
| WithdrawVerifier (`withdrawVerifier`, REAL Groth16 exit-auth) | `0x522409038aA03FFF998d33C60A37486975695351` over `WithdrawGroth16Verifier` `0x6B26a9B6BEdcB711C35947f988fdFF168AFD507E` (untrusted dev VK, T-HARD-1) |
| PoseidonT2 / PoseidonT3 (linked libraries) | `0xA20D550b5b3b99c0abB6E51d68d2a39955E69b55` / `0x82Cb42c70208a92DD5938b5f4D67C7d2313bE022` (from the rln-v3 deploy, reused) |
| PaidAccessSet (T-FEAT-7 paid-access membership tree; operator-inserted, no funds) | [`0x4e8C2Bf5d3c5454A04837401095fce2646484111`](https://sepolia.etherscan.io/address/0x4e8C2Bf5d3c5454A04837401095fce2646484111) — deployed 2026-08-17 at block 11510873, tx `0x9835d062…4086`, operator `0xc8606C75E003EDA7C0a377B4708AbEC6EB7a7f02` (registrar / insert key), `allowedLimits() == [8, 32]`, same hasher + Poseidon libraries as the staked set, `currentRoot` at slot 3. Payment settles OFF chain (HTTP 402 rails, x402 / MPP); the operator inserts after settlement; `slash` zeroes the leaf and pays nothing. Smoke (one insert at tier 8, root == JS, negatives revert): [`integration-report-paid-access.md`](integration-report-paid-access.md); receipt: [`paid-access-broadcast.json`](paid-access-broadcast.json). `RGOE_NETWORK=sepolia` supplies `RGOE_PAID_ACCESS_CONTRACT`. |
| GatewayRegistry | [`0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868`](https://sepolia.etherscan.io/address/0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868) — deployed 2026-08-17 at block 11509783, tx `0x1ae812c1…3ad5dc`, owner `0xc8606C75E003EDA7C0a377B4708AbEC6EB7a7f02` (fleet operator hot key); BOND 0.001 ETH, unbonding 300s / min 270s (verified via `cast`: `BOND()`, `owner()`). Receipt bundle: [`gateway-registry-broadcast.json`](gateway-registry-broadcast.json); recorded with `rgoe record-deploy --network sepolia --from-broadcast …`. `RGOE_NETWORK=sepolia` now supplies `RGOE_GATEWAY_REGISTRY` (`docs/ONCHAIN-DEPLOY.md` §7). Unchanged by the rln-v4 redeploy. |

Receipt bundle: [`rln-v4-broadcast.json`](rln-v4-broadcast.json). `RGOE_NETWORK=sepolia`
resolves `RGOE_GROUP_CONTRACT` to the rln-v4 set. Stake at a tier with
`rgoe register-member <leaf> --limit 8|32 --network sepolia` (`docs/CLI.md`).

**Superseded (history only, do not stake there):**

- **rln-v3** (2026-07-15, block 11279842, deployer `0x3261DaF3…2ff7`): StakedReputationSet
  `0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC`, RateCommitmentHasher (K pinned to 8)
  `0x08F9a754D2cBdfB7805cFF2475632BEC4612ae6D`, MockWithdrawVerifier
  `0x5A6FD01d009989ff9E567fa2bC55253500ddbDB2`. No on-chain tree (slot 3 = 0, so the light
  provider yielded no root — the finding that filed T-DEV-9c) and no tiers. Superseded by
  rln-v4-tiers; **the LIVE fleet gateways' slashing (`RGOE_SLASH_CONTRACT`) still points here
  until their units are flipped** (`docs/ONCHAIN-DEPLOY.md` §8). Its live integration:
  [`integration-report-rln.md`](integration-report-rln.md); kept under `superseded.rln-v3` in
  `contracts.json`.
- the pre-RLN deployment at block 11274471 — StakedReputationSet
  `0x35719A477655A5Aaac7A2aAA11A3167eFa3398EC`, MockCommitmentHasher
  `0xB9c051d12750395e7541Da149e216B1542b343d2`, MockWithdrawVerifier
  `0xac506585D70F8DA91C38CF271938Ee956f7CB862` — whose hasher was `Poseidon(secret)` rather than
  the real RLN rateCommitment. An intermediate RLN deploy `0x7c5bcfD3…8c6E` was abandoned mid-test
  (see `contracts.json` `superseded.rln-v3.note`).

## Payments: settle asset + registrar (T-FEAT-7)

| what | value |
|---|---|
| settle asset (`payAsset`) | **tUSD** "Test USD" (`test/Eip3009Token.sol`, EIP-3009, 6 decimals, version `"1"`) at [`0xCe0C9F8822e4841e735d2eDe3a1Db57CfE55a3A8`](https://sepolia.etherscan.io/address/0xCe0C9F8822e4841e735d2eDe3a1Db57CfE55a3A8) — deployed 2026-08-17 by the fleet operator key, tx `0x9561fa31…b234`, block 11511028. Circle's Sepolia USDC `0x1c7D4B19…7238` was verified EIP-3009-capable (`TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `authorizationState`, `DOMAIN_SEPARATOR == EIP712{USDC,2}`), but its faucet is captcha-gated; real USDC is the one-env swap `RGOE_PAY_ASSET`. `RGOE_NETWORK=sepolia` supplies `RGOE_PAY_ASSET`. |
| registrar (`registrar`) | `http://<bootnode onion>:8878/` (the bootnode onion in `bootnode.json`, virtual port 8878), protocols `x402` (v2: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) + `mpp` (`WWW-Authenticate: Payment` / `Authorization: Payment` / `Payment-Receipt`, method `evm`, intent `charge`, `type=authorization`), prices tier 8 = `100000` (0.10 tUSD), tier 32 = `400000` (0.40 tUSD), payTo = the operator `0xc8606C75…7f02`. Advertised in the bootnode `/health` `pay` block. `RGOE_NETWORK=sepolia` supplies `RGOE_REGISTRAR_PORT`; `rgoe pay --network sepolia --limit 8` buys a leaf into the PaidAccessSet above. Live receipts: `docs/GO-LIVE-LOG-2026-08-17.md` "(payments)". |

## Bootnode

[`bootnode.json`](bootnode.json) is the committed discovery record (`{onion, signer,
admission, staticDirectory}`; schema in `network/README.md`). Status: **live** since
2026-08-17 (T-DEPLOY-1 + T-DEPLOY-2 + stake admission,
[`docs/GO-LIVE-LOG-2026-08-17.md`](../../docs/GO-LIVE-LOG-2026-08-17.md)).

| field | value |
|---|---|
| bootnode onion | `kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion` |
| pinned signer (`RGOE_DIR_SIGNER`) | `d79f78c369bd9c7b74575eae0c5068e6921f90bfdc97d43af9adc0039f953a73` |
| admission | **`stake`** since 2026-08-17 (later): `RGOE_STAKE_MODE=onchain` against `GatewayRegistry` `0x94ECeD0C…A868` (bond 0.001 ETH); the fleet operator `0xc8606C75…7f02` is staked and both heartbeats sign the onion↔operator auth (`announced (staked=true)`), one stake backs both onions (`docs/BOOTNODE.md` "The onion is never on chain") |
| gateway-1 onion (region `na`, NYC) | `yaxo4ywgoizk4yiylx66k3vjsgcj5waruumgi6dgds4fgaihd2eh7yqd.onion` |
| gateway-2 onion (region `na`, SFO) | `av4m256h4wwgwdmg74wnqem7s7l333h6755sroydlbcq62ptkmawtwid.onion` (gateway-only box, `bootstrap.sh` `RGOE_BOOTNODE_ONION` mode, T-DEPLOY-2) |
| gateway slashing | on-chain, routed: primary `RGOE_SLASH_CONTRACT` = rln-v4 `StakedReputationSet` `0xFe48De8b…9d25` (flipped from rln-v3 2026-08-17 21:28 UTC), plus `PaidAccessSet` for paid leaves (`makeRoutingSlasher`) |
| onion PoW | off (`RGOE_ENABLE_POW=0`; a `pow: no` client tor could not reach a PoW onion) |
| membership roots | union (`RGOE_ROOTS=static,onchain`): committed `group/members.json` (8 invited) ∪ rln-v4 `StakedReputationSet` `0xFe48De8b…9d25` (staked, tiers 8/32) ∪ `PaidAccessSet` `0x4e8C2Bf5…4111` (bought over 402); since 2026-08-17 23:35 UTC, see `docs/GO-LIVE-LOG-2026-08-17.md` "(payments, later)" |
| ref deployed | both `main` @ `6c4940c` (2026-08-18 00:06 UTC; earlier `cb237e07` / `d8a6530` / `af225c2`) |

`RGOE_NETWORK=sepolia` now resolves `RGOE_BOOTNODE_ONION` + `RGOE_DIR_SIGNER` to the values
above, so `RGOE_SECRET=<hex> RGOE_NETWORK=sepolia rgoe client` discovers the fleet through the
bootnode. Cold path (bootnode dark, `docs/INCIDENT.md` #1): the record's `staticDirectory`
points at [`directory-bootnode.json`](directory-bootnode.json), the bootnode's own signed
`/directory` export (same signer, both gateways), so `RGOE_DIRECTORY=network/sepolia/directory-bootnode.json
RGOE_DIR_SIGNER=d79f78c3…3a73` still works. The box hosting bootnode + gateway-1 is a
DigitalOcean droplet in NYC and gateway-2 is a DigitalOcean droplet in SFO (same AS14061,
different regions — `docs/GO-LIVE-LOG-2026-08-17.md` names them); their clearnet IPs are
operational metadata and are not recorded here. The client rotates across both
(`RGOE_ROTATION_SPREAD=1` for strict round-robin).

## Legacy gateway fleet (static directory)

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

Bootnode fleet (live discovery, the default path):

```bash
export RGOE_SECRET=<your enrolled secret>
bash scripts/start-tor-client.sh                           # laptop tor on SOCKS 9260
RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node bin/rgoe.mjs client   # bootnode onion + signer from bootnode.json
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json   # a gateway's clean IP
```

Buy a leaf instead of being enrolled (T-FEAT-7; a wallet holding tUSD, no ETH needed):

```bash
RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node bin/rgoe.mjs pay --limit 8 --protocol x402 --key-file buyer.key --secret-file ./.secret
RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node bin/rgoe.mjs pay --limit 32 --protocol mpp  --key-file buyer.key --secret-file ./.secret
```

Legacy static-directory fleet:

```bash
export RGOE_DIRECTORY=network/sepolia/directory.json      # rotate across the legacy fleet
export RGOE_DIR_SIGNER=189f4511bad18f7d9e1fa1339b8b7ac27a7920ddf27b9a9c286b599bc0b21321
export RGOE_SECRET=<your enrolled secret from demo-keys.local.md>
bash scripts/run-client.sh
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json   # a gateway's clean IP
# on-chain slashing (once contracts funded): set RGOE_GROUP_CONTRACT + RGOE_RPC_URL
# from contracts.json on each gateway's env.
```
