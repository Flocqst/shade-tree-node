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
| `StakedReputationSet` | `bond, unbonding, minUnbonding, withdrawVerifier, hasher` | member admission set (register / ZK-exit / time-locked withdraw / slash). Skipped when `RGOE_DEPLOY_STAKED=0`. |
| `MockWithdrawVerifier`, `MockCommitmentHasher` | — | **testnet-only** fallbacks, deployed **only** when `RGOE_WITHDRAW_VERIFIER` / `RGOE_COMMITMENT_HASHER` are unset. The mocks are **not** zero-knowledge (the secret is revealed in calldata); the script prints a `WARNING` when it deploys them. For a real deployment, pre-deploy the RLN/Groth16 verifier + rate-commitment hasher and pass their addresses. |

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
| `RGOE_WITHDRAW_VERIFIER` | `0` (⇒ deploy Mock) | pre-deployed `IWithdrawVerifier` address. |
| `RGOE_COMMITMENT_HASHER` | `0` (⇒ deploy Mock) | pre-deployed `ICommitmentHasher` address. |
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
   `c(uint256,uint256,uint256,address,address)` (bond, unbonding, minUnbonding,
   withdrawVerifier, hasher).
4. Sanity-read the on-chain params: `cast call <GatewayRegistry> "BOND()(uint256)" --rpc-url "$RGOE_RPC_URL"`
   and `"owner()(address)"` should echo what you deployed with.

## 7. Record the address into the fleet config

The bootnode/gateway/lib find the contracts through env vars (see `docs/CONFIG.md`,
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
See `docs/DEPLOYMENT.md` for the full topology and the fleet SAFETY notes (targeted
`tofu apply` only).

---

*Reference implementation, unaudited, testnet-only. The mocks are not zero-knowledge; a
production member set needs the real RLN/Groth16 verifier + rate-commitment hasher wired via
`RGOE_WITHDRAW_VERIFIER` / `RGOE_COMMITMENT_HASHER` (see T-HARD-1, trusted setup).*
