// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// StakedReputationSet: the on-chain admission gate for the reputation-gated onion
// egress. See docs/ONCHAIN.md for the full design and the anonymity argument. This
// is a REFERENCE implementation, unaudited, testnet-only. The ZK verifier and the
// commitment hasher are abstracted behind interfaces (below); wiring the real RLN
// artifacts is the remaining work.
//
// Semantics (docs/ONCHAIN.md, requirements R1-R5):
//   register    permissionless: post a fixed BOND for a Semaphore/RLN commitment.
//   initiateExit ZK-authorized: prove knowledge of the secret, start the unbonding
//                clock, leave the admission root. NOT keyed off msg.sender, so the
//                member stays anonymous (R1).
//   withdraw    ZK-authorized: after UNBONDING and if not slashed, pay the bond to a
//                caller-named fresh recipient (R2). Unlinkable fund-in vs fund-out.
//   slash       permissionless: whoever reconstructed the secret from an RLN
//                over-spend (in practice the gateway) claims the bond (R3).
//
// The bond stays fully slashable for the entire unbonding window, which is what makes
// "spam then instantly unstake" impossible (R4). UNBONDING must be >= F + E + C
// (freshness window + epoch + slash-confirmation margin); the contract enforces a
// caller-supplied lower bound so a misconfiguration cannot open that escape.
//
// The Merkle root itself is maintained off chain: members and their indices live in a
// mapping here and are emitted as events, and the gateway/clients rebuild the tree
// locally and verify their local root against the event log (docs/ROADMAP.md #2). A
// companion on-chain incremental-tree + root accessor can replace that later without
// changing this contract's admission/stake logic.

/// Verifies a ZK proof that the caller knows the identity secret behind `commitment`.
/// Used to authorize exit and withdrawal without revealing which member (R1/R2).
/// `context` binds the proof to this action (e.g. keccak(action, recipient)) so a
/// withdrawal authorization cannot be replayed for a different recipient.
interface IWithdrawVerifier {
    function verify(uint256 commitment, bytes32 context, bytes calldata proof) external view returns (bool);
}

/// Recomputes the identity commitment from a revealed secret, so `slash` can check
/// that a reconstructed secret really belongs to the commitment it claims (R3).
/// commitment == hash(secret) for the Semaphore/RLN identity scheme in use.
interface ICommitmentHasher {
    function commitmentOf(uint256 secret) external view returns (uint256);
}

