// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// PaidAccessSetMock — a TEST DOUBLE for the T-FEAT-7 PaidAccessSet (docs/PAYMENTS.md Layer 1,
// docs/adr/0007-paid-access.md), the OPERATOR-INSERT-ONLY set: access is paid OFF chain (HTTP 402
// rails, x402 / MPP, handled by the registrar service) and the operator then inserts the buyer's
// rateCommitment here. This double implements the interface the off-chain half builds against
// faithfully enough for test/paid-access.selftest.mjs (the gateway's union of roots, the slasher's
// routing to the contract that holds the leaf, the client's leaf discovery, `rgoe leaves`). It is
// NOT the production contract: the real PaidAccessSet ships on branch ship/pay-contract
// (contracts/PaidAccessSet.sol) with its own Foundry suite; this mock exists so the JS half is
// testable before/without it and is kept only while that is useful. Do NOT deploy it anywhere real.
//
// What it mirrors exactly (because the JS depends on it):
//   - the on-chain incremental depth-20 Poseidon(2) tree of StakedReputationSet (T-DEV-9),
//     `currentRoot` at storage slot 3 (ROOT_STORAGE_SLOT) so LightClientRootProvider works
//     unchanged, zero-in-place removal, GROUP_ID = 1 zero value;
//   - the leaf = rateCommitment = Poseidon2(Poseidon1(identitySecret), limit) via the tiered
//     RateCommitmentHasher (`ICommitmentHasher.commitmentOf(secret, limit)`);
//   - `insert(commitment, limit)` / `insertBatch(..)` onlyOperator (no payable deposit, no
//     priceFor, no sweep, no exit/withdraw), an immutable admitted-tier table (`allowedLimits`,
//     `DEFAULT_LIMIT` = 8), `limitOf`, `leafCount`, `slash(commitment, secret, limit, receiver)` =
//     prove the secret, zero the leaf (no bond to burn), the events Inserted / Slashed, each
//     (commitment indexed, limit, index, root) — lib/root-provider.mjs reads them.
// `leafCount()` = total appended (nextIndex, slashed slots included), `liveCount()` = in the root — as in the real contract.

import {PoseidonT3} from "../contracts/PoseidonT3.sol";
import {ICommitmentHasher} from "../contracts/StakedReputationSet.sol";

