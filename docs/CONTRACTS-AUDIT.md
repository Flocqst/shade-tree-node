# CONTRACTS-AUDIT.md

Auditor's guide and written invariants for the Solidity contracts in `contracts/`.
Reference implementation, unaudited, testnet-only. This document is prep for an external
review (task T-HARD-6); it does not modify any source.

Scope: `contracts/*.sol`. Design rationale lives in `docs/ONCHAIN.md`; this file is the
audit map, the invariant list, and the run instructions.

Solc: `0.8.24`, optimizer on, 200 runs (`foundry.toml`). Two contracts carry the built-in
0.8 checked-arithmetic guarantee; `RlnGroth16Verifier.sol` is a snarkJS export pinned to
`>=0.7.0 <0.9.0` and is out of scope for hand review (machine-generated, see below).

---

## 1. Contract inventory

| Contract | File | Purpose | Deployment status |
|---|---|---|---|
| `StakedReputationSet` | `StakedReputationSet.sol` | Member admission gate: fixed-bond, refundable, slashable, time-locked-exit stake keyed by RLN rate-commitment (anonymous leaf). | **Live on Sepolia** `0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC` (`network/sepolia/contracts.json`, status `live`, release `rln-v3`). |
| `GatewayRegistry` | `GatewayRegistry.sol` | Gateway-operator bond keyed by operator **address**; owner-gated slash. The gateway-side dual of the member stake, deliberately minimal and optional. | **Local-only.** Not present in `network/sepolia/contracts.json`. Deploy params mirrored in `test/GatewayRegistry.t.sol`. |
| `RateCommitmentHasher` | `RateCommitmentHasher.sol` | Real Poseidon `commitmentOf(secret) = Poseidon(2)([Poseidon(1)([secret]), 8])`, the RLN rate-commitment leaf. Implements `ICommitmentHasher`. | **Live on Sepolia** as `hasher` `0x08F9a754D2cBdfB7805cFF2475632BEC4612ae6D`. |
| `MockCommitmentHasher` | `MockCommitmentHasher.sol` | Deprecated-name alias: empty subclass of `RateCommitmentHasher` kept so the deploy script keeps compiling. Fully correct rate-commitment hasher. | Alias only; the live `hasher` is the rate-commitment hasher. |
| `WithdrawVerifier` (+ `WithdrawGroth16Verifier`) | `WithdrawVerifier.sol` / `WithdrawGroth16Verifier.sol` | The **real** ZK exit/withdraw authorizer (T-DEV-1): Groth16 proof of knowledge of the identity secret behind a leaf, `context` reduced into the field as the circuit's public `address` input (binds exit vs. withdraw-to-recipient), then `Poseidon(2)([identityCommitment, 8]) == commitment` ties it to the registered leaf. Implements `IWithdrawVerifier`. Foundry: `test/WithdrawVerifier.t.sol`. | Built + tested; **not yet deployed** — Sepolia `rln-v3` still wires the mock (section 3). |
| `MockWithdrawVerifier` | `MockWithdrawVerifier.sol` | Demo exit/withdraw authorizer. Accepts a **revealed** secret (`proof == abi.encode(secret)`), returns true iff `hasher.commitmentOf(secret) == commitment`. Implements `IWithdrawVerifier`. NOT zero-knowledge. | **Live on Sepolia** as `withdrawVerifier` `0x5A6FD01d009989ff9E567fa2bC55253500ddbDB2`. Placeholder; see section 3. |
| `PoseidonT2` / `PoseidonT3` | `PoseidonT2.sol` / `PoseidonT3.sol` | Vendored Poseidon permutation libraries (t=2 single-input, t=3 two-input) over BN254. Called by `RateCommitmentHasher.commitmentOf`. | Deployed transitively with the hasher. Machine-generated field arithmetic; out of scope for hand review. |
| `RlnGroth16Verifier` (`Groth16Verifier`) | `RlnGroth16Verifier.sol` | snarkJS-exported Groth16 verifier for the deployed RLN membership artifacts. **NOT wired into `StakedReputationSet`** in this build; membership proofs are verified off-chain by the gateway against `circuits/rln/verification_key.json`. | Kept verbatim as provenance. Out of scope for hand review (generated; do not edit). |

### Trust / authority model (the honest asymmetry)

- `StakedReputationSet.register` / `initiateExit` / `withdraw` / `slash` are all
  **permissionless**. No `owner`, no admin. A member acts by cryptographic proof, never by
  `msg.sender` identity, so the member stays anonymous (`initiateExit` and `withdraw` are
  gated by `withdrawVerifier.verify`, not by caller; `slash` is gated by possession of a
  `(commitment, secret)` pair such that `hasher.commitmentOf(secret) == commitment`).
