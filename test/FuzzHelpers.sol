// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Shared helpers for the fuzz + invariant suites. This is a NEW file: Cheats.sol stays
// untouched (see its header — this repo deliberately avoids a forge-std dependency so
// lib/ can hold Track 2's .mjs crypto files). Everything Foundry's property fuzzer needs
// beyond the base Cheats harness lives here.

import {Cheats, Vm} from "./Cheats.sol";

/// A couple of cheatcodes the base Cheats harness doesn't declare but fuzzing wants.
/// `assume` discards fuzz inputs that don't satisfy a precondition (same handle address).
interface VmFuzz {
    function assume(bool) external pure;
}

/// Mirror of forge-std's StdInvariant.FuzzSelector. Foundry decodes `targetSelectors()`
/// return data by ABI shape — `(address,bytes4[])[]` — not by the Solidity type name, so
/// our own struct with the identical layout registers targets without pulling in forge-std.
struct FuzzSelector {
    address addr;
    bytes4[] selectors;
}

/// Base for fuzz test contracts: the extra cheat handle plus a modulo bound helper.
contract FuzzBase is Cheats {
    VmFuzz internal constant vmf = VmFuzz(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    /// Bound `x` into [lo, hi] (inclusive) by modulo — a local stand-in for forge-std's
    /// `bound`, adequate for these tests (no need for the wrap-around edge handling).
    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        require(lo <= hi, "_bound: lo > hi");
        uint256 size = hi - lo + 1;
        if (size == 0) return x; // full-range [0, type(uint256).max]
        return lo + (x % size);
    }

    function assertGe(uint256 a, uint256 b, string memory m) internal pure {
        require(a >= b, m);
    }

    function assertLe(uint256 a, uint256 b, string memory m) internal pure {
        require(a <= b, m);
    }
}