contract PaidAccessSetMock {
    uint256 public constant DEFAULT_LIMIT = 8;
    uint256 public constant MAX_LIMIT = 65535;
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant GROUP_ID = 1;
    uint256 public constant ROOT_STORAGE_SLOT = 3;

    struct Leaf {
        uint64 index;   // append-only leaf index
        uint32 limit;   // the tier the leaf was bought at
        bool live;      // false once slashed
    }

    mapping(uint256 => Leaf) private _leaves; // commitment => Leaf   (slot 0)
    uint64 public nextIndex;                  // (slot 1)
    uint256 private _liveCount;               // (slot 2)
    uint256 public currentRoot;               // (slot 3 == ROOT_STORAGE_SLOT)

    uint256[TREE_DEPTH + 1] private _zeroes;
    mapping(uint256 => mapping(uint256 => uint256)) private _treeNode;

    mapping(uint256 => bool) private _admitted; // limit => admitted tier
    uint256[] private _allowedLimits;           // ascending, distinct

    address public immutable operator;
    ICommitmentHasher public immutable hasher;

    event Inserted(uint256 indexed commitment, uint256 limit, uint256 index, uint256 root);
    event Slashed(uint256 indexed commitment, uint256 limit, uint256 index, uint256 root);

    error BadLimit();
    error BadTierTable();
    error LengthMismatch();
    error AlreadyMember();
    error NotMember();
    error BadSecret();
    error NotOperator();

    /// @param _operator  who may insert (the registrar / operator key).
    /// @param _hasher    the tiered RateCommitmentHasher.
    /// @param limits     admitted tiers, ascending, distinct, each in [1, MAX_LIMIT].
    constructor(address _operator, ICommitmentHasher _hasher, uint256[] memory limits) {
        if (_operator == address(0)) revert NotOperator();
        if (limits.length == 0) revert BadTierTable();
        operator = _operator;
        hasher = _hasher;
        uint256 prev = 0;
        for (uint256 i = 0; i < limits.length; i++) {
            uint256 lim = limits[i];
            if (lim == 0 || lim > MAX_LIMIT) revert BadLimit();
            if (lim <= prev || _admitted[lim]) revert BadTierTable();
            _admitted[lim] = true;
            _allowedLimits.push(lim);
            prev = lim;
        }
        uint256 zero = uint256(keccak256(abi.encodePacked(GROUP_ID))) >> 8;
        _zeroes[0] = zero;
        for (uint256 i = 1; i <= TREE_DEPTH; i++) {
            zero = PoseidonT3.hash([zero, zero]);
            _zeroes[i] = zero;
        }
        currentRoot = zero;
    }

    // ---- tree (identical to StakedReputationSet._updateLeaf) -------------------------------------

    function _updateLeaf(uint256 index, uint256 value) internal {
        uint256 node = value;
        uint256 idx = index;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            _treeNode[level][idx] = node;
            uint256 left;
            uint256 right;
            if (idx & 1 == 0) {
                left = node;
                right = _nodeAt(level, idx + 1);
            } else {
                left = _nodeAt(level, idx - 1);
                right = node;
            }
            node = PoseidonT3.hash([left, right]);
            idx >>= 1;
        }
        currentRoot = node;
    }

    function _nodeAt(uint256 level, uint256 index) internal view returns (uint256) {
        uint256 v = _treeNode[level][index];
        return v == 0 ? _zeroes[level] : v;
    }

    // ---- views ------------------------------------------------------------------------------------

    function allowedLimits() external view returns (uint256[] memory) {
        return _allowedLimits;
    }

    /// Total leaves ever appended (== nextIndex; slashed slots still count, as in the real
    /// contract) — the figure the gateway logs against its floor. `liveCount()` = in the root now.
    function leafCount() external view returns (uint256) {
        return uint256(nextIndex);
    }

    function liveCount() external view returns (uint256) {
        return _liveCount;
    }

    function commitmentOf(uint256 secret, uint256 limit) external view returns (uint256) {
        return hasher.commitmentOf(secret, limit);
    }

    /// The tier a live leaf was bought at; 0 if unknown or slashed.
    function limitOf(uint256 commitment) external view returns (uint256) {
        Leaf storage l = _leaves[commitment];
        return l.live ? uint256(l.limit) : 0;
    }

    // ---- insert (operator only; the payment happened off chain) ------------------------------------

    /// Append `commitment` at tier `limit`. Only the operator (registrar) may call: the buyer paid
    /// over HTTP 402 rails and the registrar inserts the rateCommitment it was handed.
    function insert(uint256 commitment, uint256 limit) public {
        if (msg.sender != operator) revert NotOperator();
        if (!_admitted[limit]) revert BadLimit();
        if (_leaves[commitment].live) revert AlreadyMember();

        uint64 index = nextIndex++;
        _leaves[commitment] = Leaf({index: index, limit: uint32(limit), live: true});
        _liveCount++;
        _updateLeaf(index, commitment);
        emit Inserted(commitment, limit, index, currentRoot);
    }

    function insertBatch(uint256[] calldata commitments, uint256[] calldata limits) external {
        if (commitments.length != limits.length) revert LengthMismatch();
        for (uint256 i = 0; i < commitments.length; i++) insert(commitments[i], limits[i]);
    }

    // ---- slash ------------------------------------------------------------------------------------

    /// Over-spend: prove the secret behind a live leaf at its tier and zero it (access ends).
    /// No bond to burn: the price is already the operator's. `receiver` is accepted for signature
    /// parity with StakedReputationSet.slash (nothing is paid to it here).
    function slash(uint256 commitment, uint256 secret, uint256 limit, address receiver) external {
        Leaf storage l = _leaves[commitment];
        if (!l.live) revert NotMember();
        if (uint256(l.limit) != limit) revert BadLimit();
        if (hasher.commitmentOf(secret, limit) != commitment) revert BadSecret();
        receiver; // unused: nothing to pay out
        uint64 idx = l.index;
        l.live = false;
        _liveCount--;
        _updateLeaf(idx, _zeroes[0]);
        emit Slashed(commitment, limit, idx, currentRoot);
    }
}