contract StakedReputationSet {
    // ---- immutable parameters -------------------------------------------------

    uint256 public immutable BOND;      // fixed denomination; amounts never fingerprint (R1)
    uint256 public immutable UNBONDING; // exit time-lock in seconds (R4)

    IWithdrawVerifier public immutable withdrawVerifier;
    ICommitmentHasher public immutable hasher;

    // ---- membership state -----------------------------------------------------

    struct Member {
        uint256 bond;             // staked amount (== BOND while active); 0 once gone
        uint64  index;           // append-only leaf index, for off-chain tree rebuild
        uint64  exitInitiatedAt; // 0 while active; timestamp once exiting
    }

    mapping(uint256 => Member) public members; // commitment => Member
    uint64 public nextIndex;                    // append-only leaf counter
    uint256 public activeCount;                 // members currently staked

    // ---- events (off-chain tree + gateway root refresh) -----------------------

    event MemberRegistered(uint256 indexed commitment, uint64 indexed index);
    event MemberExiting(uint256 indexed commitment, uint64 exitInitiatedAt, uint64 withdrawableAt);
    event MemberWithdrawn(uint256 indexed commitment, address indexed recipient);
    event MemberSlashed(uint256 indexed commitment, address indexed receiver);

    error BadBond();
    error UnbondingTooShort();
    error AlreadyMember();
    error NotMember();
    error NotExiting();
    error AlreadyExiting();
    error StillBonded();
    error BadProof();
    error BadSecret();
    error PayoutFailed();

    /// @param bond        the fixed stake denomination.
    /// @param unbonding   exit time-lock; must be >= minUnbonding.
    /// @param minUnbonding lower bound = F + E + C (see docs/ONCHAIN.md). Passed in so
    ///                     the gateway operator pins it to their own epoch/freshness
    ///                     parameters and the contract refuses an unsafe value.
    constructor(
        uint256 bond,
        uint256 unbonding,
        uint256 minUnbonding,
        IWithdrawVerifier _withdrawVerifier,
        ICommitmentHasher _hasher
    ) {
        if (bond == 0) revert BadBond();
        if (unbonding < minUnbonding) revert UnbondingTooShort();
        BOND = bond;
        UNBONDING = unbonding;
        withdrawVerifier = _withdrawVerifier;
        hasher = _hasher;
    }

    // ---- register (R1) --------------------------------------------------------

    /// Permissionless. Post BOND for a commitment. The commitment's secret is
    /// generated locally by the member and never revealed here, so registering
    /// reveals nothing but a pseudonymous leaf and a fixed stake amount. Fund this
    /// from a Layer-0 shielded (e.g. Railgun) fresh address for max anonymity.
    function register(uint256 commitment) external payable {
        if (msg.value != BOND) revert BadBond();
        if (_exists(commitment)) revert AlreadyMember();

        uint64 index = nextIndex++;
        members[commitment] = Member({bond: BOND, index: index, exitInitiatedAt: 0});
        activeCount++;
        emit MemberRegistered(commitment, index);
    }

    // ---- exit + withdraw (R2, R4) --------------------------------------------

    /// ZK-authorized. Start the unbonding clock and leave the admission root. The
    /// bond remains slashable for the whole UNBONDING window. Authorized by a proof
    /// of knowledge of the secret, not by msg.sender, so the exiting member stays
    /// anonymous. `context` here is fixed to the exit action.
    function initiateExit(uint256 commitment, bytes calldata proof) external {
        Member storage m = members[commitment];
        if (m.bond == 0) revert NotMember();
        if (m.exitInitiatedAt != 0) revert AlreadyExiting();

        bytes32 context = keccak256(abi.encodePacked("RGOE_EXIT", commitment));
        if (!withdrawVerifier.verify(commitment, context, proof)) revert BadProof();

        m.exitInitiatedAt = uint64(block.timestamp);
        activeCount--; // no longer in the admission set, though still slashable
        emit MemberExiting(commitment, m.exitInitiatedAt, uint64(block.timestamp + UNBONDING));
    }

    /// ZK-authorized. After UNBONDING elapses and if not slashed, pay BOND to a
    /// caller-named fresh recipient. Binding the recipient into the proof context
    /// stops a captured proof from being redirected. Unlinkable to the register tx
    /// at the address-graph level (only the pseudonymous commitment is common).
    function withdraw(uint256 commitment, address recipient, bytes calldata proof) external {
        Member storage m = members[commitment];
        if (m.bond == 0) revert NotMember();
        if (m.exitInitiatedAt == 0) revert NotExiting();
        if (block.timestamp < uint256(m.exitInitiatedAt) + UNBONDING) revert StillBonded();

        bytes32 context = keccak256(abi.encodePacked("RGOE_WITHDRAW", commitment, recipient));
        if (!withdrawVerifier.verify(commitment, context, proof)) revert BadProof();

        uint256 amount = m.bond;
        delete members[commitment];
        emit MemberWithdrawn(commitment, recipient);

        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }

    // ---- slash (R3) -----------------------------------------------------------

    /// Permissionless. The gateway reconstructs a proven over-spender's secret from
    /// L+1 RLN shares (docs/ONCHAIN.md), then calls this. Possession of a valid
    /// (commitment, secret) pair is the authorization: it only exists after a genuine
    /// rate violation, so honest members are never slashable. Works whether the member
    /// is active or mid-unbonding, which is what closes the "exit to dodge slash"
    /// escape (R4). Pays the bond to `receiver` (the gateway / a treasury).
    function slash(uint256 commitment, uint256 secret, address receiver) external {
        Member storage m = members[commitment];
        if (m.bond == 0) revert NotMember();
        if (hasher.commitmentOf(secret) != commitment) revert BadSecret();

        uint256 amount = m.bond;
        bool wasActive = m.exitInitiatedAt == 0;
        delete members[commitment];
        if (wasActive) activeCount--;
        emit MemberSlashed(commitment, receiver);

        (bool ok, ) = receiver.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }

    // ---- views ---------------------------------------------------------------

    function isActive(uint256 commitment) external view returns (bool) {
        Member storage m = members[commitment];
        return m.bond != 0 && m.exitInitiatedAt == 0;
    }

    function withdrawableAt(uint256 commitment) external view returns (uint256) {
        Member storage m = members[commitment];
        if (m.bond == 0 || m.exitInitiatedAt == 0) return 0;
        return uint256(m.exitInitiatedAt) + UNBONDING;
    }

    function _exists(uint256 commitment) internal view returns (bool) {
        return members[commitment].bond != 0;
    }
}
