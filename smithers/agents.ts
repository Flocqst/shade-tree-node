/**
 * Worker agents for the ship-the-roadmap workflow. ClaudeCodeAgent uses the machine's
 * Claude Code auth (no API key). cwd is the repo, so every agent reads and edits the real
 * source and runs the real tests. "Sandwich delegation": the smart model plans and reviews
 * at the ends; a capable model implements the middle.
 */
import { ClaudeCodeAgent } from "smithers-orchestrator";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root is this file's parent's parent (smithers/ lives inside the repo).
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const base = {
  cwd: REPO,
  permissionMode: "bypassPermissions" as const,
  idleTimeoutMs: 300_000,
  timeoutMs: 1_800_000,
};
const JSON_CONTRACT =
  "Return ONLY a single JSON object matching the requested output schema. No prose, no markdown fences.";

export const researcher = new ClaudeCodeAgent({
  ...base,
  model: "sonnet",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  instructions:
    "You scope one milestone of a Tor onion-egress system (zk membership + RLN + a discovery " +
    "bootnode). Read the relevant source and docs/ROADMAP.md, then emit exactly the files to " +
    "touch, the interfaces involved, and the real risks. Be concrete and repo-specific. " + JSON_CONTRACT,
});

export const planner = new ClaudeCodeAgent({
  ...base,
  model: "opus",
  allowedTools: ["Read", "Grep", "Glob"],
  instructions:
    "You turn a milestone + its research into a plan with TEETH: ordered steps, machine-checkable " +
    "acceptance criteria, and concrete validation_commands that actually exist in this repo " +
    "(e.g. `forge test --match-contract GatewayRegistryTest`, `node bootnode/selftest.mjs`, " +
    "`node bin/rgoe.mjs doctor`). Review is cheap on a plan and miserable on a diff, so make the " +
    "plan verifiable. " + JSON_CONTRACT,
});

export const implementer = new ClaudeCodeAgent({
  ...base,
  model: "sonnet",
  allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  instructions:
    "You implement one milestone against its plan. Match the house style (thorough header comments " +
    "explaining WHY, honest scope notes, zero new deps where possible, no em dashes). Run the plan's " +
    "validation_commands yourself and report what passed. Never claim done without running the tests. " + JSON_CONTRACT,
});

export const reviewer = new ClaudeCodeAgent({
  ...base,
  model: "opus",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  instructions:
    "You are an adversarial reviewer for a privacy/crypto system. Check correctness, that the onion is " +
    "never put on chain, that the bootnode is never a trust root (clients re-verify), replay/nonce/TTL " +
    "handling, and that claims match code. Set approved=false with blocking_issues if anything is wrong " +
    "or unproven. Prefer rejecting a plausible-but-unverified change. " + JSON_CONTRACT,
});

export const checker = new ClaudeCodeAgent({
  ...base,
  model: "sonnet",
  allowedTools: ["Bash", "Read"],
  instructions:
    "You are the objective gate. Run each of the milestone plan's validation_commands EXACTLY, and report " +
    "passed=true only if all exit 0. Put each command's id, ok, and a one-line detail (or the failure tail) " +
    "in results. Do not edit code; only run and report. " + JSON_CONTRACT,
});

export const panelist = new ClaudeCodeAgent({
  ...base,
  model: "opus",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  instructions:
    "You are one lens on a whole-system review panel (security, correctness, or operability). Judge the " +
    "assembled system, not one file. Emit your lens, approved, and any issues. " + JSON_CONTRACT,
});

export const e2eRunner = new ClaudeCodeAgent({
  ...base,
  model: "sonnet",
  allowedTools: ["Bash", "Read"],
  instructions:
    "You run the full local suite and assert it green: `forge test`, `node bootnode/selftest.mjs`, " +
    "`node gateway/shim.selftest.mjs`, `node lib/rln.selftest.mjs`, and `node bin/rgoe.mjs doctor`. " +
    "Report passed + a one-line summary + any failures verbatim. Never call it done without an e2e run. " + JSON_CONTRACT,
});

export const deployer = new ClaudeCodeAgent({
  ...base,
  model: "opus",
  allowedTools: ["Read", "Bash"],
  instructions:
    "You run the new-droplet bootstrap for the bootnode + gateway (bootnode/deploy/). If liveDeploy is " +
    "false, DRY-RUN: print the exact steps and commands without executing anything outward-facing. If " +
    "true, execute only the prepared, idempotent scripts and report each step. Never invent destructive " +
    "commands. " + JSON_CONTRACT,
});
