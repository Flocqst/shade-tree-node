// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {StakedReputationSet, IWithdrawVerifier, ICommitmentHasher} from "../contracts/StakedReputationSet.sol";
import {RateCommitmentHasher} from "../contracts/RateCommitmentHasher.sol";
import {WithdrawGroth16Verifier} from "../contracts/WithdrawGroth16Verifier.sol";
import {WithdrawVerifier} from "../contracts/WithdrawVerifier.sol";

/// T-DEV-1 acceptance test: the REAL Groth16 exit-auth path.
///
/// Unlike StakedReputationSet.t.sol (which exercises the state machine against
/// MockWithdrawVerifier's revealed-secret stub), this test wires the REAL
/// `WithdrawVerifier` (wrapping the snarkJS-exported `WithdrawGroth16Verifier`) into
/// StakedReputationSet and feeds it a REAL Groth16 proof generated off-chain by
/// testdata/gen-withdraw-proof.mjs (snarkJS + circuits/rln/withdraw.wasm|zkey). The
/// proof reveals nothing about the identity secret; the verifier checks a genuine
/// proof-of-knowledge, bound to the exact action.
///
/// Accept (ship-plan T-DEV-1): a valid proof authorizes initiateExit/withdraw; a
/// bogus/tampered proof reverts BadProof.
///
/// TESTNET-ONLY: the wrapped VK is circom-rln's untrusted dev phase-2 setup (see
/// circuits/rln/ARTIFACTS.md); not ceremony-trusted until ship-plan T-HARD-1.
contract WithdrawVerifierTest is Cheats {
    uint256 constant BOND = 0.01 ether;
    uint256 constant UNBONDING = 300;
    uint256 constant MIN_UNBONDING = 270;

    // The demo identity behind the fixture is SECRET_A = 111 (public across the repo);
    // its rate-commitment leaf is the value below. The ZK proof never carries the secret.
    uint256 constant SECRET_A = 111;
    uint256 constant COMMIT_A_EXPECTED =
        11302006078516901731073162965056551612114122314181142374993834332168998510316;

    // Must match testdata/gen-withdraw-proof.mjs RECIPIENT.
    address constant RECIPIENT = address(0xBEEF);
    address constant WRONG_RECIPIENT = address(0xDEAD);

    StakedReputationSet set;
    RateCommitmentHasher hasher;
    WithdrawVerifier verifier;

    uint256 commitA;
    bytes exitProof;
    bytes withdrawProof;

    function setUp() public {
        hasher = new RateCommitmentHasher();
        WithdrawGroth16Verifier groth16 = new WithdrawGroth16Verifier();
        verifier = new WithdrawVerifier(groth16);
        set = new StakedReputationSet(
            BOND,
            UNBONDING,
            MIN_UNBONDING,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );

        // The leaf is computed on-chain from the (public) demo secret, exactly as a
        // member's registration would produce it; the fixture is bound to this same leaf.
        commitA = hasher.commitmentOf(SECRET_A);
        assertEq(commitA, COMMIT_A_EXPECTED, "hasher leaf must equal the fixtured commitment");

        // Load the REAL proofs from the committed golden fixture.
        string memory json = vm.readFile("testdata/withdraw-proof.json");
        exitProof = vm.parseJsonBytes(json, ".exit.proof");
        withdrawProof = vm.parseJsonBytes(json, ".withdraw.proof");

        vm.deal(address(this), 100 ether);
    }

    // Flip the low byte of the last ABI word (identityCommitment) so BOTH the Groth16
    // pairing and the leaf-reconstruction check fail => a clean false => BadProof.
    function _tamper(bytes memory p) internal pure returns (bytes memory) {
        bytes memory q = bytes.concat(p); // copy
        uint256 i = q.length - 1;
        q[i] = bytes1(uint8(q[i]) ^ 0x01);
        return q;
    }

    // ---- the verifier in isolation -------------------------------------------

    function test_Verifier_AcceptsValidExitProof_Directly() public view {
        bytes32 ctx = keccak256(abi.encodePacked("RGOE_EXIT", commitA));
        assertTrue(verifier.verify(commitA, ctx, exitProof), "real exit proof must verify");
    }

    function test_Verifier_RejectsTamperedProof_Directly() public view {
        bytes32 ctx = keccak256(abi.encodePacked("RGOE_EXIT", commitA));
        assertFalse(verifier.verify(commitA, ctx, _tamper(exitProof)), "tampered proof must not verify");
    }

    function test_Verifier_RejectsWrongCommitment_Directly() public view {
        // Same valid proof, but claimed against a different leaf => leaf check fails.
        bytes32 ctx = keccak256(abi.encodePacked("RGOE_EXIT", commitA));
        uint256 otherLeaf = hasher.commitmentOf(222);
        assertFalse(verifier.verify(otherLeaf, ctx, exitProof), "proof must not verify against another leaf");
    }

    function test_Verifier_RejectsWrongContext_Directly() public view {
        // The exit proof is bound to the EXIT context; a different context => false.
        bytes32 wrongCtx = keccak256(abi.encodePacked("RGOE_WITHDRAW", commitA, RECIPIENT));
        assertFalse(verifier.verify(commitA, wrongCtx, exitProof), "proof bound to exit ctx must fail other ctx");
    }

    function test_Verifier_RejectsMalformedProof_Directly() public view {
        bytes32 ctx = keccak256(abi.encodePacked("RGOE_EXIT", commitA));
        assertFalse(verifier.verify(commitA, ctx, hex"deadbeef"), "malformed proof => clean false");
    }

    // ---- initiateExit through StakedReputationSet ----------------------------

    function test_InitiateExit_RealProof_Authorizes() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, exitProof);
        assertFalse(set.isActive(commitA), "member left the active set after ZK-authorized exit");
        assertEq(set.withdrawableAt(commitA), block.timestamp + UNBONDING);
    }

    function test_InitiateExit_TamperedProof_RevertsBadProof() public {
        set.register{value: BOND}(commitA);
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.initiateExit(commitA, _tamper(exitProof));
    }

    function test_InitiateExit_WrongContextProof_RevertsBadProof() public {
        // Feeding the WITHDRAW proof to initiateExit binds the wrong context => BadProof.
        set.register{value: BOND}(commitA);
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.initiateExit(commitA, withdrawProof);
    }

    // ---- withdraw through StakedReputationSet --------------------------------

    function test_Withdraw_RealProof_SucceedsAndPaysRecipient() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, exitProof);
        vm.warp(block.timestamp + UNBONDING);

        uint256 before = RECIPIENT.balance;
        set.withdraw(commitA, RECIPIENT, withdrawProof);
        assertEq(RECIPIENT.balance - before, BOND, "recipient paid the bond via ZK-authorized withdraw");
        assertEq(address(set).balance, 0, "contract emptied");
        (uint256 bond,,) = set.members(commitA);
        assertEq(bond, 0, "member deleted");
    }

    function test_Withdraw_TamperedProof_RevertsBadProof() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, exitProof);
        vm.warp(block.timestamp + UNBONDING);
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.withdraw(commitA, RECIPIENT, _tamper(withdrawProof));
    }

    function test_Withdraw_ProofBoundToRecipient_RevertsForOtherRecipient() public {
        // The withdraw proof is bound to RECIPIENT via context; redirecting the payout
        // to WRONG_RECIPIENT changes the context => the captured proof is worthless.
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, exitProof);
        vm.warp(block.timestamp + UNBONDING);
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.withdraw(commitA, WRONG_RECIPIENT, withdrawProof);
    }

    receive() external payable {}
}
