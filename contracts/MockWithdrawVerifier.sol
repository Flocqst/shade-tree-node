// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWithdrawVerifier, ICommitmentHasher} from "./StakedReputationSet.sol";

/// MockWithdrawVerifier — the demo authorization checker for initiateExit / withdraw.
///
/// ============================== DEMO FIDELITY — READ THIS ==============================
/// In production, `proof` is a ZERO-KNOWLEDGE proof of knowledge of the identity secret
/// behind `commitment`, bound to `context` (so a withdraw authorization cannot be
/// replayed against a different recipient). It reveals NOTHING about the secret.
///
/// For the PoC this verifier instead accepts a REVEALED `identitySecret`:
/// `proof == abi.encode(identitySecret)` and it authorizes iff
/// `hasher.commitmentOf(identitySecret) == commitment`. Because the hasher now returns the
/// RLN **rate commitment** (`Poseidon(2)([ Poseidon(1)([identitySecret]), 8 ])`) and the
/// membership leaf is that same rate commitment, revealing the `identitySecret` behind a
/// leaf still authorizes initiateExit / withdraw for that member — the recompute stays
/// coherent with the new leaf formula. This is NOT zero-knowledge: the secret is exposed
/// in calldata. That is acceptable only because the demo runs against a local anvil and the
/// point is to exercise the register / exit / time-locked withdraw / slash state machine,
/// not the ZK circuit. A production build swaps this for the RLN/Semaphore withdraw
/// verifier (real Groth16 exit-auth is a later step) and stops revealing the secret.
///
/// `context` is currently IGNORED (the demo's authorization is pure secret-knowledge, and
/// anyone with the secret can already act on the leaf, so recipient-binding buys nothing
/// here). A real verifier MUST check `context` to bind the proof to the exact action +
/// recipient. This is called out so the seam is honest, per docs/ONCHAIN.md.
/// =====================================================================================
contract MockWithdrawVerifier is IWithdrawVerifier {
    ICommitmentHasher public immutable hasher;

    constructor(ICommitmentHasher _hasher) {
        hasher = _hasher;
    }

    /// @dev proof = abi.encode(uint256 secret). Returns true iff the secret hashes to
    ///      `commitment`. Returns false (rather than reverting) on a malformed proof so
    ///      the caller sees a clean BadProof, per the IWithdrawVerifier contract.
    function verify(uint256 commitment, bytes32 /*context*/, bytes calldata proof)
        external
        view
        override
        returns (bool)
    {
        if (proof.length != 32) return false;
        uint256 secret = abi.decode(proof, (uint256));
        return hasher.commitmentOf(secret) == commitment;
    }
}
