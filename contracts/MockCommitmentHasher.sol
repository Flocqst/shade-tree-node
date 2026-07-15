// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICommitmentHasher} from "./StakedReputationSet.sol";
import {PoseidonT2} from "./PoseidonT2.sol";

/// MockCommitmentHasher — the real, demo-grade commitment hasher for the PoC.
///
/// It is a *real* Poseidon implementation, not a stub: `commitmentOf(secret)` returns
/// `Poseidon(secret)` over the BN254 scalar field, using the vendored `PoseidonT2`
/// library (poseidon-solidity, t=2 / single-input Poseidon). This is the single-field
/// Poseidon that matches Semaphore/RLN-style identity commitments.
///
/// ============================ COMMITMENT SCHEME (MUST MATCH TRACK 2) ============================
/// commitment = Poseidon([secret])   over BN254 field
///              F = 21888242871839275222246405745257275088548364400416034343698204186575808495617
///
/// Track 2's `deriveCommitment(secret)` MUST produce the identical value so a
/// reconstructed secret slashes the correct leaf. The canonical JS match is:
///
///     import { poseidon1 } from "poseidon-lite";      // already a dependency
///     const commitment = poseidon1([secret]);         // == commitmentOf(secret) here
///
/// (equivalently circomlibjs `poseidon([secret])`). Verified test vectors, JS ==> Solidity:
///     poseidon1([1n])         == 18586133768512220936620570745912940619677854269274689475585506675881198879027
///     poseidon1([2n])         ==  8645981980787649023086883978738420856660271013038108762834452721572614684349
///     poseidon1([42n])        == 12326503012965816391338144612242952408728683609716147019497703475006801258307
///     poseidon1([123456789n]) ==  7110303097080024260800444665787206606103183587082596139871399733998958991511
/// test/Poseidon.t.sol asserts these on-chain outputs equal the JS values above.
/// ===============================================================================================
contract MockCommitmentHasher is ICommitmentHasher {
    /// BN254 scalar field. Inputs are reduced mod F inside PoseidonT2, so a secret >= F
    /// still hashes deterministically; keep JS secrets in [0, F) to avoid ambiguity.
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function commitmentOf(uint256 secret) external pure override returns (uint256) {
        return PoseidonT2.hash([secret]);
    }
}
