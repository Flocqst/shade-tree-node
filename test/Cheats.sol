// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Self-contained Foundry harness (no forge-std dependency).
//
// WHY: forge-std installs as a git submodule under lib/, which this repo reserves for
// Track 2's crypto .mjs files. To avoid touching lib/ and to add ZERO new build deps at
// combine time, we declare the exact cheatcode interface and a tiny assertion base here.
// The integrator does NOT need `forge install` for these contracts to build or test.

/// Minimal subset of the Foundry cheatcode interface actually used by our tests + deploy.
interface Vm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function addr(uint256) external returns (address);
    function startBroadcast() external;
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
    function writeFile(string calldata, string calldata) external;
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function envOr(string calldata, string calldata) external view returns (string memory);
    function envOr(string calldata, uint256) external view returns (uint256);
    function envOr(string calldata, address) external view returns (address);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}

/// Base with the cheatcode handle + just-enough assertions.
contract Cheats {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue: false");
    }

    function assertTrue(bool c, string memory m) internal pure {
        require(c, m);
    }

    function assertFalse(bool c) internal pure {
        require(!c, "assertFalse: true");
    }

    function assertFalse(bool c, string memory m) internal pure {
        require(!c, m);
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint): mismatch");
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address): mismatch");
    }

    function assertEq(bool a, bool b) internal pure {
        require(a == b, "assertEq(bool): mismatch");
    }
}
