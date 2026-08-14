// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWithdrawVerifier} from "./StakedReputationSet.sol";
import {WithdrawGroth16Verifier} from "./WithdrawGroth16Verifier.sol";
import {PoseidonT3} from "./PoseidonT3.sol";

/// WithdrawVerifier — the REAL zero-knowledge exit-auth verifier for
/// `StakedReputationSet.initiateExit` / `withdraw` (ship-plan T-DEV-1). Replaces
/// `MockWithdrawVerifier` (which authorized by REVEALING the identity secret in
/// calldata) with a genuine Groth16 proof of knowledge of the identity secret behind
/// a membership leaf, bound to the action. The secret is never revealed.
///
/// ================================ HOW IT MAPS ================================
/// The membership leaf stored in `StakedReputationSet` is the RLN **rate commitment**
///     commitment = Poseidon(2)([ Poseidon(1)([identitySecret]), K ])          (K = 8)
/// (see RateCommitmentHasher / circuits/rln/ARTIFACTS.md).
///
/// The `withdraw` circuit (circom-rln) proves knowledge of `identitySecret` such that
/// its public output equals the inner identity commitment, and binds a public
/// `address` field element:
///     public signals  _pubSignals = [ identityCommitment, address ]
///     identityCommitment = Poseidon(1)([ identitySecret ])
/// It does NOT itself hash to the rate commitment — so this wrapper closes that gap by
/// recomputing the leaf from the circuit's identity-commitment output:
///
///   verify(commitment, context, proof):
///     1. decode proof -> (a, b, c, identityCommitment)
///     2. addr = uint256(context) % FIELD                      // bind the action
///     3. require Groth16.verifyProof(a, b, c, [identityCommitment, addr])
///     4. require Poseidon(2)([identityCommitment, K]) == commitment   // tie to the leaf
///
/// Step 2 binds the proof to THIS action (exit vs. withdraw-to-a-specific-recipient):
/// `context` is the `keccak256` the contract computes, reduced into the BN254 scalar
/// field and fed to the circuit's public `address` input. A prover therefore produces
/// a DISTINCT proof per action; a proof made for the exit context is not valid calldata
/// for a `withdraw`, and a withdraw proof is bound to the exact recipient. Step 4 ties
/// the identity-commitment the circuit reveals to the member's registered leaf, so a
/// valid proof for identity X cannot authorize actions on member Y's leaf.
///
/// `verify` returns FALSE (never reverts) on any bad/tampered/malformed proof, so the
/// caller sees a clean `BadProof` revert — matching the `IWithdrawVerifier` contract and
/// the mock's behavior. The underlying snarkJS `verifyProof` likewise returns false
/// (rather than reverting) for an invalid proof or an out-of-field public signal.
/// ============================================================================
///
/// TESTNET-ONLY / UNTRUSTED SETUP: the wrapped `WithdrawGroth16Verifier` embeds a VK
/// from circom-rln's DEV phase-2 setup (untrusted; two hard-coded contributions + a
/// fixed beacon), NOT a real multi-party ceremony. This is genuine on-chain ZK
/// verification, but it is only trustworthy for TESTNET until ship-plan T-HARD-1 runs a
/// proper ceremony and re-generates `withdraw_final.zkey` + this verifier as a set. See
/// circuits/rln/ARTIFACTS.md.
contract WithdrawVerifier is IWithdrawVerifier {
    /// BN254 scalar field. `context` is reduced mod FIELD before it is used as the
    /// circuit's public `address` input (a keccak256 can exceed the field).
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// RLN per-member message limit (userMessageLimit); the second Poseidon(2) input of
    /// the rate commitment. Pinned to 8 across the circuit, rlnjs, and RateCommitmentHasher.
    uint256 public constant K = 8;

    /// The exact number of ABI-encoded words a well-formed `proof` occupies:
    /// uint256[2] a (2) + uint256[2][2] b (4) + uint256[2] c (2) + uint256 idComm (1) = 9.
    uint256 private constant PROOF_LEN = 9 * 32;

    WithdrawGroth16Verifier public immutable groth16;

    constructor(WithdrawGroth16Verifier _groth16) {
        groth16 = _groth16;
    }

    /// @param commitment the membership leaf (RLN rate commitment) being acted on.
    /// @param context    action binding (keccak256 the contract computed); reduced into
    ///                   the field and required to equal the proof's public `address`.
    /// @param proof      abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c,
    ///                   uint256 identityCommitment). `identityCommitment` is the
    ///                   circuit's public output = Poseidon(1)([identitySecret]).
    /// @return true iff the Groth16 proof verifies for [identityCommitment, addr] AND
    ///         Poseidon(2)([identityCommitment, K]) == commitment.
    function verify(uint256 commitment, bytes32 context, bytes calldata proof)
        external
        view
        override
        returns (bool)
    {
        // Malformed calldata -> clean false (so StakedReputationSet reverts BadProof).
        if (proof.length != PROOF_LEN) return false;

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256 identityCommitment) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2], uint256));

        // Bind the action into the circuit's public `address` input.
        uint256 addr = uint256(context) % FIELD;
        uint256[2] memory pubSignals = [identityCommitment, addr];

        // The Groth16 proof must be valid for exactly these public signals.
        if (!groth16.verifyProof(a, b, c, pubSignals)) return false;

        // ...and the identity commitment the circuit reveals must reconstruct THIS leaf.
        if (PoseidonT3.hash([identityCommitment, K]) != commitment) return false;

        return true;
    }
}
