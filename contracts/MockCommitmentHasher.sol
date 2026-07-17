// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RateCommitmentHasher} from "./RateCommitmentHasher.sol";

/// MockCommitmentHasher — DEPRECATED NAME, kept only so the existing deploy script keeps
/// compiling and deploys the correct hasher.
///
/// The commitment scheme moved from a single-input identity commitment
/// (`Poseidon(1)([secret])`) to the RLN **rate commitment**
/// (`Poseidon(2)([ Poseidon(1)([identitySecret]), 8 ])`), which is the actual Merkle
/// tree leaf in `circom-rln`. That real logic now lives in `RateCommitmentHasher`.
/// This subclass is a thin alias: `new MockCommitmentHasher()` yields a fully-correct
/// rate-commitment hasher. New code should reference `RateCommitmentHasher` directly.
contract MockCommitmentHasher is RateCommitmentHasher {}
