// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A minimal ERC-20 with EIP-3009 `transferWithAuthorization` / `authorizationState` /
/// `cancelAuthorization` over an EIP-712 domain, for the 402 rails' selftests and as the
/// TESTNET settle asset when no faucet stablecoin is available (docs/PAYMENTS.md "Settle asset").
///
/// The registrar (payments/registrar.mjs) treats it exactly like USDC: same typed data
/// (TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,
/// uint256 validBefore,bytes32 nonce)), same `authorizationState(from, nonce)` replay check,
/// same `DOMAIN_SEPARATOR()`/`name()`/`version()` boot probe. Swapping in real USDC is a
/// one-env change (RGOE_PAY_ASSET). Not for value: `mint` is owner-only and unbounded.
contract Eip3009Token {
    string public name;
    string public symbol;
    string public constant version = "1";
    uint8 public immutable decimals;
    address public immutable owner;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    // authorizer => nonce => used (EIP-3009: a nonce is single-use per authorizer)
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationUsedOrCanceled();
    error InvalidSignature();
    error ZeroAddress();

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        owner = msg.sender;
    }

    // ---- EIP-712 -----------------------------------------------------------------
    /// Recomputed per call over block.chainid, so a fork/replay on another chain never shares
    /// a domain (same posture as OpenZeppelin EIP712).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // ---- ERC-20 ------------------------------------------------------------------
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a < amount) revert InsufficientAllowance();
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 b = balanceOf[from];
        if (b < amount) revert InsufficientBalance();
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // ---- EIP-3009 ----------------------------------------------------------------
    /// True once `nonce` has been used or canceled by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// Execute a transfer with a signed authorization. Anyone may submit (the operator does, and
    /// pays the gas); the funds move exactly as the signer authorized. Per EIP-3009:
    /// validAfter < now < validBefore, nonce unused, signature recovers to `from`.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationUsedOrCanceled();
        bytes32 digest = _hashTypedData(keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        if (!_isValidSignature(from, digest, v, r, s)) revert InvalidSignature();
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// Void an unused nonce.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationUsedOrCanceled();
        bytes32 digest = _hashTypedData(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!_isValidSignature(authorizer, digest, v, r, s)) revert InvalidSignature();
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// ecrecover with the low-s / v malleability guard (EIP-2), so a mauled signature is not a
    /// second valid signature over the same nonce.
    function _isValidSignature(address signer, bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (bool) {
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        address rec = ecrecover(digest, v, r, s);
        return rec != address(0) && rec == signer;
    }
}