- Member `slash` is permissionless **because member over-spend is cryptographically
  provable**: reconstructing the identity secret from L+1 RLN shares yields exactly the
  authorization `slash` checks (`StakedReputationSet.slash`, line ~172). An honest member's
  secret is never exposed, so an honest member is never slashable.
- `GatewayRegistry.slash` is **owner-gated** (`onlyOwner` via `if (msg.sender != owner)
  revert NotOwner()`), the one deliberate asymmetry. Gateway misbehavior (censoring,
  tampering, downtime) is a subjective off-chain judgment, so slashing authority is a
  governance role rather than a cryptographic predicate. `register` / `initiateExit` /
  `withdraw` on the registry remain permissionless / operator-only.
- `GatewayRegistry` keys by operator **address** on purpose: a gateway serves a public
  egress IP and is not anonymous, so `msg.sender` keying is honest and lets the operator
  manage the bond with an ordinary key. `owner` is a single key; a DAO / timelock is future
  (section 3).

---

## 2. Written invariants an auditor should check

Several are already encoded as Foundry invariant tests
(`test/*.invariant.t.sol`, 4096 calls/run, both suites green).

**I1. `activeCount` == number of currently-active stakes.**
Active = staked and not exiting. Encoded:
`GatewayRegistryInvariantTest.invariant_activeCountMatchesLiveActiveStakes` and
`StakedReputationSetInvariantTest.invariant_activeCountMatchesActiveMembers`.
Source: `activeCount++` only in `register`; `activeCount--` in `initiateExit`, in
`withdraw` never (already decremented at exit), and in `slash` only `if (wasActive)`
where `wasActive = exitInitiatedAt == 0`. The `wasActive` guard is what prevents a
double-decrement when an already-exiting stake is slashed
(`StakedReputationSet.slash` / `GatewayRegistry.slash`).

**I2. Contract ETH balance == (live bonds) × BOND. No wei created or destroyed.**
Live = bond still held (active OR exiting). Encoded:
`invariant_ethEqualsSumOfLiveBonds` in both suites (`balance == ghostLive * BOND`).
Source: the only inflow is `register` which requires `msg.value == BOND`
(`if (msg.value != BOND) revert BadBond()`); the only outflows are `withdraw` and
`slash`, each paying exactly the recorded `amount == m.bond == BOND` and deleting the
record first. There is no other `payable` function and no `receive`/`fallback`, so ETH
cannot enter except through `register`.

**I3. A slashed or withdrawn stake cannot be re-withdrawn (delete-before-payout, CEI).**
Both `withdraw` and `slash` execute `delete members[commitment]` /
`delete stakes[operator]` **before** the `.call{value: amount}` payout. Any re-entrant or
subsequent `withdraw` / `slash` on the same key hits `if (bond == 0) revert NotMember()`
(resp. `NotStaked`), because `delete` zeroes `bond`. Confirmed by
`test_Slash_WorksDuringUnbonding_AndBlocksLaterWithdraw` (slash then later withdraw reverts
`NotMember`) and by the balance invariant.

**I4. The "exit to dodge slash" escape is closed.**
`slash` succeeds whether the stake is active or mid-unbonding: it only checks
`bond != 0`, never `exitInitiatedAt`. `initiateExit` leaves the active set but does NOT
return funds and does NOT delete the record, so the bond stays fully slashable for the
entire `UNBONDING` window. `withdraw` additionally requires
`block.timestamp >= exitInitiatedAt + UNBONDING`. The constructor enforces
`unbonding >= minUnbonding` so a misconfigured short window cannot open the escape.
Confirmed by `test_owner_can_slash_while_exiting` (registry) and
`test_Slash_WorksDuringUnbonding_AndBlocksLaterWithdraw` (set), and by the fuzz test
`testFuzz_slash_anyStakedPays(address,bool exiting)`.

**I5. BOND is the only accepted deposit.**
`register` reverts unless `msg.value == BOND` exactly (not `>=`, not `<=`). Both over- and
under-payment revert `BadBond`. No other function is `payable`. Confirmed by
`test_Register_RequiresExactBond` and `testFuzz_register_wrongBondReverts` (any
`value != BOND` reverts and leaves zero contract balance).

