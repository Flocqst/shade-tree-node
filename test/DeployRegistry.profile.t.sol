// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cheats} from "./Cheats.sol";
import {DeployRegistry} from "../contracts/script/DeployRegistry.s.sol";

/// Fail-closed test for the public deployment entrypoint. A successful full Sepolia simulation
/// is also part of the release gate; this unit test makes a wrong-network broadcast impossible
/// before the script reaches startBroadcast().
contract DeployRegistryPublicProfileTest is Cheats {
    DeployRegistry script;

    function setUp() public {
        script = new DeployRegistry();
    }

    function _profile() internal {
        vm.setEnv("SHADE_TREE_PUBLIC_STAKE_PROFILE", "1");
        vm.setEnv("SHADE_TREE_DEPLOY_STAKED", "1");
        vm.setEnv("SHADE_TREE_DEPLOY_REGISTRY", "0");
        vm.setEnv("SHADE_TREE_GATEWAY_REGISTRY", "0x1111111111111111111111111111111111111111");
        vm.setEnv("SHADE_TREE_BOND_WEI", "800000000000000000");
        vm.setEnv("SHADE_TREE_UNBONDING", "86400");
        vm.setEnv("SHADE_TREE_MIN_UNBONDING", "3720");
    }

    function test_PublicProfileRejectsNonSepolia() public {
        _profile();
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "public stake profile is Sepolia-only"));
        script.run();
    }
}
