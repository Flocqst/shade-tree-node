// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {Eip3009Token} from "./Eip3009Token.sol";

/// EIP-3009 semantics of the test settle asset (T-FEAT-7 402 rails): a signed
/// TransferWithAuthorization moves exactly `value` from `from` to `to` when submitted by ANYONE
/// (the operator pays gas), the nonce is single-use per authorizer (authorizationState flips),
/// the validity window is enforced, a wrong signer / mauled signature / canceled nonce is
/// refused, and the domain separator is the EIP-712 hash the JS side (payments/eip3009.mjs
/// tokenDomain) computes: {name, version "1", chainid, this}.
contract Eip3009TokenTest is Cheats {
    Eip3009Token token;
    uint256 constant BUYER_KEY = 0xB0B;
    address buyer;
    address constant OPERATOR = address(0x0e0e);
    address constant PAY_TO = address(0xCAFE);
    bytes32 constant NONCE = keccak256("nonce-1");

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        token = new Eip3009Token("Test USD", "tUSD", 6);
        token.mint(buyer, 1_000_000_000); // 1000 tUSD
        vm.warp(1_700_000_000);
    }

    function _digest(address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, nonce));
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(key, digest);
    }

    function testDomainSeparatorMatchesEip712() public view {
        bytes32 want = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("Test USD")), keccak256(bytes("1")), block.chainid, address(token)));
        assertTrue(token.DOMAIN_SEPARATOR() == want, "domain separator");
        assertTrue(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH() == keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"), "typehash");
        assertTrue(token.CANCEL_AUTHORIZATION_TYPEHASH() == keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"), "cancel typehash");
    }

    function testTransferWithAuthorizationByThirdParty() public {
        uint256 va = block.timestamp - 1; uint256 vb = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BUYER_KEY, _digest(buyer, PAY_TO, 100_000, va, vb, NONCE));
        assertFalse(token.authorizationState(buyer, NONCE));
        vm.prank(OPERATOR); // anyone may submit; funds still move buyer -> payTo
        token.transferWithAuthorization(buyer, PAY_TO, 100_000, va, vb, NONCE, v, r, s);
        assertEq(token.balanceOf(PAY_TO), 100_000);
        assertEq(token.balanceOf(buyer), 1_000_000_000 - 100_000);
        assertTrue(token.authorizationState(buyer, NONCE), "nonce consumed");
        // replay: same signature again -> refused, no double spend
        vm.prank(OPERATOR);
        vm.expectRevert(Eip3009Token.AuthorizationUsedOrCanceled.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 100_000, va, vb, NONCE, v, r, s);
        assertEq(token.balanceOf(PAY_TO), 100_000);
    }

    function testValidityWindow() public {
        uint256 va = block.timestamp + 10; uint256 vb = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BUYER_KEY, _digest(buyer, PAY_TO, 1, va, vb, NONCE));
        vm.expectRevert(Eip3009Token.AuthorizationNotYetValid.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 1, va, vb, NONCE, v, r, s);
        vm.warp(vb); // == validBefore is already expired (strict)
        vm.expectRevert(Eip3009Token.AuthorizationExpired.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 1, va, vb, NONCE, v, r, s);
        vm.warp(va + 1);
        token.transferWithAuthorization(buyer, PAY_TO, 1, va, vb, NONCE, v, r, s);
        assertEq(token.balanceOf(PAY_TO), 1);
    }

    function testWrongSignerAndTamperedFieldsRefused() public {
        uint256 va = 0; uint256 vb = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xA11CE, _digest(buyer, PAY_TO, 5, va, vb, NONCE)); // not the buyer's key
        vm.expectRevert(Eip3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 5, va, vb, NONCE, v, r, s);
        // right signer, but the submitter changed `to` -> the digest differs -> refused
        (v, r, s) = _sign(BUYER_KEY, _digest(buyer, PAY_TO, 5, va, vb, NONCE));
        vm.expectRevert(Eip3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(buyer, OPERATOR, 5, va, vb, NONCE, v, r, s);
        // and `value`
        vm.expectRevert(Eip3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 6, va, vb, NONCE, v, r, s);
        // high-s malleated copy of a valid signature is NOT a second valid signature
        bytes32 s2 = bytes32(uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141) - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        vm.expectRevert(Eip3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 5, va, vb, NONCE, v2, r, s2);
        assertEq(token.balanceOf(PAY_TO), 0);
    }

    function testInsufficientBalanceReverts() public {
        uint256 va = 0; uint256 vb = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BUYER_KEY, _digest(buyer, PAY_TO, 2_000_000_000, va, vb, NONCE));
        vm.expectRevert(Eip3009Token.InsufficientBalance.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 2_000_000_000, va, vb, NONCE, v, r, s);
        assertFalse(token.authorizationState(buyer, NONCE), "a reverted transfer does not burn the nonce");
    }

    function testCancelAuthorization() public {
        bytes32 structHash = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), buyer, NONCE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = _sign(BUYER_KEY, digest);
        token.cancelAuthorization(buyer, NONCE, v, r, s);
        assertTrue(token.authorizationState(buyer, NONCE), "canceled == used");
        uint256 va = 0; uint256 vb = block.timestamp + 300;
        (v, r, s) = _sign(BUYER_KEY, _digest(buyer, PAY_TO, 5, va, vb, NONCE));
        vm.expectRevert(Eip3009Token.AuthorizationUsedOrCanceled.selector);
        token.transferWithAuthorization(buyer, PAY_TO, 5, va, vb, NONCE, v, r, s);
    }

    function testMintOwnerOnly() public {
        vm.prank(OPERATOR);
        vm.expectRevert(Eip3009Token.NotOwner.selector);
        token.mint(OPERATOR, 1);
    }
}
