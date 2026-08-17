# On-chain deploy runbook: persistent `GatewayRegistry` + `StakedReputationSet`

Task: **T-DEPLOY-7** — a persistent on-chain deployment of the stake contracts, wired to
the live fleet (Sepolia or a chosen L2).

Script: [`contracts/script/DeployRegistry.s.sol`](../contracts/script/DeployRegistry.s.sol)
(`DeployRegistry`). It deploys `GatewayRegistry` and, unless disabled, `StakedReputationSet`
+ its verifier/hasher, logs every address, and writes them to a JSON record the gateway/lib
read. It is the production-oriented sibling of `script/Deploy.s.sol` (the local demo-stack
deployer): every constructor arg comes from an env var, and the ZK verifier/hasher are taken
as **addresses** so a real pre-deployed RLN/Groth16 verifier can be wired in.

> **Broadcasting is out of scope for this repo.** This repo ships and *simulates* the deploy
> tooling only. Sending the real transactions — `--broadcast` against a live RPC with a
> funded key — is a gated **operator action**. Nothing in CI or the test suite broadcasts,
> spends funds, or touches a live chain. The commands in [§3](#3-live-deploy-operator-only)
> are the operator's to run, deliberately, on a funded key.

---

## 1. What gets deployed

| contract | constructor args | role |
|---|---|---|
| `GatewayRegistry` | `bond, unbonding, minUnbonding, owner` | gateway-operator stake the bootnode reads for `stake`-mode admission; `owner` is the slashing/governance authority (`0` ⇒ deployer). |
| `StakedReputationSet` | `bond, unbonding, minUnbonding, withdrawVerifier, hasher, extraLimits[], extraBonds[]` | member admission set (register at a tier / ZK-exit / time-locked withdraw / tiered slash) with the on-chain root (`currentRoot`, slot 3). `bond` is the DEFAULT tier (limit 8); `extraLimits/extraBonds` are the other admitted tiers (T-FEAT-8b, `RGOE_TIER_LIMITS` / `RGOE_TIER_BONDS_WEI`). Skipped when `RGOE_DEPLOY_STAKED=0`; `GatewayRegistry` skipped when `RGOE_DEPLOY_REGISTRY=0` (its address then comes from `RGOE_GATEWAY_REGISTRY` for the record). |
| `RateCommitmentHasher` | — | the real tiered Poseidon rate-commitment hasher (`commitmentOf(secret, limit)`), deployed when `RGOE_COMMITMENT_HASHER` is unset. Links the external `PoseidonT2` / `PoseidonT3` libraries (deployed alongside, or reused via `--libraries`, see §5). |
| `WithdrawGroth16Verifier` + `WithdrawVerifier` | — | the REAL Groth16 exit-auth verifier (T-DEV-1), deployed when `RGOE_WITHDRAW_VERIFIER` is unset and `RGOE_DEPLOY_REAL_VERIFIER=1`. VK = the untrusted dev phase-2 (testnet-only until T-HARD-1). |
| `MockWithdrawVerifier` | — | **testnet-only** fallback, deployed **only** when `RGOE_WITHDRAW_VERIFIER` is unset and `RGOE_DEPLOY_REAL_VERIFIER` is not `1`. NOT zero-knowledge (the secret is revealed in calldata); the script prints a `WARNING` when it deploys it. |

`minUnbonding` is the `F + E + C` lower bound (freshness window + epoch + slash-confirmation
margin) both constructors enforce, so a misconfigured short unbonding window is rejected
on deploy. See `docs/ONCHAIN.md`.

## 2. Environment variables

All optional; every one has a safe default, so the same script targets local anvil, Sepolia,
or any L2 by changing only `--rpc-url` and the env.

| var | default | meaning |
|---|---|---|
| `RGOE_BOND_WEI` | `0.01 ether` | fixed stake denomination, in wei (use a testnet-frugal value, e.g. `1000000000000000` = 0.001 ETH). |
| `RGOE_UNBONDING` | `300` | exit time-lock, seconds. |
| `RGOE_MIN_UNBONDING` | `270` | `F+E+C` lower bound the constructors enforce. |
| `RGOE_GATEWAY_OWNER` | `0` (⇒ deployer) | `GatewayRegistry` slashing / governance address. Set to a DAO/multisig for a persistent deployment. |
| `RGOE_DEPLOY_STAKED` | `1` | `1` = also deploy `StakedReputationSet`; `0` = `GatewayRegistry` only. |
| `RGOE_DEPLOY_REGISTRY` | `1` | `0` = do NOT deploy a `GatewayRegistry`; record `RGOE_GATEWAY_REGISTRY` instead (a member-set-only redeploy next to a live registry, e.g. rln-v4). |
| `RGOE_TIER_LIMITS` | `""` (default tier 8 only) | extra admitted tiers, comma-separated userMessageLimits (`"32"`, `"32,64"`): ascending, distinct, `1..65535`, `!= 8`. |
| `RGOE_TIER_BONDS_WEI` | `""` | the bond of each extra tier, wei, same length as `RGOE_TIER_LIMITS`, each nonzero (Sepolia rln-v4: `4000000000000000` for tier 32). Tier 8 always costs `RGOE_BOND_WEI`. |
| `RGOE_WITHDRAW_VERIFIER` | `0` (⇒ deploy) | pre-deployed `IWithdrawVerifier` address (must take `(commitment, limit, context, proof)`). |
| `RGOE_DEPLOY_REAL_VERIFIER` | `0` | `1` = deploy the REAL Groth16 `WithdrawVerifier` when `RGOE_WITHDRAW_VERIFIER` is unset (else the Mock). |
| `RGOE_COMMITMENT_HASHER` | `0` (⇒ deploy `RateCommitmentHasher`) | pre-deployed `ICommitmentHasher` address (must implement the TIERED `commitmentOf(secret, limit)`; the rln-v3 hasher `0x08F9a754…ae6D` pins K=8 and cannot be reused). |
| `RGOE_RPC_URL` | `http://127.0.0.1:8545` | endpoint; also recorded into the output JSON. |
| `RGOE_DEPLOY_OUT` | `contracts/deployed.local.json` | JSON output path. Point at a scratch file for simulation; leave default for the real deploy so the gateway/lib pick the addresses up. |

## 3. Prerequisites

- **Foundry** installed (`forge --version`). The repo needs no `forge install` — the
  cheatcode interface is vendored in `test/Cheats.sol`.
- **An RPC endpoint** for the target chain. Sepolia has a keyless public one already wired
  into `foundry.toml` (`sepolia_public = https://ethereum-sepolia-rpc.publicnode.com`);
  override with your own via `RGOE_RPC_URL`.
- **A funded deployer key** on the target chain (deploy cost is a few million gas — well
  under 0.05 Sepolia ETH). Fund it from a faucet for Sepolia, or bridge for an L2.
- **The key handled via a keystore, never inline.** Do **not** paste a raw private key on
  the command line (it lands in shell history and `ps`). Import it once into Foundry's
  encrypted keystore:
  ```bash
  cast wallet import rgoe-deployer --interactive   # paste key once; prompts for a password
  ```
  then reference it by name with `--account rgoe-deployer` (Foundry prompts for the
  password at deploy time). Hardware wallets (`--ledger` / `--trezor`) work too.

## 4. Dry run FIRST (no funds, no live chain)

Simulate against Foundry's in-memory EVM. **No `--broadcast`, no `--rpc-url`** ⇒ nothing is
sent, no key is touched. Point the output at a scratch file so the committed
`contracts/deployed.local.json` is untouched:

```bash
RGOE_DEPLOY_OUT=cache/deployed.sim.json \
forge script contracts/script/DeployRegistry.s.sol:DeployRegistry
```

Read the `== Logs ==` block: confirm `chainid`, the bond/unbonding params, and that the
`WARNING: deployed Mock...` lines appear **only** if you intend to use the testnet mocks.
Then run the same command with your real env (`RGOE_RPC_URL`, bond, owner, verifier/hasher)
still **without** `--broadcast` to confirm the numbers before spending anything.

## 5. Live deploy (OPERATOR ONLY)

> ⚠️ **This is the LIVE, funds-spending step.** It broadcasts real transactions. Run it
> deliberately, on a chain and key you control. It is not run by CI, tests, or this repo.

```bash
# 1. Point at the target chain + params.
export RGOE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com   # or your L2 RPC
export RGOE_BOND_WEI=1000000000000000        # 0.001 ETH — testnet-frugal
export RGOE_UNBONDING=300 RGOE_MIN_UNBONDING=270
export RGOE_GATEWAY_OWNER=0x<governance-multisig>   # omit to default to the deployer
# For a real member set, also export RGOE_WITHDRAW_VERIFIER / RGOE_COMMITMENT_HASHER.
# Leave RGOE_DEPLOY_OUT unset so it writes contracts/deployed.local.json.

# 2. Broadcast (encrypted keystore; prompts for the password — no inline key).
forge script contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$RGOE_RPC_URL" \
  --account rgoe-deployer \
  --broadcast
```

Add `--verify --etherscan-api-key <key>` if you want Foundry to submit source verification
in the same run (see §6 for the manual path). The broadcast writes a receipt bundle under
`broadcast/DeployRegistry.s.sol/<chainId>/` and the addresses to
`contracts/deployed.local.json`.

**`GatewayRegistry`-only** (skip the member set): add `RGOE_DEPLOY_STAKED=0`.

**Member-set-only redeploy next to a live registry (how rln-v4 was deployed, 2026-08-17):**

```bash
export RGOE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
RGOE_DEPLOY_STAKED=1 RGOE_DEPLOY_REGISTRY=0 \
RGOE_GATEWAY_REGISTRY=0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868 \
RGOE_DEPLOY_REAL_VERIFIER=1 \
RGOE_BOND_WEI=1000000000000000 RGOE_TIER_LIMITS=32 RGOE_TIER_BONDS_WEI=4000000000000000 \
RGOE_UNBONDING=300 RGOE_MIN_UNBONDING=270 \
RGOE_DEPLOY_OUT=./cache/sepolia-rln-v4.local.json \
forge script contracts/script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url "$RGOE_RPC_URL" --private-key "$K" \
  --libraries contracts/PoseidonT2.sol:PoseidonT2:0xA20D550b5b3b99c0abB6E51d68d2a39955E69b55 \
  --libraries contracts/PoseidonT3.sol:PoseidonT3:0x82Cb42c70208a92DD5938b5f4D67C7d2313bE022 \
  --broadcast --slow
```

Simulate first (drop `--broadcast`), then broadcast. Notes from that run: `--libraries` reuses
the Poseidon libraries the rln-v3 deploy left on Sepolia (their runtime bytecode was compared
with `forge inspect … deployedBytecode` vs `cast code` first — identical apart from the
library's own PUSH20 self-address; saves ~5.4M gas); `--slow` waits for each receipt (the
deployer key was in concurrent use by `rgoe register-gateway`); `RGOE_DEPLOY_OUT` must stay
under the repo (`foundry.toml` `fs_permissions`); `$K` is loaded into the shell from SOPS and
never echoed. Cost: 4 CREATEs, 3.37M gas, ~0.0036 ETH at ~1.0 gwei
(`network/sepolia/rln-v4-broadcast.json`).

## 6. Verify on the explorer

1. Note the deployed addresses from the `== Logs ==` block (also in
   `contracts/deployed.local.json` and `broadcast/DeployRegistry.s.sol/<chainId>/run-latest.json`).
2. Open the address on the target explorer (Sepolia: `https://sepolia.etherscan.io/address/<addr>`).
3. Verify source, either inline during deploy (`--verify`) or after the fact:
   ```bash
   forge verify-contract <addr> contracts/GatewayRegistry.sol:GatewayRegistry \
     --chain sepolia --etherscan-api-key <key> \
     --constructor-args $(cast abi-encode "c(uint256,uint256,uint256,address)" \
       "$RGOE_BOND_WEI" "$RGOE_UNBONDING" "$RGOE_MIN_UNBONDING" "$RGOE_GATEWAY_OWNER")
   ```
   For `StakedReputationSet` the constructor signature is
   `c(uint256,uint256,uint256,address,address,uint256[],uint256[])` (bond, unbonding,
   minUnbonding, withdrawVerifier, hasher, extraLimits, extraBonds), and it links the two
   Poseidon libraries (`--libraries …` as at deploy).
4. Sanity-read the on-chain params: `cast call <GatewayRegistry> "BOND()(uint256)" --rpc-url "$RGOE_RPC_URL"`
   and `"owner()(address)"` should echo what you deployed with; for the set,
   `"currentRoot()(uint256)"` (a fresh set == the empty depth-20 root
   `10354334201938752428558948798274962999644820234654929486063894213598717249307`),
   `"allowedLimits()(uint256[])"`, `"bondFor(uint256)(uint256)" 32`, `"withdrawVerifier()(address)"`,
   `"hasher()(address)"`, `"ROOT_STORAGE_SLOT()(uint256)"` (3), and
   `cast call <hasher> "commitmentOf(uint256,uint256)(uint256)" 111 32` ==
   `15363698809722346745616993869789510363416645981863858152379739283427647190637` (the JS golden).

## 7. Record the address into the fleet config

**First, commit the record** (`network/<name>/contracts.json` is the canonical per-network
truth; `network/README.md`). One command lifts address + tx hash + block from the broadcast
receipt bundle into the committed record, validates it, and refuses a chain mismatch:

```bash
node scripts/record-deploy.mjs --network sepolia \
  --from-broadcast broadcast/DeployRegistry.s.sol/11155111/run-latest.json
git diff network/sepolia/contracts.json   # contracts/deployTxs/deployBlocks.gatewayRegistry filled
# a member-set redeploy: record every CREATE (set, hasher, verifiers), overwriting the old slots
node scripts/record-deploy.mjs --network sepolia --all --force \
  --from-broadcast broadcast/DeployRegistry.s.sol/11155111/run-latest.json
```

For a redeploy of an existing slot, then hand-edit the free-form keys: bump `release`, move
the previous addresses under `superseded.<old-release>`, and refresh `params` / `note` /
`liveIntegration` (see the rln-v4-tiers record). `RGOE_NETWORK=sepolia` resolves
`RGOE_GROUP_CONTRACT` to whatever `contracts.stakedReputationSet` says, so the record IS the
switch for every `--network` caller; the FLEET units (agent-devops group vars) are flipped
separately (§8).

From then on `RGOE_NETWORK=sepolia` supplies `RGOE_GATEWAY_REGISTRY` + `RGOE_RPC_URL` to the
bootnode (`rgoe bootnode --network sepolia --admission stake`), `rgoe register-gateway`, and the
client's stake re-verification, with explicit env still overriding.

The bootnode/gateway/lib otherwise find the contracts through env vars (see `docs/CONFIG.md`,
`docs/OPERATOR.md`). After a live deploy, wire the deployed `GatewayRegistry` address in:

| var | where | purpose |
|---|---|---|
| `RGOE_GATEWAY_REGISTRY` | `rgoe-bootnode` unit (+ `rgoe register-gateway`) | `GatewayRegistry` address. Required for `onchain` stake mode and `register-gateway`. |
| `RGOE_RPC_URL` | bootnode + any on-chain caller | JSON-RPC endpoint for all reads/writes. |
| `RGOE_STAKE_MODE=onchain` | `rgoe-bootnode` unit | switch admission from the `mock` (chainless) verifier to the on-chain `isStaked` eth_call. Auto-selects `onchain` when `RGOE_GATEWAY_REGISTRY` is set. |
| `RGOE_BOOTNODE_ADMISSION=stake` | `rgoe-bootnode` unit | require a live gateway stake for admission (default is `open`). |

`register-gateway` / `register-onchain` also fall back to reading
`contracts/deployed.local.json` (`gatewayRegistry`, `rpcUrl`) when the env is unset, so on
the deployer box the JSON record alone is enough for those scripts. On the fleet, set the
env explicitly on the units (the JSON is machine-local and gitignored). For member-side
slashing wire `RGOE_GROUP_CONTRACT` (`StakedReputationSet`) + `RGOE_RPC_URL` per
`network/README.md`.

Then turn on staking end to end (per `bootnode/deploy/README.md`):

1. Deploy (this runbook) and set the four vars above on the `rgoe-bootnode` unit.
2. Stake the operator: `rgoe register-gateway` with the operator key funded on that chain.
3. Add `RGOE_GW_OPERATOR_KEY=<operator-key>` to the `rgoe-heartbeat` unit so the heartbeat
   signs the durable onion↔operator authorization.

## 8. Composition with T-DEPLOY-3 (infra-as-code)

This is the on-chain half of the deploy; the fleet half is the OpenTofu + Ansible IaC in
`~/agent-devops` (T-DEPLOY-3). They compose in order:

1. **Contracts (this runbook)** → deploy on Sepolia/L2, get the `GatewayRegistry` address.
2. **Fleet (agent-devops)** → provision/retrofit the gateway droplets and render their
   systemd units. Set `RGOE_GATEWAY_REGISTRY` / `RGOE_RPC_URL` / `RGOE_STAKE_MODE` /
   `RGOE_BOOTNODE_ADMISSION` as host/group vars so the generated `rgoe-bootnode` unit
   comes up pointed at the deployed contract — not by hand-ssh.
3. **Register + heartbeat** → `rgoe register-gateway` from a funded operator key, then the
   heartbeat signs the onion↔operator binding.

Keep the contract address in the agent-devops inventory (group vars) as the single source of
truth for the fleet; `contracts/deployed.local.json` stays the deployer-box local cache.

**Flipping the fleet to a new member set (rln-v3 → rln-v4-tiers).** The live gateways slash
against `RGOE_SLASH_CONTRACT` (rln-v3 `0xdAE242AE…20FC` at the time of writing) and gate on
`group/members.json`; the rln-v4 set `0xFe48De8b…9d25` is live and recorded but the units were
deliberately NOT flipped in the same change (that is a live-fleet config change: agent-devops
group vars `RGOE_SLASH_CONTRACT` (+ `RGOE_GROUP_CONTRACT` for on-chain root mode) → re-render
→ restart, per `docs/DEPLOYMENT.md`; never a hand-ssh edit). Until then a member staked on
rln-v4 is admitted by an rln-v4-rooted gateway and slashable there, while the fleet's
members.json gateways keep slashing tier-8 leaves on rln-v3. The gateway auto-detects which
contract generation it talks to (`slash: on-chain … abi=…` at startup), so the flip needs no
code change.
See `docs/DEPLOYMENT.md` for the full topology and the fleet SAFETY notes (targeted
`tofu apply` only).

---

*Reference implementation, unaudited, testnet-only. The mocks are not zero-knowledge; a
production member set needs the real RLN/Groth16 verifier + rate-commitment hasher wired via
`RGOE_WITHDRAW_VERIFIER` / `RGOE_COMMITMENT_HASHER` (see T-HARD-1, trusted setup).*
