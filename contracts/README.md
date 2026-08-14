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

**Both root providers are now supported (T-DEV-9).** `StakedReputationSet` ALSO maintains
the identical RLN depth-20 Poseidon(2) incremental Merkle tree on chain and commits the
current root to a fixed storage slot (`currentRoot`, `ROOT_STORAGE_SLOT = 3`), updated on
every membership change with the SAME zero-in-place removal semantics as the off-chain
`reconstructRoot` (register = insert at the append index; exit / slash-while-active = zero
the leaf at its original index). So `currentRoot` equals the off-chain reconstructRoot root
by construction (pinned to the `lib/rln-removal-parity` golden in
`test/StakedReputationSet.t.sol::test_Root_*`). The light-client provider
(`lib/root-provider.mjs`, `LightClientRootProvider`) proves that slot with `eth_getProof`
and verifies the account + storage Merkle-Patricia proofs against a block's state root — so
it no longer trusts an RPC's event replay for the root's VALUE. What it still trusts is the
state root itself (fetched at a confirmed depth); validating that header against the beacon
sync committee (Helios) is the filed follow-up **T-DEV-9b**, with a `trustedStateRoot` hook
already in place to inject a verified root. Cost: 20 Poseidon(2) hashes per membership
change (~1.25M gas / register on the vendored pure-Solidity Poseidon; fine for testnet).
See docs/ONCHAIN.md, "Reading the root".

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
