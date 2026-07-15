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
/// For the PoC this verifier instead accepts a REVEALED secret: `proof == abi.encode(secret)`
/// and it authorizes iff `hasher.commitmentOf(secret) == commitment` — i.e. knowledge of
/// the secret authorizes the action. This is NOT zero-knowledge: the secret is exposed in
/// calldata. That is acceptable only because the demo runs against a local anvil and the
/// point is to exercise the register / exit / time-locked withdraw / slash state machine,
/// not the ZK circuit. A production build swaps this for the RLN/Semaphore withdraw
/// verifier and stops revealing the secret.
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