**I6. The onion is NEVER stored on chain.**
`GatewayRegistry` keys the stake by operator **address** and stores only
`{bond, index, exitInitiatedAt}` (`struct Stake`). There is no field, event, or argument
carrying an onion address anywhere in the contract. A v3 `.onion` is an ed25519 public key;
storing it would make the fleet publicly enumerable and permanently bind each onion to its
funding address. The onion→stake binding is an off-chain operator signature
(`bootnode/announce`), so a single stake can rotate across many onions.

**I7. Append-only index monotonicity.**
`nextIndex` only ever increments (`nextIndex++` in `register`); it is never reset or
decremented, even on withdraw/slash/re-register. A re-registered commitment gets a fresh
higher index. Confirmed by `test_Register_AppendOnlyIndex` and
`test_ReRegister_AfterWithdraw` (re-register yields index 1). This backs the off-chain
tree rebuild in `lib/root-provider.mjs`.

**I8. Membership leaf == the crypto side's rate commitment.**
`RateCommitmentHasher.commitmentOf(s) == Poseidon(2)([Poseidon(1)([s]), 8])` must equal
`poseidon-lite`'s `poseidon2([poseidon1([s]), 8n])`. If these drift, a reconstructed secret
would slash the wrong leaf (silent `BadSecret`). Pinned on-chain by `test/Poseidon.t.sol`
(five JS↔Solidity vectors) and `test_Slash_RateCommitmentLeaf_RevealedSecret_Pays`.

---

## 3. Known limitations / not-yet-real

- **`MockWithdrawVerifier` is a placeholder.** It accepts a REVEALED secret in calldata
  (`proof == abi.encode(secret)`), not a zero-knowledge proof, and it **ignores `context`**
  (the recipient-binding parameter). A production build swaps it for a real Groth16 exit
  verifier that (a) is zero-knowledge and (b) checks `context` to bind the proof to the
  exact action + recipient. The real verifier is **built** (T-DEV-1:
  `contracts/WithdrawVerifier.sol` + `contracts/WithdrawGroth16Verifier.sol`,
  `test/WithdrawVerifier.t.sol`) but the **live Sepolia `rln-v3` deployment still points at
  the mock** (`network/sepolia/contracts.json` `withdrawVerifier`); redeploying with the real
  one is part of the human-gated go-live (T-HARD-1 artifacts + `docs/GO-LIVE.md`). Until then,
  on Sepolia exit / withdraw authorization is "knowledge of the secret", and
  recipient-redirection protection is not actually enforced even though
  `StakedReputationSet.withdraw` computes and passes
  `context = keccak256("RGOE_WITHDRAW", commitment, recipient)`.
- **ZK artifacts come from an untrusted ceremony.** `circuits/rln/` was built with a local,
  untrusted phase-2 (two hard-coded entropy contributions + a fixed beacon;
  `circuits/rln/ARTIFACTS.md` "Trust / honesty note"). Fine for testnet. A real deployment
  needs a proper multi-party phase-2 and regenerated `rln_final.zkey` + verifier +
  `verification_key.json` together. Hardening this is task **T-HARD-1**.
- **RLN leaf-removal parity is unverified against an on-chain slash.** The off-chain tree
  rebuild `reconstructRoot` (`lib/root-provider.mjs`) removes leaves on
  `MemberExiting` / `MemberWithdrawn` / `MemberSlashed` events. That the JS reconstruction
  and an on-chain slash agree on which leaf leaves the set is task **T-DEV-2**
  (JS↔chain leaf-removal parity). The event-driven removal is unit-tested in JS
  (`lib/root-provider.selftest.mjs`) but not cross-checked against a live slash tx here.
- **`owner` is a single key.** `GatewayRegistry.owner` is one address with sole slash +
  ownership-transfer authority. `transferOwnership` is a plain single-step transfer (no
  two-step accept, no timelock). A DAO / timelock / fraud-proof verifier is a future drop-in
  (`StakedReputationSet` has no owner at all, so only the registry carries this risk).
- **Re-registration allowed.** A withdrawn or slashed commitment is `delete`d, so it can be
  re-registered (`test_ReRegister_AfterSlash`). Harmless for an append-only tree and a
  slashed secret is already public; add a burned-commitment set to forbid it outright.
- **No explicit reentrancy guard.** Safe today by construction (CEI + delete-before-call;
  section 4), but add a guard before mainnet as defense in depth (`contracts/README.md`).

---

## 4. Reentrancy / overflow / access-control walk-through

