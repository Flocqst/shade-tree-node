// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {StakedReputationSet, IWithdrawVerifier, ICommitmentHasher} from "../contracts/StakedReputationSet.sol";
import {RateCommitmentHasher} from "../contracts/RateCommitmentHasher.sol";
import {MockWithdrawVerifier} from "../contracts/MockWithdrawVerifier.sol";

contract StakedReputationSetTest is Cheats {
    // Demo params (docs/NEXT-VERSION.md), matching script/Deploy.s.sol.
    uint256 constant BOND = 0.01 ether;
    uint256 constant UNBONDING = 300;
    uint256 constant MIN_UNBONDING = 270;

    StakedReputationSet set;
    RateCommitmentHasher hasher;
    MockWithdrawVerifier verifier;

    // Two demo members. identitySecret in [0, F); the membership leaf is the RLN rate
    // commitment  = Poseidon(2)([ Poseidon(1)([identitySecret]), 8 ]).
    uint256 constant SECRET_A = 111;
    uint256 constant SECRET_B = 222;
    // Hardcoded rate commitment for SECRET_A=111, from poseidon-lite:
    //   poseidon2([poseidon1([111n]), 8n]). Pins the leaf a demo member registers.
    uint256 constant COMMIT_A_EXPECTED =
        11302006078516901731073162965056551612114122314181142374993834332168998510316;
    uint256 commitA;
    uint256 commitB;

    address constant RECIPIENT = address(0xBEEF);
    address constant RECEIVER = address(0xCAFE); // gateway/treasury slash receiver

    function setUp() public {
        hasher = new RateCommitmentHasher();
        verifier = new MockWithdrawVerifier(ICommitmentHasher(address(hasher)));
        set = new StakedReputationSet(
            BOND,
            UNBONDING,
            MIN_UNBONDING,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );
        commitA = hasher.commitmentOf(SECRET_A);
        commitB = hasher.commitmentOf(SECRET_B);
        vm.deal(address(this), 100 ether);
    }

    function _proof(uint256 secret) internal pure returns (bytes memory) {
        return abi.encode(secret);
    }

    // ---- constructor guard ----------------------------------------------------

    function test_Constructor_RejectsUnsafeUnbonding() public {
        vm.expectRevert(StakedReputationSet.UnbondingTooShort.selector);
        new StakedReputationSet(
            BOND,
            MIN_UNBONDING - 1, // below the F+E+C lower bound
            MIN_UNBONDING,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );
    }

    function test_Constructor_RejectsZeroBond() public {
        vm.expectRevert(StakedReputationSet.BadBond.selector);
        new StakedReputationSet(
            0,
            UNBONDING,
            MIN_UNBONDING,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );
    }

    // ---- register (R1) --------------------------------------------------------

    function test_Register_Succeeds() public {
        set.register{value: BOND}(commitA);
        assertTrue(set.isActive(commitA), "A should be active");
        assertEq(set.activeCount(), 1);
        (uint256 bond, uint64 index, uint64 exitAt) = set.members(commitA);
        assertEq(bond, BOND);
        assertEq(uint256(index), 0);
        assertEq(uint256(exitAt), 0);
        assertEq(address(set).balance, BOND);
    }

    function test_Register_RequiresExactBond() public {
        vm.expectRevert(StakedReputationSet.BadBond.selector);
        set.register{value: BOND - 1}(commitA);

        vm.expectRevert(StakedReputationSet.BadBond.selector);
        set.register{value: BOND + 1}(commitA);

        vm.expectRevert(StakedReputationSet.BadBond.selector);
        set.register{value: 0}(commitA);
    }

    function test_Register_RejectsDuplicate() public {
        set.register{value: BOND}(commitA);
        vm.expectRevert(StakedReputationSet.AlreadyMember.selector);
        set.register{value: BOND}(commitA);
    }

    function test_Register_AppendOnlyIndex() public {
        set.register{value: BOND}(commitA);
        set.register{value: BOND}(commitB);
        (, uint64 idxA,) = set.members(commitA);
        (, uint64 idxB,) = set.members(commitB);
        assertEq(uint256(idxA), 0);
        assertEq(uint256(idxB), 1);
        assertEq(uint256(set.nextIndex()), 2);
        assertEq(set.activeCount(), 2);
    }

    // ---- initiateExit (R2/R4) -------------------------------------------------

    function test_InitiateExit_RequiresValidProof() public {
        set.register{value: BOND}(commitA);
        // wrong secret => verifier returns false => BadProof
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.initiateExit(commitA, _proof(SECRET_B));
        // malformed proof (not 32 bytes) => verifier returns false => BadProof
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.initiateExit(commitA, abi.encode(SECRET_A, SECRET_A));
    }

    function test_InitiateExit_StartsClockAndLeavesActiveSet() public {
        set.register{value: BOND}(commitA);
        uint256 t = block.timestamp;
        set.initiateExit(commitA, _proof(SECRET_A));

        assertFalse(set.isActive(commitA), "A should leave active set");
        assertEq(set.activeCount(), 0, "activeCount decremented on exit");
        assertEq(set.withdrawableAt(commitA), t + UNBONDING);
        // bond still held (still slashable through unbonding)
        assertEq(address(set).balance, BOND);
    }

    function test_InitiateExit_RejectsUnknownMember() public {
        vm.expectRevert(StakedReputationSet.NotMember.selector);
        set.initiateExit(commitA, _proof(SECRET_A));
    }

    function test_InitiateExit_RejectsDoubleExit() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));
        vm.expectRevert(StakedReputationSet.AlreadyExiting.selector);
        set.initiateExit(commitA, _proof(SECRET_A));
    }

    // ---- withdraw (R2/R4) -----------------------------------------------------

    function test_Withdraw_BlockedBeforeExit() public {
        set.register{value: BOND}(commitA);
        vm.expectRevert(StakedReputationSet.NotExiting.selector);
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_A));
    }

    function test_Withdraw_BlockedBeforeUnbondingElapses() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));

        // one second short of the unbonding delay
        vm.warp(block.timestamp + UNBONDING - 1);
        vm.expectRevert(StakedReputationSet.StillBonded.selector);
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_A));
    }

    function test_Withdraw_SucceedsAfterUnbondingAndPaysRecipient() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));
        vm.warp(block.timestamp + UNBONDING);

        uint256 before = RECIPIENT.balance;
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_A));

        assertEq(RECIPIENT.balance - before, BOND, "recipient paid the bond");
        assertEq(address(set).balance, 0, "contract emptied");
        (uint256 bond,,) = set.members(commitA);
        assertEq(bond, 0, "member deleted");
    }

    function test_Withdraw_RequiresValidProofEvenAfterUnbonding() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));
        vm.warp(block.timestamp + UNBONDING);
        vm.expectRevert(StakedReputationSet.BadProof.selector);
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_B));
    }

    // ---- slash (R3) -----------------------------------------------------------

    /// The linchpin, end to end: register the hardcoded rate-commitment leaf for a demo
    /// identitySecret, then slash by revealing that identitySecret. Proves the on-chain
    /// leaf (poseidon2([poseidon1([s]),8])) matches the value the crypto side computes,
    /// so a reconstructed secret slashes the right leaf and pays out.
    function test_Slash_RateCommitmentLeaf_RevealedSecret_Pays() public {
        // the leaf a member registers is exactly the poseidon-lite rate commitment
        assertEq(commitA, COMMIT_A_EXPECTED, "commitA must equal the hardcoded rate commitment");
        assertEq(
            hasher.commitmentOf(SECRET_A),
            COMMIT_A_EXPECTED,
            "on-chain commitmentOf(identitySecret) must equal poseidon2([poseidon1([s]),8])"
        );

        set.register{value: BOND}(COMMIT_A_EXPECTED);
        uint256 before = RECEIVER.balance;

        // revealing the identitySecret slashes the leaf
        set.slash(COMMIT_A_EXPECTED, SECRET_A, RECEIVER);
        assertEq(RECEIVER.balance - before, BOND, "revealed identitySecret pays out the bond");
        (uint256 bond,,) = set.members(COMMIT_A_EXPECTED);
        assertEq(bond, 0, "slashed leaf deleted");

        // a WRONG secret does not hash to the leaf => BadSecret
        set.register{value: BOND}(commitB);
        vm.expectRevert(StakedReputationSet.BadSecret.selector);
        set.slash(commitB, SECRET_A, RECEIVER);
    }

    function test_Slash_ActiveMember_BurnsBondPaysReceiver() public {
        set.register{value: BOND}(commitA);
        uint256 before = RECEIVER.balance;

        set.slash(commitA, SECRET_A, RECEIVER);

        assertEq(RECEIVER.balance - before, BOND, "receiver paid the bond");
        (uint256 bond,,) = set.members(commitA);
        assertEq(bond, 0, "slashed member deleted");
        assertEq(set.activeCount(), 0, "activeCount decremented on slash of active member");
        assertFalse(set.isActive(commitA));
    }

    function test_Slash_RejectsWrongSecret() public {
        set.register{value: BOND}(commitA);
        vm.expectRevert(StakedReputationSet.BadSecret.selector);
        set.slash(commitA, SECRET_B, RECEIVER); // secret doesn't hash to commitA
    }

    function test_Slash_RejectsUnknownMember() public {
        vm.expectRevert(StakedReputationSet.NotMember.selector);
        set.slash(commitA, SECRET_A, RECEIVER);
    }

    function test_Slash_WorksDuringUnbonding_AndBlocksLaterWithdraw() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));
        assertEq(set.activeCount(), 0);

        // over-spend detected mid-unbonding => slash lands
        uint256 before = RECEIVER.balance;
        set.slash(commitA, SECRET_A, RECEIVER);
        assertEq(RECEIVER.balance - before, BOND, "slash pays during unbonding");
        assertEq(set.activeCount(), 0, "already-exiting member not double-decremented");

        // the escape is closed: the later withdraw finds no bond
        vm.warp(block.timestamp + UNBONDING);
        vm.expectRevert(StakedReputationSet.NotMember.selector);
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_A));
    }

    // ---- re-registration ------------------------------------------------------

    function test_ReRegister_AfterWithdraw() public {
        set.register{value: BOND}(commitA);
        set.initiateExit(commitA, _proof(SECRET_A));
        vm.warp(block.timestamp + UNBONDING);
        set.withdraw(commitA, RECIPIENT, _proof(SECRET_A));

        // commitment was deleted, so it can be registered again (new leaf index)
        set.register{value: BOND}(commitA);
        assertTrue(set.isActive(commitA), "re-registered after withdraw");
        (, uint64 idx,) = set.members(commitA);
        assertEq(uint256(idx), 1, "re-registration gets a fresh append-only index");
    }

    function test_ReRegister_AfterSlash() public {
        set.register{value: BOND}(commitA);
        set.slash(commitA, SECRET_A, RECEIVER);

        set.register{value: BOND}(commitA);
        assertTrue(set.isActive(commitA), "re-registered after slash");
        assertEq(set.activeCount(), 1);
    }

    // allow this test contract to receive ETH if ever named as a recipient
    receive() external payable {}
}
