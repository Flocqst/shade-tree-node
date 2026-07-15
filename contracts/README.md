# contracts/

Reference contracts for the on-chain staked reputation set. Design and rationale live
in [`docs/ONCHAIN.md`](../docs/ONCHAIN.md); this README is just the map.

## StakedReputationSet.sol

The admission gate: a fixed-bond, refundable, slashable, time-locked-exit staking
contract adapted from the Rate-Limiting-Nullifier `RLN.sol` registry shape. Reference
implementation, **unaudited, testnet-only**.

Two pieces are deliberately abstracted behind interfaces and still need real wiring:

- `IWithdrawVerifier` — the ZK proof that authorizes `initiateExit` / `withdraw`
  without revealing the member (proof of knowledge of the identity secret, bound to a
  per-action context). Wire to the RLN / Semaphore verifier artifacts.
- `ICommitmentHasher` — recomputes `commitment == hash(secret)` so `slash` can check a
  reconstructed secret against its commitment. Wire to the Poseidon hasher for the
  identity scheme in use.

The Merkle root is maintained **off chain** in this reference: members and indices live
in a mapping and are emitted as events (`MemberRegistered` / `MemberExiting` /
`MemberWithdrawn` / `MemberSlashed`); the gateway and clients rebuild the tree from the
log and verify their local root against it (ROADMAP #2).

**This is enough only for the trusted-node root provider.** The light-client provider
(`lib/root-provider.mjs`, `LightClientRootProvider`) can only state-prove a root that
lives in an **on-chain storage slot**, so supporting it requires an on-chain incremental
Merkle tree that exposes the current root as state (e.g. compose with Semaphore's
on-chain group, or add a LeanIMT to this contract). If the light-client path matters,
build the on-chain-root version — it serves both providers; the off-chain-reconstruction
version serves only the node path. See docs/ONCHAIN.md, "Reading the root".

## Known simplifications (reference scope)

- `UNBONDING` must be `>= F + E + C` (freshness window + epoch + slash-confirmation
  margin); the constructor enforces a caller-supplied `minUnbonding` lower bound, but
  pinning the actual value to the gateway's live epoch parameters is an operator step.
- A withdrawn or slashed commitment can be re-registered (it is `delete`d, so it no
  longer `_exists`). Harmless for an append-only tree, and a slashed commitment's
  secret is already public so re-registering it buys nothing; add a burned-commitment
  set if you want to forbid it outright.
- No reentrancy guard is strictly needed (state is deleted before the external payout
  and there are no post-transfer reads), but add one before mainnet as defense in depth.

## Deploy (intended)

Local `anvil` (or a mainnet fork) first, then Sepolia L1, then L1 mainnet, per
ONCHAIN.md (we target Ethereum L1, not an L2). A Foundry or Hardhat script should:

1. deploy the verifier + hasher (real RLN artifacts, or mocks for local e2e),
2. deploy `StakedReputationSet(bond, unbonding, minUnbonding, verifier, hasher)`,
3. point the gateway/shim at it via `RGOE_GROUP_CONTRACT` / `RGOE_RPC_URL` /
   `RGOE_GROUP_ID`.

Toolchain (Foundry vs Hardhat) and the local `anvil` script are not committed yet.
