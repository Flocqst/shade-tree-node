// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {MockCommitmentHasher} from "../contracts/MockCommitmentHasher.sol";

/// Pins the on-chain commitment scheme to Track 2's JS `deriveCommitment`.
/// The right-hand values are `poseidon1([x])` from `poseidon-lite` (already a repo dep).
/// If this test ever fails, the JS and Solidity commitment schemes have diverged and a
/// reconstructed secret would slash the WRONG leaf — do not ship past a red bar here.
contract PoseidonTest is Cheats {
    MockCommitmentHasher hasher;

    function setUp() public {
        hasher = new MockCommitmentHasher();
    }

    function test_MatchesPoseidonLiteVectors() public view {
        assertEq(
            hasher.commitmentOf(1),
            18586133768512220936620570745912940619677854269274689475585506675881198879027,
            "poseidon1([1]) mismatch"
        );
        assertEq(
            hasher.commitmentOf(2),
            8645981980787649023086883978738420856660271013038108762834452721572614684349,
            "poseidon1([2]) mismatch"
        );
        assertEq(
            hasher.commitmentOf(42),
            12326503012965816391338144612242952408728683609716147019497703475006801258307,
            "poseidon1([42]) mismatch"
        );
        assertEq(
            hasher.commitmentOf(123456789),
            7110303097080024260800444665787206606103183587082596139871399733998958991511,
            "poseidon1([123456789]) mismatch"
        );
    }

    function test_Deterministic() public view {
        assertEq(hasher.commitmentOf(777), hasher.commitmentOf(777));
    }
}
