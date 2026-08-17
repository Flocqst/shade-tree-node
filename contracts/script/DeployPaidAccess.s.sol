// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "../../test/Cheats.sol";
import {PaidAccessSet} from "../PaidAccessSet.sol";
import {ICommitmentHasher} from "../StakedReputationSet.sol";
import {RateCommitmentHasher} from "../RateCommitmentHasher.sol";
import {console} from "./DeployRegistry.s.sol";

/// DeployPaidAccess — deploys the PaidAccessSet (T-FEAT-7 Layer 1, docs/PAYMENTS.md): the
/// operator-inserted paid-access membership tree that sits NEXT TO the live staked set. Payment
/// settles OFF chain (HTTP 402 rails: x402 / MPP, stablecoin straight to the operator); the
/// contract holds no funds and has no prices, only the immutable allowed-tier table and the
/// operator (registrar) key that inserts. Every constructor argument comes from an env var with
/// a safe default, so the same script targets a local anvil, Sepolia or an L2 by changing only
/// `--rpc-url` and the env. It logs the address and records it to a JSON file (RGOE_DEPLOY_OUT).
///
/// The tiered RateCommitmentHasher is REUSED by address (RGOE_COMMITMENT_HASHER = the live rln-v4
/// hasher on Sepolia); a fresh one is deployed only when that is unset. The PaidAccessSet links
/// the external PoseidonT3 library: pass `--libraries contracts/PoseidonT3.sol:PoseidonT3:<addr>`
/// to reuse the one already on chain (network/sepolia/contracts.json `libraries`), else forge
/// deploys a new copy (~2.7M gas more).
///
/// SCOPE: deploy TOOLING. Without `--broadcast` this only simulates. Broadcasting is an operator
/// action documented in docs/ONCHAIN-DEPLOY.md §9. Reference, unaudited, testnet-only.
///
/// Environment variables (all optional; defaults in parens):
///   RGOE_PAY_LIMITS         tiers this set admits, comma-separated userMessageLimits, ascending,
///                           distinct, 1..65535, must include 8                    ("8,32")
///   RGOE_PAY_OPERATOR       the registrar / insert authority              (0 => the deployer)
///   RGOE_COMMITMENT_HASHER  pre-deployed TIERED ICommitmentHasher    (0 => deploy RateCommitmentHasher)
///   RGOE_RPC_URL            endpoint, recorded into the JSON        ("http://127.0.0.1:8545")
///   RGOE_DEPLOY_OUT         JSON output path (must be under the repo: foundry.toml fs_permissions)
///                                                                    ("contracts/paid-access.local.json")
contract DeployPaidAccess is Cheats {
    function run() external returns (address paidAccessSet, address commitmentHasher, address operator) {
        uint256[] memory limits = _parseUintList(vm.envOr("RGOE_PAY_LIMITS", string("8,32")));
        address opEnv = vm.envOr("RGOE_PAY_OPERATOR", address(0));
        commitmentHasher = vm.envOr("RGOE_COMMITMENT_HASHER", address(0));

        console.log("== DeployPaidAccess ==");
        console.log("chainid    ", block.chainid);
        for (uint256 i = 0; i < limits.length; i++) console.log("tier       ", limits[i]);

        vm.startBroadcast();
        if (commitmentHasher == address(0)) {
            RateCommitmentHasher h = new RateCommitmentHasher();
            commitmentHasher = address(h);
            console.log("deployed RateCommitmentHasher (tiered Poseidon rate-commitment hasher)");
        }
        PaidAccessSet s = new PaidAccessSet(opEnv, ICommitmentHasher(commitmentHasher), limits);
        vm.stopBroadcast();

        paidAccessSet = address(s);
        operator = s.operator();
        console.log("PaidAccessSet       ", paidAccessSet);
        console.log("commitmentHasher    ", commitmentHasher);
        console.log("operator            ", operator);
        console.log("currentRoot (empty) ", s.currentRoot());
        console.log("leafCount           ", s.leafCount());

        _writeDeployment(paidAccessSet, commitmentHasher, operator);
    }

    /// Parse "a,b,c" (decimal, no spaces) into a uint256[]; "" => empty. Reverts on any non-digit.
    function _parseUintList(string memory csv) internal pure returns (uint256[] memory out) {
        bytes memory b = bytes(csv);
        if (b.length == 0) return out;
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) if (b[i] == ",") n++;
        out = new uint256[](n);
        uint256 k = 0;
        uint256 acc = 0;
        bool any = false;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") {
                require(any, "RGOE_PAY_LIMITS: empty list item");
                out[k++] = acc;
                acc = 0;
                any = false;
            } else {
                require(b[i] >= "0" && b[i] <= "9", "RGOE_PAY_LIMITS: digits only");
                acc = acc * 10 + (uint8(b[i]) - 48);
                any = true;
            }
        }
        require(any, "RGOE_PAY_LIMITS: empty list item");
        out[k] = acc;
    }

    function _writeDeployment(address set, address hasher, address op) internal {
        string memory outPath = vm.envOr("RGOE_DEPLOY_OUT", string("contracts/paid-access.local.json"));
        string memory rpcUrl = vm.envOr("RGOE_RPC_URL", string("http://127.0.0.1:8545"));
        string memory json = string.concat(
            "{\n",
            '  "paidAccessSet": "', vm.toString(set), '",\n',
            '  "hasher": "', vm.toString(hasher), '",\n',
            '  "operator": "', vm.toString(op), '",\n',
            '  "rpcUrl": "', rpcUrl, '"\n',
            "}\n"
        );
        vm.writeFile(outPath, json);
        console.log("wrote", outPath);
    }
}