Every external function, why it is safe. Both `StakedReputationSet` (`SRS`) and
`GatewayRegistry` (`GR`) are solc `0.8.24`, so all arithmetic is checked (overflow/underflow
revert). No `unchecked` blocks exist in either contract.

**`register` (SRS `register(uint256 commitment)`, GR `register()`)** — permissionless,
`payable`.
- Access: none by design (anonymous member / permissionless operator).
- Deposit guard: `if (msg.value != BOND) revert BadBond()` (I5). Exact-match only.
- Duplicate guard: `if (_exists(...)) revert AlreadyStaked/AlreadyMember` where `_exists`
  tests `bond != 0`.
- Reentrancy: no external call. State writes (`stakes/members[...] = ...`, `activeCount++`,
  `nextIndex++`) then `emit`. Nothing to re-enter.
- Overflow: `activeCount++` / `nextIndex++` checked by 0.8; `nextIndex` is `uint64`,
  practically unreachable.

**`initiateExit` (SRS `initiateExit(commitment, proof)`, GR `initiateExit()`)** —
starts unbonding clock.
- Access: SRS is ZK-authorized — `if (!withdrawVerifier.verify(commitment, context, proof))
  revert BadProof()`, with `context = keccak256("RGOE_EXIT", commitment)`. GR is
  operator-only implicitly: it reads `stakes[msg.sender]` and reverts `NotStaked` if the
  caller has none, so a non-operator cannot exit another's stake.
- Preconditions: `bond != 0` (`NotStaked`/`NotMember`) and `exitInitiatedAt == 0`
  (`AlreadyExiting`).
- Effect: sets `exitInitiatedAt = uint64(block.timestamp)`, `activeCount--`. Bond NOT
  returned and record NOT deleted — this is what keeps it slashable (I4).
- Reentrancy: the only external call is the `staticcall`-shaped `withdrawVerifier.verify`
  (a `view` interface) and it runs BEFORE the state write; a malicious verifier can revert
  or lie but cannot re-enter to move funds (no funds move here). GR has no external call.
- Overflow: `activeCount--` cannot underflow because it is guarded by `bond != 0 &&
  exitInitiatedAt == 0`, i.e. the stake is currently counted in `activeCount` (I1). Verified
  by the invariant suite.

**`withdraw` (SRS `withdraw(commitment, recipient, proof)`, GR `withdraw(recipient)`)** —
time-locked payout. This is the CEI-critical path.
- Access: SRS re-verifies the proof against
  `context = keccak256("RGOE_WITHDRAW", commitment, recipient)` (`BadProof`). GR is
  operator-only via `stakes[msg.sender]`.
- Preconditions: `bond != 0` (`NotMember`/`NotStaked`), `exitInitiatedAt != 0`
  (`NotExiting`), and `block.timestamp >= exitInitiatedAt + UNBONDING` (`StillBonded`).
  The timelock arithmetic `uint256(exitInitiatedAt) + UNBONDING` is checked; widened to
  `uint256` so no `uint64` overflow.
- CEI ordering (the key point): read `amount = bond`, then **`delete` the record**, then
  `emit`, then `(bool ok, ) = recipient.call{value: amount}("")`, then
  `if (!ok) revert PayoutFailed()`. Because the record is deleted before the call, a
  re-entrant `withdraw` finds `bond == 0` and reverts `NotMember`/`NotStaked` (I3). No state
  is read after the call. The raw `.call` is the recommended ETH-transfer form; failure
  reverts the whole tx, so a rejecting recipient cannot strand the record in a half-deleted
  state (the `delete` is rolled back with the revert).
- `activeCount`: NOT touched here — it was already decremented at `initiateExit`. This is
  required for I1 (no double count).

**`slash` (SRS `slash(commitment, secret, receiver)`, GR `slash(operator, receiver)`)** —
burn bond to a receiver.
- Access: **SRS permissionless but cryptographically gated** —
  `if (hasher.commitmentOf(secret) != commitment) revert BadSecret()`. Authorization IS
  possession of a secret that hashes to the leaf; only a genuine over-spend reveals it.
  **GR owner-gated** — `if (msg.sender != owner) revert NotOwner()` first line.
- Precondition: `bond != 0` (`NotMember`/`NotStaked`).
- Works active or exiting: no `exitInitiatedAt` gate, closing the dodge (I4).
- CEI: `amount = bond`, capture `wasActive = exitInitiatedAt == 0`, **`delete`**,
  `if (wasActive) activeCount--`, `emit`, then `.call{value: amount}` + `PayoutFailed`
  check. Delete-before-payout again gives reentrancy safety (I3). `wasActive` guard prevents
  double-decrement of `activeCount` when slashing a mid-unbonding stake (I1).
