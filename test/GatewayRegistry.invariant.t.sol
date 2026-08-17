// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Invariant test for GatewayRegistry. A handler performs random register / initiateExit /
// withdraw / slash / warp sequences (driven by Foundry's invariant fuzzer) while tracking
// the expected state in ghost counters. After every call Foundry re-checks:
//
//   * activeCount always equals the number of currently-active (staked, not-exiting) stakes;
//   * the contract's ETH balance always equals the sum of live bonds — no wei is ever
//     created or destroyed by the stake lifecycle.
//
// No forge-std: target registration is done by implementing `targetContracts()` /
// `targetSelectors()` directly, which Foundry reads off the test contract by ABI shape.

import {Cheats} from "./Cheats.sol";
import {FuzzSelector} from "./FuzzHelpers.sol";
import {GatewayRegistry} from "../contracts/GatewayRegistry.sol";

/// Drives the registry and keeps ghost state in sync. Every action guards its preconditions
/// (mirroring the contract) so it only mutates ghosts when the underlying call succeeds.
contract GatewayHandler is Cheats {
    GatewayRegistry public reg;

    uint256 public constant BOND = 0.01 ether;
    uint256 public constant UNBONDING = 300;
    uint256 public constant MIN_UNBONDING = 270;

    address constant SINK = address(0x5151); // EOA payout sink (withdraw + slash)

    // A small, fixed operator pool so sequences collide and re-register on the same keys.
    address[5] public actors;

    // Ghost state, reconstructed independently of the contract.
    uint256 public ghostActive; // staked and not exiting
    uint256 public ghostLive;   // bond still held (active or exiting)

    constructor() {
        // owner == this handler, so `slash` calls need no prank.
        reg = new GatewayRegistry(BOND, UNBONDING, MIN_UNBONDING, address(this));
        for (uint160 i = 0; i < 5; i++) {
            actors[i] = address(uint160(0xA000) + i);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function register(uint256 seed) external {
        address op = _actor(seed);
        (uint256 bond,,) = reg.stakes(op);
        if (bond != 0) return; // AlreadyStaked would revert

        vm.deal(op, BOND);
        vm.prank(op);
        reg.register{value: BOND}();
        ghostActive++;
        ghostLive++;
    }

    function initiateExit(uint256 seed) external {
        address op = _actor(seed);
        (uint256 bond,, uint64 exitAt) = reg.stakes(op);
        if (bond == 0 || exitAt != 0) return;

        vm.prank(op);
        reg.initiateExit();
        ghostActive--;
    }

    function withdraw(uint256 seed) external {
        address op = _actor(seed);
        (uint256 bond,, uint64 exitAt) = reg.stakes(op);
        if (bond == 0 || exitAt == 0) return;
        if (block.timestamp < uint256(exitAt) + UNBONDING) return; // StillBonded

        vm.prank(op);
        reg.withdraw(SINK);
        ghostLive--;
    }

    function slash(uint256 seed) external {
        address op = _actor(seed);
        (uint256 bond,, uint64 exitAt) = reg.stakes(op);
        if (bond == 0) return;

        bool wasActive = exitAt == 0;
        reg.slash(op, SINK); // msg.sender == owner == this handler
        if (wasActive) ghostActive--;
        ghostLive--;
    }

    function warp(uint256 dt) external {
        dt = dt % (2 * UNBONDING + 1);
        vm.warp(block.timestamp + dt);
    }
}

contract GatewayRegistryInvariantTest is Cheats {
    GatewayHandler handler;

    function setUp() public {
        handler = new GatewayHandler();
    }

    // Restrict the fuzzer to the handler, and to just its action selectors.
    function targetContracts() public view returns (address[] memory addrs) {
        addrs = new address[](1);
        addrs[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory sel) {
        sel = new FuzzSelector[](1);
        bytes4[] memory s = new bytes4[](5);
        s[0] = GatewayHandler.register.selector;
        s[1] = GatewayHandler.initiateExit.selector;
        s[2] = GatewayHandler.withdraw.selector;
        s[3] = GatewayHandler.slash.selector;
        s[4] = GatewayHandler.warp.selector;
        sel[0] = FuzzSelector({addr: address(handler), selectors: s});
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    function invariant_activeCountMatchesLiveActiveStakes() public view {
        assertEq(
            handler.reg().activeCount(),
            handler.ghostActive(),
            "activeCount != number of active stakes"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    function invariant_ethEqualsSumOfLiveBonds() public view {
        assertEq(
            address(handler.reg()).balance,
            handler.ghostLive() * handler.BOND(),
            "contract ETH != sum of live bonds"
        );
    }
}
