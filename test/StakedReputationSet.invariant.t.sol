// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Invariant test for StakedReputationSet. A handler drives random register / initiateExit /
// withdraw / slash / warp sequences over a fixed pool of (secret, rate-commitment) pairs and
// tracks the expected state in ghost counters. After every call Foundry re-checks:
//
//   * activeCount always equals the number of currently-active members;
//   * the contract's ETH balance always equals the sum of live bonds — no wei created or
//     destroyed across the register/exit/withdraw/slash lifecycle.
//
// No forge-std: `targetContracts()` / `targetSelectors()` are implemented directly.

import {Cheats} from "./Cheats.sol";
import {FuzzSelector} from "./FuzzHelpers.sol";
import {StakedReputationSet, IWithdrawVerifier, ICommitmentHasher} from "../contracts/StakedReputationSet.sol";
import {RateCommitmentHasher} from "../contracts/RateCommitmentHasher.sol";
import {MockWithdrawVerifier} from "../contracts/MockWithdrawVerifier.sol";

contract SetHandler is Cheats {
    StakedReputationSet public set;
    RateCommitmentHasher public hasher;
    MockWithdrawVerifier public verifier;

    uint256 public constant BOND = 0.01 ether;
    uint256 public constant UNBONDING = 300;
    uint256 public constant MIN_UNBONDING = 270;

    address constant SINK = address(0x5151); // EOA payout sink (withdraw recipient + slash receiver)

    // Fixed pool of identity secrets and their pinned rate commitments (the tree leaves).
    uint256[5] public secrets;
    uint256[5] public commits;

    uint256 public ghostActive; // active members
    uint256 public ghostLive;   // bond still held (active or exiting)

    constructor() {
        hasher = new RateCommitmentHasher();
        verifier = new MockWithdrawVerifier(ICommitmentHasher(address(hasher)));
        set = new StakedReputationSet(
            BOND,
            UNBONDING,
            MIN_UNBONDING,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );
        for (uint256 i = 0; i < 5; i++) {
            uint256 secret = 1_000 + i; // distinct, small secrets => distinct leaves
            secrets[i] = secret;
            commits[i] = hasher.commitmentOf(secret);
        }
        vm.deal(address(this), 1_000_000 ether);
    }

    function _pick(uint256 seed) internal view returns (uint256 secret, uint256 commit) {
        uint256 i = seed % 5;
        return (secrets[i], commits[i]);
    }

    function _proof(uint256 secret) internal pure returns (bytes memory) {
        return abi.encode(secret);
    }

    function register(uint256 seed) external {
        (, uint256 commit) = _pick(seed);
        (uint256 bond,,) = set.members(commit);
        if (bond != 0) return; // AlreadyMember

        vm.deal(address(this), BOND);
        set.register{value: BOND}(commit);
        ghostActive++;
        ghostLive++;
    }

    function initiateExit(uint256 seed) external {
        (uint256 secret, uint256 commit) = _pick(seed);
        (uint256 bond,, uint64 exitAt) = set.members(commit);
        if (bond == 0 || exitAt != 0) return;

        set.initiateExit(commit, _proof(secret));
        ghostActive--;
    }

    function withdraw(uint256 seed) external {
        (uint256 secret, uint256 commit) = _pick(seed);
        (uint256 bond,, uint64 exitAt) = set.members(commit);
        if (bond == 0 || exitAt == 0) return;
        if (block.timestamp < uint256(exitAt) + UNBONDING) return; // StillBonded

        set.withdraw(commit, SINK, _proof(secret));
        ghostLive--;
    }

    function slash(uint256 seed) external {
        (uint256 secret, uint256 commit) = _pick(seed);
        (uint256 bond,, uint64 exitAt) = set.members(commit);
        if (bond == 0) return;

        bool wasActive = exitAt == 0;
        set.slash(commit, secret, SINK);
        if (wasActive) ghostActive--;
        ghostLive--;
    }

    function warp(uint256 dt) external {
        dt = dt % (2 * UNBONDING + 1);
        vm.warp(block.timestamp + dt);
    }
}

contract StakedReputationSetInvariantTest is Cheats {
    SetHandler handler;

    function setUp() public {
        handler = new SetHandler();
    }

    function targetContracts() public view returns (address[] memory addrs) {
        addrs = new address[](1);
        addrs[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory sel) {
        sel = new FuzzSelector[](1);
        bytes4[] memory s = new bytes4[](5);
        s[0] = SetHandler.register.selector;
        s[1] = SetHandler.initiateExit.selector;
        s[2] = SetHandler.withdraw.selector;
        s[3] = SetHandler.slash.selector;
        s[4] = SetHandler.warp.selector;
        sel[0] = FuzzSelector({addr: address(handler), selectors: s});
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    function invariant_activeCountMatchesActiveMembers() public view {
        assertEq(
            handler.set().activeCount(),
            handler.ghostActive(),
            "activeCount != number of active members"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    function invariant_ethEqualsSumOfLiveBonds() public view {
        assertEq(
            address(handler.set()).balance,
            handler.ghostLive() * handler.BOND(),
            "contract ETH != sum of live bonds"
        );
    }
}
