// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// GatewayRegistry: an OPTIONAL on-chain stake that backs a gateway operator. It is the
// gateway-side dual of StakedReputationSet (which stakes *members*), but deliberately
// minimal and deliberately optional (bootnode admission defaults to `open`; see
// bootnode/README).
//
// WHAT THIS CONTRACT DOES NOT DO: it never stores an onion address. A v3 .onion IS an
// ed25519 public key (lib/directory.mjs onionToPubkey), so putting it on chain would make
// the whole fleet publicly enumerable and permanently bind each onion to the address that
// paid for it — the exact property Tor's blinded HSDir descriptors exist to destroy. The
// onion lives ONLY in the signed announce the operator hands the bootnode. The binding of
// "this onion is backed by this stake" is an off-chain operator signature (bootnode/announce),
// so the onion stays off chain and a single stake can rotate across many onions over time.
//
// WHAT IT DOES DO: hold a slashable bond keyed to an operator ADDRESS. A gateway operator is
// not anonymous — it serves a public egress IP anyone using it can observe ("knowing your own
// exit is not the threat", docs/ROADMAP.md #3) — so keying the stake to msg.sender is honest
// and lets the operator manage it with an ordinary key. The bond does two jobs: skin-in-the-game
// the bootnode/clients can require (admission = `stake`), and a natural home for the on-chain
// funds a gateway needs anyway, since the gateway is the party that pays gas to slash member
// over-spenders in StakedReputationSet.
//
// Semantics:
//   register     permissionless: post a fixed BOND. msg.sender is the operator of record.
//   initiateExit operator-only: start the unbonding clock; leave the active set but stay
//                slashable for the whole window, so a gateway cannot misbehave then instantly
//                unstake to dodge a slash.
//   withdraw     operator-only: after UNBONDING and if not slashed, return the bond.
//   slash        owner-only (governance). The one honest asymmetry vs the member slash: a member
//                over-spend is cryptographically provable (L+1 RLN shares reconstruct the secret),
//                so StakedReputationSet.slash is permissionless. Gateway misbehavior (censoring,
//                tampering, downtime) is a subjective off-chain judgment, so slashing authority is
//                a governance role here. Swapping `owner` for a DAO or a fraud-proof verifier is a
//                drop-in change; the stake/exit logic does not depend on who holds it.
//
// REFERENCE implementation, unaudited, testnet-only.

contract GatewayRegistry {
    // ---- immutable parameters -------------------------------------------------

    uint256 public immutable BOND;      // fixed stake denomination
    uint256 public immutable UNBONDING; // exit time-lock in seconds
    address public owner;               // slashing + owner-transfer authority (governance)

    // ---- operator state -------------------------------------------------------

    struct Stake {
        uint256 bond;             // staked amount (== BOND while active); 0 once gone
        uint64  index;           // append-only index, for off-chain set rebuild
        uint64  exitInitiatedAt; // 0 while active; timestamp once exiting
    }

    mapping(address => Stake) public stakes; // operator => Stake
    uint64 public nextIndex;                  // append-only counter
    uint256 public activeCount;               // operators currently staked and not exiting

    // ---- events (off-chain set rebuild + bootnode/client refresh) -------------

    event GatewayStaked(address indexed operator, uint64 index);
    event GatewayExiting(address indexed operator, uint64 exitInitiatedAt, uint64 withdrawableAt);
    event GatewayWithdrawn(address indexed operator, address indexed recipient);
    event GatewaySlashed(address indexed operator, address indexed receiver);
    event OwnerTransferred(address indexed from, address indexed to);

    error BadBond();
    error UnbondingTooShort();
    error AlreadyStaked();
    error NotStaked();
    error NotExiting();
    error AlreadyExiting();
    error StillBonded();
    error NotOwner();
    error PayoutFailed();

    /// @param bond         the fixed stake denomination.
    /// @param unbonding    exit time-lock; must be >= minUnbonding.
    /// @param minUnbonding lower bound the operator pins to their slash-window policy, so a
    ///                     misconfigured short lock is rejected on deploy.
    /// @param _owner       slashing / governance authority (address(0) => deployer).
    constructor(uint256 bond, uint256 unbonding, uint256 minUnbonding, address _owner) {
        if (bond == 0) revert BadBond();
        if (unbonding < minUnbonding) revert UnbondingTooShort();
        BOND = bond;
        UNBONDING = unbonding;
        owner = _owner == address(0) ? msg.sender : _owner;
    }

    // ---- register -------------------------------------------------------------

    /// Permissionless. Post BOND; msg.sender becomes the operator of record. The onion(s)
    /// this stake will back are declared off chain, in the signed announce to the bootnode.
    function register() external payable {
        if (msg.value != BOND) revert BadBond();
        if (_exists(msg.sender)) revert AlreadyStaked();

        uint64 index = nextIndex++;
        stakes[msg.sender] = Stake({bond: BOND, index: index, exitInitiatedAt: 0});
        activeCount++;
        emit GatewayStaked(msg.sender, index);
    }

    // ---- exit + withdraw ------------------------------------------------------

    /// Operator-only. Start the unbonding clock and leave the active set. Stays slashable
    /// until UNBONDING elapses.
    function initiateExit() external {
        Stake storage s = stakes[msg.sender];
        if (s.bond == 0) revert NotStaked();
        if (s.exitInitiatedAt != 0) revert AlreadyExiting();

        s.exitInitiatedAt = uint64(block.timestamp);
        activeCount--;
        emit GatewayExiting(msg.sender, s.exitInitiatedAt, uint64(block.timestamp + UNBONDING));
    }

    /// Operator-only. After UNBONDING and if not slashed, return BOND to `recipient`.
    function withdraw(address recipient) external {
        Stake storage s = stakes[msg.sender];
        if (s.bond == 0) revert NotStaked();
        if (s.exitInitiatedAt == 0) revert NotExiting();
        if (block.timestamp < uint256(s.exitInitiatedAt) + UNBONDING) revert StillBonded();

        uint256 amount = s.bond;
        delete stakes[msg.sender];
        emit GatewayWithdrawn(msg.sender, recipient);

        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }

    // ---- slash (governance) ---------------------------------------------------

    /// Owner-only. Slash a misbehaving operator and pay its bond to `receiver`. Works whether
    /// the operator is active or mid-unbonding, closing the "exit to dodge slash" escape.
    function slash(address operator, address receiver) external {
        if (msg.sender != owner) revert NotOwner();
        Stake storage s = stakes[operator];
        if (s.bond == 0) revert NotStaked();

        uint256 amount = s.bond;
        bool wasActive = s.exitInitiatedAt == 0;
        delete stakes[operator];
        if (wasActive) activeCount--;
        emit GatewaySlashed(operator, receiver);

        (bool ok, ) = receiver.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }

    function transferOwnership(address to) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    // ---- views ----------------------------------------------------------------

    /// True iff staked and not exiting — the exact condition the bootnode/clients use to
    /// decide an operator's stake is live.
    function isStaked(address operator) external view returns (bool) {
        Stake storage s = stakes[operator];
        return s.bond != 0 && s.exitInitiatedAt == 0;
    }

    function withdrawableAt(address operator) external view returns (uint256) {
        Stake storage s = stakes[operator];
        if (s.bond == 0 || s.exitInitiatedAt == 0) return 0;
        return uint256(s.exitInitiatedAt) + UNBONDING;
    }

    function _exists(address operator) internal view returns (bool) {
        return stakes[operator].bond != 0;
    }
}
