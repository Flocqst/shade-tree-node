// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Fuzz tests for GatewayRegistry. Foundry auto-fuzzes any `testFuzz_*` function with typed
// args regardless of forge-std; each case asserts a per-call property (successful register
// => staked + activeCount up; wrong bond => revert; withdraw honours the unbonding clock;
// any staked operator is slashable).

import {FuzzBase} from "./FuzzHelpers.sol";
import {GatewayRegistry} from "../contracts/GatewayRegistry.sol";

contract GatewayRegistryFuzzTest is FuzzBase {
    uint256 constant BOND = 0.01 ether;
    uint256 constant UNBONDING = 300;
    uint256 constant MIN_UNBONDING = 270;

    GatewayRegistry reg;

    address constant OWNER = address(0x0140);
    address constant SINK = address(0x5151);     // EOA payout sink for withdraw
    address constant RECEIVER = address(0xCAFE);  // slash receiver

    function setUp() public {
        reg = new GatewayRegistry(BOND, UNBONDING, MIN_UNBONDING, OWNER);
    }

    // Operators must be plausible EOAs distinct from the fixtures / the registry itself, so
    // dealing them ETH and pranking as them can't corrupt the balances we assert on.
    function _assumeOperator(address op) internal view {
        vmf.assume(op != address(0));
        vmf.assume(op != address(reg));
        vmf.assume(op != OWNER);
        vmf.assume(op != SINK);
        vmf.assume(op != RECEIVER);
        vmf.assume(op.code.length == 0);
    }

    // ---- register: only the exact BOND is admitted ---------------------------

    function testFuzz_register_exactBondAdmits(address op) public {
        _assumeOperator(op);

        assertFalse(reg.isStaked(op));
        vm.deal(op, BOND);
        vm.prank(op);
        reg.register{value: BOND}();

        assertTrue(reg.isStaked(op), "exact bond should admit");
        assertEq(reg.activeCount(), 1);
        (uint256 bond, uint64 index, uint64 exitAt) = reg.stakes(op);
        assertEq(bond, BOND, "bond recorded");
        assertEq(uint256(index), 0);
        assertEq(uint256(exitAt), 0);
        assertEq(address(reg).balance, BOND, "one live bond held");
    }

    function testFuzz_register_wrongBondReverts(address op, uint96 value) public {
        _assumeOperator(op);
        vmf.assume(value != BOND);

        vm.deal(op, value);
        vm.prank(op);
        vm.expectRevert(GatewayRegistry.BadBond.selector);
        reg.register{value: value}();

        // nothing admitted, no wei stuck
        assertFalse(reg.isStaked(op));
        assertEq(reg.activeCount(), 0);
        assertEq(address(reg).balance, 0);
    }

    // ---- exit + withdraw honour the unbonding clock for any timing -----------

    function testFuzz_exitWithdraw_timing(address op, uint256 wait) public {
        _assumeOperator(op);
        wait = _bound(wait, 0, 3 * UNBONDING);

        vm.deal(op, BOND);
        vm.startPrank(op);
        reg.register{value: BOND}();
        reg.initiateExit();
        vm.stopPrank();

        assertFalse(reg.isStaked(op), "exiting leaves the active set");
        assertEq(reg.activeCount(), 0);
        uint256 unlock = reg.withdrawableAt(op);

        vm.warp(block.timestamp + wait);

        if (block.timestamp < unlock) {
            vm.prank(op);
            vm.expectRevert(GatewayRegistry.StillBonded.selector);
            reg.withdraw(SINK);
            assertEq(address(reg).balance, BOND, "bond still held while bonded");
        } else {
            uint256 before = SINK.balance;
            vm.prank(op);
            reg.withdraw(SINK);
            assertEq(SINK.balance - before, BOND, "bond returned after unbonding");
            assertEq(address(reg).balance, 0, "contract emptied");
        }
    }

    // ---- slash: any staked operator (active or exiting) pays out -------------

    function testFuzz_slash_anyStakedPays(address op, bool exiting) public {
        _assumeOperator(op);

        vm.deal(op, BOND);
        vm.startPrank(op);
        reg.register{value: BOND}();
        if (exiting) reg.initiateExit();
        vm.stopPrank();

        uint256 before = RECEIVER.balance;
        vm.prank(OWNER);
        reg.slash(op, RECEIVER);

        assertEq(RECEIVER.balance - before, BOND, "slash pays the bond");
        assertFalse(reg.isStaked(op), "slashed operator gone");
        assertEq(reg.activeCount(), 0, "activeCount back to zero");
        assertEq(address(reg).balance, 0, "no bond left behind");
    }

    // ---- only the owner may slash, whoever the caller is ---------------------

    function testFuzz_slash_nonOwnerReverts(address op, address caller) public {
        _assumeOperator(op);
        vmf.assume(caller != OWNER);

        vm.deal(op, BOND);
        vm.prank(op);
        reg.register{value: BOND}();

        vm.prank(caller);
        vm.expectRevert(GatewayRegistry.NotOwner.selector);
        reg.slash(op, RECEIVER);

        assertTrue(reg.isStaked(op), "non-owner slash is a no-op");
        assertEq(address(reg).balance, BOND);
    }
}
