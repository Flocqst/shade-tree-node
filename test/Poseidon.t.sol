// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {RateCommitmentHasher} from "../contracts/RateCommitmentHasher.sol";

/// Pins the on-chain rate-commitment scheme to the crypto side's JS derivation.
/// `commitmentOf(s)` returns the RLN Merkle leaf
///     rateCommitment = Poseidon(2)([ Poseidon(1)([s]), 8 ])
/// and the right-hand values below are `poseidon2([poseidon1([s]), 8n])` computed with
/// `poseidon-lite` (already a repo dep):
///
///     node -e 'const {poseidon1,poseidon2}=require("poseidon-lite");
///              for (const s of [1n,2n,42n,111n,123456789n])
///                console.log(s, poseidon2([poseidon1([s]), 8n]).toString());'
///
/// This equality is the linchpin: if the JS and Solidity schemes diverge, a reconstructed
/// identitySecret would slash the WRONG leaf (silent BadSecret). Do not ship past a red bar.
contract PoseidonTest is Cheats {
    RateCommitmentHasher hasher;

    function setUp() public {
        hasher = new RateCommitmentHasher();
    }

    function test_MatchesPoseidonLiteRateVectors() public view {
        assertEq(
            hasher.commitmentOf(1),
            19891105629297951594670588741444296361737921464595154400690791765679348608752,
            "rateCommitment(1) mismatch"
        );
        assertEq(
            hasher.commitmentOf(2),
            829125768753819539800244880652039674283559009741491044486206649483843818383,
            "rateCommitment(2) mismatch"
        );
        assertEq(
            hasher.commitmentOf(42),
            18761753399903396742513213281650676703493682377645661572914919902014839614171,
            "rateCommitment(42) mismatch"
        );
        assertEq(
            hasher.commitmentOf(111),
            11302006078516901731073162965056551612114122314181142374993834332168998510316,
            "rateCommitment(111) mismatch"
        );
        assertEq(
            hasher.commitmentOf(123456789),
            21329507788392969599237625293681982274847848071789066949605792135001356234277,
            "rateCommitment(123456789) mismatch"
        );
    }

    function test_K_IsEight() public view {
        assertEq(hasher.K(), 8, "K must be 8 (RLN userMessageLimit)");
    }

    function test_Deterministic() public view {
        assertEq(hasher.commitmentOf(777), hasher.commitmentOf(777));
    }
}