- Overflow: `activeCount--` guarded by `wasActive` (only decrement when it was counted).
- SRS note: `hasher.commitmentOf` is an external `view` call to `RateCommitmentHasher`
  BEFORE any state change; a hostile hasher is a config-trust assumption, not a reentrancy
  vector (it cannot move funds and runs pre-delete).

**`transferOwnership` (GR only, `transferOwnership(address to)`)**
- Access: `if (msg.sender != owner) revert NotOwner()`.
- Effect: `emit OwnerTransferred(owner, to); owner = to`. Single-step (limitation, section
  3 — a fat-fingered `to`, incl. `address(0)`, would brick slashing; no zero-address check).
- No external call, no funds, no reentrancy surface.

**Views** (`isActive`/`isStaked`, `withdrawableAt`, `members`/`stakes`, `activeCount`,
`nextIndex`, `owner`, `BOND`, `UNBONDING`) are read-only and side-effect free.
`withdrawableAt` returns 0 for a non-existent or non-exiting key rather than reverting.

**Constructor guards (both):** `if (bond == 0) revert BadBond()`;
`if (unbonding < minUnbonding) revert UnbondingTooShort()`. `minUnbonding` is caller-supplied
so the operator pins the window to `F + E + C` (freshness + epoch + slash-confirmation) and
a too-short lock is rejected at deploy (`test_constructor_rejects_*`,
`test_Constructor_Rejects*`). GR `owner` defaults to `msg.sender` when passed `address(0)`.

---

## 5. Running the tests (fuzz + invariants)

Toolchain: Foundry (`forge 1.3.2` verified in this environment). No `forge install` needed —
the harness declares its own cheatcode interface in `test/Cheats.sol` / `test/FuzzHelpers.sol`
(this repo reserves `lib/` for Track 2's `.mjs` crypto, not Solidity deps; `foundry.toml`).

```
forge build
forge test                 # full suite: 53 tests, 7 suites, all green
forge test -vvv            # traces on failure
forge test --match-contract StakedReputationSetInvariantTest
forge snapshot             # gas snapshot
```

Fuzz + invariant depth is set inline, not in `foundry.toml`:

- Unit fuzz (`test/*.fuzz.t.sol`): Foundry default 256 runs per `testFuzz_*`.
- Invariants (`test/*.invariant.t.sol`) pin `/// forge-config: default.invariant.runs = 64`
  and `default.invariant.depth = 64` above each `invariant_*` function → 64 × 64 = 4096
  calls per invariant. Targets are registered without forge-std via `targetContracts()` /
  `targetSelectors()` returning the local `FuzzSelector` struct (ABI-shape match to
  `StdInvariant.FuzzSelector`; see `test/FuzzHelpers.sol`).

Last local run in this environment: **53 passed, 0 failed, 0 skipped**; both
`invariant_ethEqualsSumOfLiveBonds` and the `activeCount` invariants green at 4096 calls,
0 reverts.

Static analysis: run `slither .` if installed (see section 6). A `slither.config.json` is
committed at the repo root: it forces the Foundry framework (so solc 0.8.24 from
`foundry.toml` is used), excludes dependencies, and filters `node_modules`, `lib`, `test`,
and the machine-generated `RlnGroth16Verifier.sol` / `PoseidonT2.sol` / `PoseidonT3.sol`
(snarkJS/generated field arithmetic that would only produce noise).

---

## 6. Slither results

**slither was NOT run in this environment** — `command -v slither` found nothing and, per
task constraints, it was not installed. To run it:

```
pip install slither-analyzer
slither .
```

The committed `slither.config.json` is ready for that run (forces `compile_force_framework:
foundry`, `exclude_dependencies: true`, and `filter_paths` excluding tests + generated
verifier/Poseidon files). Expected hand-review posture going in: the in-scope contracts use
strict checks-effects-interactions with delete-before-payout on every `.call` (section 4),
so the common Slither high/medium detectors to scrutinize are `reentrancy-eth` /
`reentrancy-no-eth` (expected: none real — state is deleted before the external call) and
`arbitrary-send-eth` (expected: benign — `withdraw` sends to a proof-bound / operator-named
recipient, `slash` to a caller-named receiver, both by design). `low-level-calls` will fire
on the intentional `.call{value:}` payouts (informational). Populate this section with the
actual `slither . 2>&1 | tail` summary (high/medium counts, or "no high/medium") once run.
