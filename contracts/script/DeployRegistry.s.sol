// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "../../test/Cheats.sol";
import {StakedReputationSet, IWithdrawVerifier, ICommitmentHasher} from "../StakedReputationSet.sol";
import {GatewayRegistry} from "../GatewayRegistry.sol";
import {MockCommitmentHasher} from "../MockCommitmentHasher.sol";
import {MockWithdrawVerifier} from "../MockWithdrawVerifier.sol";
import {WithdrawGroth16Verifier} from "../WithdrawGroth16Verifier.sol";
import {WithdrawVerifier} from "../WithdrawVerifier.sol";

/// DeployRegistry — the persistent on-chain deployer for T-DEPLOY-7.
///
/// Deploys `GatewayRegistry` (the gateway-operator stake the bootnode reads for
/// `stake`-mode admission) and, unless disabled, `StakedReputationSet` (the member
/// admission set). Every constructor argument is sourced from an environment variable
/// with a safe default, so the SAME script deploys to a local anvil, Sepolia, or a chosen
/// L2 by changing only `--rpc-url` and the env. It logs each deployed address and records
/// them to a JSON file the gateway/lib read (`contracts/deployed.local.json` by default).
///
/// This differs from `script/Deploy.s.sol` (the local demo-stack deployer) in two ways
/// that matter for a persistent testnet/L2 deployment:
///   1. It takes the ZK verifier + commitment hasher as ADDRESSES from env, so a real
///      pre-deployed RLN/Groth16 verifier can be wired in. It falls back to deploying the
///      in-repo Mock verifier/hasher ONLY when those env vars are unset, and shouts a
///      warning when it does, because the mocks are not zero-knowledge (testnet-only).
///   2. The output path is parameterized (RGOE_DEPLOY_OUT), so a simulation run can be
///      pointed at a scratch file and never clobber a committed record.
///
/// SCOPE: this file is deploy TOOLING. Broadcasting a real transaction (spending funds on
/// a live chain) is an operator action, gated behind `--broadcast` + a funded key, and is
/// documented in docs/ONCHAIN-DEPLOY.md. Running this script WITHOUT `--broadcast`
/// simulates the whole deploy against Foundry's in-memory EVM and sends nothing.
///
/// Reference implementation, unaudited, testnet-only.
///
/// Environment variables (all optional; defaults in parens):
///   RGOE_BOND_WEI          fixed stake denomination, wei         (0.01 ether)
///   RGOE_UNBONDING         exit time-lock, seconds               (300)
///   RGOE_MIN_UNBONDING     F+E+C lower bound the ctor enforces   (270)
///   RGOE_GATEWAY_OWNER     GatewayRegistry slashing/gov address  (0 => deployer)
///   RGOE_DEPLOY_STAKED     1 = also deploy StakedReputationSet   (1)
///   RGOE_WITHDRAW_VERIFIER pre-deployed IWithdrawVerifier addr   (0 => deploy per below)
///   RGOE_DEPLOY_REAL_VERIFIER 1 = deploy REAL Groth16 verifier   (0 => deploy Mock)
///                          (only when RGOE_WITHDRAW_VERIFIER unset; testnet-only VK)
///   RGOE_COMMITMENT_HASHER pre-deployed ICommitmentHasher addr   (0 => deploy Mock)
///   RGOE_RPC_URL           endpoint, recorded into the JSON      ("http://127.0.0.1:8545")
///   RGOE_DEPLOY_OUT        JSON output path                      ("contracts/deployed.local.json")
contract DeployRegistry is Cheats {
    function run()
        external
        returns (
            address gatewayRegistry,
            address stakedReputationSet,
            address withdrawVerifier,
            address commitmentHasher
        )
    {
        // ---- parameters (env-overridable) ------------------------------------
        uint256 bond = vm.envOr("RGOE_BOND_WEI", uint256(0.01 ether));
        uint256 unbonding = vm.envOr("RGOE_UNBONDING", uint256(300));
        uint256 minUnbonding = vm.envOr("RGOE_MIN_UNBONDING", uint256(270)); // F+E+C
        address gwOwner = vm.envOr("RGOE_GATEWAY_OWNER", address(0)); // 0 => deployer
        bool deployStaked = vm.envOr("RGOE_DEPLOY_STAKED", uint256(1)) != 0;
        address verifierAddr = vm.envOr("RGOE_WITHDRAW_VERIFIER", address(0));
        address hasherAddr = vm.envOr("RGOE_COMMITMENT_HASHER", address(0));
        // Opt-in: when no pre-deployed verifier address is given, deploy the REAL Groth16
        // exit-auth verifier (T-DEV-1) instead of the revealed-secret Mock. Default 0 keeps
        // the Mock so the local demo (scripts/demo-e2e.mjs, which authorizes by revealing the
        // secret) still works. The REAL verifier is TESTNET-ONLY until T-HARD-1 (untrusted VK).
        bool realVerifier = vm.envOr("RGOE_DEPLOY_REAL_VERIFIER", uint256(0)) != 0;

        console.log("== DeployRegistry ==");
        console.log("chainid    ", block.chainid);
        console.log("bond (wei) ", bond);
        console.log("unbonding  ", unbonding);
        console.log("minUnbond  ", minUnbonding);

        vm.startBroadcast();

        // ---- GatewayRegistry: the gateway-operator stake ---------------------
        // owner (slasher/governance) defaults to the deployer when 0 (ctor enforces it).
        GatewayRegistry gwReg = new GatewayRegistry(bond, unbonding, minUnbonding, gwOwner);
        gatewayRegistry = address(gwReg);

        // ---- StakedReputationSet: the member admission set (optional) --------
        if (deployStaked) {
            // Wire the real ZK verifier + hasher if their addresses were supplied;
            // otherwise deploy the in-repo mocks (TESTNET ONLY — not zero-knowledge).
            if (hasherAddr == address(0)) {
                MockCommitmentHasher mockHasher = new MockCommitmentHasher();
                hasherAddr = address(mockHasher);
                console.log("WARNING: deployed MockCommitmentHasher (testnet-only, not ZK)");
            }
            if (verifierAddr == address(0)) {
                if (realVerifier) {
                    // REAL Groth16 exit-auth verifier (T-DEV-1). Genuine ZK proof of knowledge
                    // of the identity secret; nothing revealed in calldata.
                    WithdrawGroth16Verifier groth16 = new WithdrawGroth16Verifier();
                    WithdrawVerifier realV = new WithdrawVerifier(groth16);
                    verifierAddr = address(realV);
                    console.log("deployed WithdrawVerifier (REAL Groth16 exit-auth)");
                    console.log("  WARNING: testnet-only VK (untrusted dev setup, T-HARD-1 pending)");
                } else {
                    MockWithdrawVerifier mockVerifier =
                        new MockWithdrawVerifier(ICommitmentHasher(hasherAddr));
                    verifierAddr = address(mockVerifier);
                    console.log("WARNING: deployed MockWithdrawVerifier (testnet-only, secret revealed in calldata)");
                }
            }

            StakedReputationSet set = new StakedReputationSet(
                bond,
                unbonding,
                minUnbonding,
                IWithdrawVerifier(verifierAddr),
                ICommitmentHasher(hasherAddr)
            );
            stakedReputationSet = address(set);
            withdrawVerifier = verifierAddr;
            commitmentHasher = hasherAddr;
        }

        vm.stopBroadcast();

        // ---- log + record ----------------------------------------------------
        console.log("GatewayRegistry     ", gatewayRegistry);
        if (deployStaked) {
            console.log("StakedReputationSet ", stakedReputationSet);
            console.log("withdrawVerifier    ", withdrawVerifier);
            console.log("commitmentHasher    ", commitmentHasher);
        } else {
            console.log("StakedReputationSet   (skipped: RGOE_DEPLOY_STAKED=0)");
        }

        _writeDeployment(
            gatewayRegistry, stakedReputationSet, commitmentHasher, withdrawVerifier, deployStaked
        );
    }

    /// Record the addresses to a JSON file the gateway/lib read to find the contracts.
    /// Path is env-overridable (RGOE_DEPLOY_OUT) so a simulation can target a scratch file
    /// and leave the committed `contracts/deployed.local.json` untouched.
    function _writeDeployment(
        address gwReg,
        address set,
        address hasher,
        address verifier,
        bool deployStaked
    ) internal {
        string memory outPath = vm.envOr("RGOE_DEPLOY_OUT", string("contracts/deployed.local.json"));
        string memory rpcUrl = vm.envOr("RGOE_RPC_URL", string("http://127.0.0.1:8545"));

        // stakedReputationSet/hasher/verifier are the zero address when the set is skipped;
        // the gateway/lib only need gatewayRegistry + rpcUrl for stake-mode admission.
        string memory setStr = deployStaked ? vm.toString(set) : "";
        string memory hasherStr = deployStaked ? vm.toString(hasher) : "";
        string memory verifierStr = deployStaked ? vm.toString(verifier) : "";

        string memory json = string.concat(
            "{\n",
            '  "gatewayRegistry": "', vm.toString(gwReg), '",\n',
            '  "stakedReputationSet": "', setStr, '",\n',
            '  "hasher": "', hasherStr, '",\n',
            '  "verifier": "', verifierStr, '",\n',
            '  "rpcUrl": "', rpcUrl, '"\n',
            "}\n"
        );
        vm.writeFile(outPath, json);
        console.log("wrote", outPath);
    }
}

/// Minimal `console.log` shim (staticcalls Foundry's console precompile), so this script
/// prints deployed addresses in `forge script` output without pulling in forge-std — the
/// same "no lib/ submodule" constraint that test/Cheats.sol exists to satisfy.
library console {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function _send(bytes memory payload) private view {
        address target = CONSOLE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            pop(staticcall(gas(), target, add(payload, 0x20), mload(payload), 0x00, 0x00))
        }
    }

    function log(string memory a) internal view {
        _send(abi.encodeWithSignature("log(string)", a));
    }

    function log(string memory a, address b) internal view {
        _send(abi.encodeWithSignature("log(string,address)", a, b));
    }

    function log(string memory a, uint256 b) internal view {
        _send(abi.encodeWithSignature("log(string,uint256)", a, b));
    }

    function log(string memory a, string memory b) internal view {
        _send(abi.encodeWithSignature("log(string,string)", a, b));
    }
}
