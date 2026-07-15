// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "../test/Cheats.sol";
import {StakedReputationSet, IWithdrawVerifier, ICommitmentHasher} from "../contracts/StakedReputationSet.sol";
import {MockCommitmentHasher} from "../contracts/MockCommitmentHasher.sol";
import {MockWithdrawVerifier} from "../contracts/MockWithdrawVerifier.sol";

/// Deploys the demo stack (hasher + verifier + StakedReputationSet) with the
/// docs/NEXT-VERSION.md demo params, then writes the addresses to
/// contracts/deployed.local.json for the gateway/lib to read.
///
/// Run against a local anvil:
///   anvil                                     # terminal 1
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url http://127.0.0.1:8545 \
///     --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
/// (anvil's well-known account #0 — a public test key, never real funds.)
contract Deploy is Cheats {
    // Demo parameters (docs/NEXT-VERSION.md). Env-overridable so a testnet deploy can
    // use a smaller bond than the local-anvil default (testnet ETH is faucet-scarce):
    //   RGOE_BOND_WEI, RGOE_UNBONDING, RGOE_MIN_UNBONDING.
    function run() external {
        uint256 bond = vm.envOr("RGOE_BOND_WEI", uint256(0.01 ether));
        uint256 unbonding = vm.envOr("RGOE_UNBONDING", uint256(300));
        uint256 minUnbonding = vm.envOr("RGOE_MIN_UNBONDING", uint256(270)); // F+E+C lower bound

        vm.startBroadcast();

        MockCommitmentHasher hasher = new MockCommitmentHasher();
        MockWithdrawVerifier verifier = new MockWithdrawVerifier(ICommitmentHasher(address(hasher)));
        StakedReputationSet set = new StakedReputationSet(
            bond,
            unbonding,
            minUnbonding,
            IWithdrawVerifier(address(verifier)),
            ICommitmentHasher(address(hasher))
        );

        vm.stopBroadcast();

        _writeDeployment(address(set), address(hasher), address(verifier));
    }

    function _writeDeployment(address set, address hasher, address verifier) internal {
        // rpcUrl defaults to local anvil; override with RGOE_RPC_URL for a fork/testnet.
        string memory rpcUrl = vm.envOr("RGOE_RPC_URL", string("http://127.0.0.1:8545"));
        string memory json = string.concat(
            "{\n",
            '  "stakedReputationSet": "', vm.toString(set), '",\n',
            '  "hasher": "', vm.toString(hasher), '",\n',
            '  "verifier": "', vm.toString(verifier), '",\n',
            '  "rpcUrl": "', rpcUrl, '"\n',
            "}\n"
        );
        vm.writeFile("contracts/deployed.local.json", json);
    }
}
