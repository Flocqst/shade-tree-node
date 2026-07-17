// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICommitmentHasher} from "./StakedReputationSet.sol";
import {PoseidonT2} from "./PoseidonT2.sol";
import {PoseidonT3} from "./PoseidonT3.sol";

/// RateCommitmentHasher — the real, demo-grade commitment hasher for the RLN PoC.
///
/// It is a *real* Poseidon implementation, not a stub. `commitmentOf(identitySecret)`
/// returns the RLN **rate commitment** (the Merkle tree leaf), computed over the BN254
/// scalar field exactly as `circom-rln`'s `rln.circom` does it:
///
///     identityCommitment = Poseidon(1)([ identitySecret ])            // t=2 / single-input
///     rateCommitment     = Poseidon(2)([ identityCommitment, K ])     // t=3 / two-input   <-- leaf
///
/// with the protocol-pinned per-member message limit `K = userMessageLimit = 8`.
///
/// This is the value stored as the membership leaf in `StakedReputationSet`, so a
/// slash — which reveals the member's `identitySecret` — recomputes exactly this and
/// matches it against the stored leaf. If this formula drifts from the circuit /
/// `rlnjs` side, a genuine over-spender's reconstructed secret would fail to slash the
/// correct leaf (silent BadSecret). See circuits/rln/ARTIFACTS.md for the confirmed
/// leaf formula and Phase-0 gate.
///
/// ============================ COMMITMENT SCHEME (MUST MATCH THE CRYPTO SIDE) ============================
/// rateCommitment = Poseidon(2)([ Poseidon(1)([identitySecret]), 8 ])   over BN254 field
///                  F = 21888242871839275222246405745257275088548364400416034343698204186575808495617
///
/// The canonical JS match (poseidon-lite is already a repo dependency):
///
///     import { poseidon1, poseidon2 } from "poseidon-lite";
///     const rateCommitment = poseidon2([ poseidon1([identitySecret]), 8n ]);  // == commitmentOf(identitySecret)
///
/// (equivalently circomlibjs `poseidon([poseidon([s]), 8n])`). Verified test vectors,
/// JS ==> Solidity (see test/Poseidon.t.sol which asserts these on-chain):
///     commitmentOf(1)         == 19891105629297951594670588741444296361737921464595154400690791765679348608752
///     commitmentOf(2)         ==   829125768753819539800244880652039674283559009741491044486206649483843818383
///     commitmentOf(42)        == 18761753399903396742513213281650676703493682377645661572914919902014839614171
///     commitmentOf(111)       == 11302006078516901731073162965056551612114122314181142374993834332168998510316
///     commitmentOf(123456789) == 21329507788392969599237625293681982274847848071789066949605792135001356234277
/// =======================================================================================================
contract RateCommitmentHasher is ICommitmentHasher {
    /// BN254 scalar field. Inputs are reduced mod F inside the Poseidon libraries, so a
    /// secret >= F still hashes deterministically; keep JS secrets in [0, F) to avoid ambiguity.
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Protocol per-member message limit (RLN `userMessageLimit`), the second Poseidon(2)
    /// input. Pinned to 8 across the circuit, rlnjs registration, and this contract.
    uint256 public constant K = 8;

    /// @return rateCommitment = Poseidon(2)([ Poseidon(1)([identitySecret]), K ]).
    function commitmentOf(uint256 identitySecret) external pure override returns (uint256) {
        uint256 identityCommitment = PoseidonT2.hash([identitySecret]);
        return PoseidonT3.hash([identityCommitment, K]);
    }
}
