/** @jsxImportSource smithers-orchestrator */
/**
 * Ship the reputation-gated onion egress roadmap, durably.
 *
 * The shape (mirrors ~/orbital-fleet-build):
 *
 *   brief-gate ............... HUMAN confirms the brief
 *   per milestone, in parallel:
 *     research → plan → build-loop (implement ⇄ review until approved) → check (real tests)
 *   panel .................... whole-system review across security / correctness / operability
 *   e2e ...................... run the full local suite green
 *   ship-gate ................ HUMAN approves shipping
 *   deploy ................... new-droplet bootstrap (dry-run unless --input '{"liveDeploy":true}')
 *
 * Milestones already built run their loop as verify-and-harden; the `check` node runs the REAL
 * commands (forge test, the node selftests), so "done" is proven, never asserted. Run it:
 *
 *   cd smithers && bun install && bun run up
 *   # subset:  bun run up -- --input '{"only":["productionize"]}'
 *   # live:    bun run up -- --input '{"liveDeploy":true}'
 */
import { Workflow, Task, Approval, Sequence, Parallel, Loop, outputs, smithers } from "./smithers.ts";
import { researcher, planner, implementer, reviewer, checker, panelist, e2eRunner, deployer } from "./agents.ts";

type Milestone = { id: string; title: string; status: "built" | "open"; validate: string[]; notes: string };

// The roadmap, as an ordered milestone list. `validate` are commands that MUST exist in the repo.
const MILESTONES: Milestone[] = [
  { id: "staked-set", title: "On-chain staked reputation set (StakedReputationSet)", status: "built",
    validate: ["forge test --match-contract StakedReputationSetTest"],
    notes: "docs/ROADMAP-v1.md #2 + docs/ONCHAIN.md. Member commitment stake + ZK exit/withdraw + permissionless slash." },
  { id: "rln", title: "Unlinkable per-request rate limiting (RLN)", status: "built",
    validate: ["node lib/rln.selftest.mjs"],
    notes: "docs/ROADMAP-v1.md #1 (shipped as RLN, not the slot scheme): fresh share per request; 2nd signal reconstructs + slashes." },
  { id: "fleet-directory", title: "Signed fleet directory + client rotation", status: "built",
    validate: ["node group/sign-directory.mjs"],
    notes: "docs/FLEET.md. Static signed directory; each entry self-authenticating (onion IS its ed25519 key)." },
  { id: "bootnode", title: "Live bootnode discovery + GatewayRegistry", status: "built",
    validate: ["forge test --match-contract GatewayRegistryTest", "node bootnode/selftest.mjs"],
    notes: "docs/BOOTNODE.md. Gateways announce (onion-control + optional operator stake); onion NEVER on chain; bootnode is a cache, not a trust root." },
  { id: "productionize", title: "Productionization: CLI, Docker, docs, quickstart", status: "open",
    validate: ["node bin/rgoe.mjs doctor", "node bin/rgoe.mjs help"],
    notes: "Unified `rgoe` CLI (flags→RGOE_* env), Docker image + compose, docs/QUICKSTART.md + CLI.md + CONFIG.md." },
];

const PANEL_LENSES = ["security", "correctness", "operability"];

export default smithers((ctx) => {
  const only: string[] = ctx.input?.only ?? [];
  const liveDeploy: boolean = ctx.input?.liveDeploy ?? false;
  const milestones = MILESTONES.filter((m) => only.length === 0 || only.includes(m.id));

  return (
    <Workflow name="ship-rge-roadmap">
      <Sequence>
        <Approval
          id="brief-gate"
          output={outputs.gate}
          onDeny="fail"
          request={{
            title: "Confirm the roadmap build brief",
            summary: `Build/verify ${milestones.length} milestone(s): ${milestones.map((m) => m.id).join(", ")}. ` +
              `Deploy is ${liveDeploy ? "LIVE" : "dry-run"}.`,
          }}
        />

        <Parallel>
          {milestones.map((m) => (
            <Sequence key={m.id}>
              <Task id={`research-${m.id}`} agent={researcher} output={outputs.research} label={`research:${m.id}`}>
                {`Milestone "${m.id}" (${m.status}): ${m.title}.\n${m.notes}\n\n` +
                  `Read the relevant source + docs/ROADMAP.md and emit the research schema ` +
                  `(milestone_id="${m.id}", files_to_touch, interfaces, risks).`}
              </Task>

              <Task id={`plan-${m.id}`} agent={planner} output={outputs.plan} label={`plan:${m.id}`}>
                {`Plan milestone "${m.id}". Use the research from research-${m.id}. ` +
                  `Set milestone_id="${m.id}". validation_commands MUST include: ${m.validate.join(" ; ")}. ` +
                  `Give ordered steps + machine-checkable acceptance_criteria.`}
              </Task>

              <Loop id={`build-${m.id}`} until={ctx.latest?.(`review-${m.id}`)?.approved} maxIterations={m.status === "built" ? 2 : 4}>
                <Task id={`impl-${m.id}`} agent={implementer} output={outputs.implementation} label={`impl:${m.id}`}>
                  {`Implement/harden milestone "${m.id}" against plan-${m.id}. ` +
                    (m.status === "built"
                      ? `This is largely built: VERIFY it holds, fix any gap the reviewer flagged, do not rewrite working code. `
                      : `Build the remaining pieces. `) +
                    `Run the validation_commands and set milestone_id="${m.id}".`}
                </Task>
                <Task id={`review-${m.id}`} agent={reviewer} output={outputs.review} label={`review:${m.id}`}>
                  {`Adversarially review milestone "${m.id}" (impl-${m.id}). Set milestone_id="${m.id}". ` +
                    `approved=true only if correct AND the validation_commands pass AND (for bootnode) the onion is ` +
                    `never on chain and the bootnode is never a trust root.`}
                </Task>
              </Loop>

              <Task id={`check-${m.id}`} agent={checker} output={outputs.checkVerdict} label={`check:${m.id}`}>
                {`Run EXACTLY these and report passed only if all exit 0 (milestone_id="${m.id}"):\n` +
                  m.validate.map((c, i) => `  ${i}. ${c}`).join("\n")}
              </Task>
            </Sequence>
          ))}
        </Parallel>

        <Parallel>
          {PANEL_LENSES.map((lens) => (
            <Task key={lens} id={`panel-${lens}`} agent={panelist} output={outputs.panelReview} label={`panel:${lens}`}>
              {`Review the ASSEMBLED system through the ${lens} lens. Emit lens="${lens}", approved, issues.`}
            </Task>
          ))}
        </Parallel>

        <Task id="e2e" agent={e2eRunner} output={outputs.e2e} label="e2e">
          {`Run the full local suite green: forge test ; node bootnode/selftest.mjs ; ` +
            `node gateway/shim.selftest.mjs ; node lib/rln.selftest.mjs ; node bin/rgoe.mjs doctor. ` +
            `Report passed + summary + any failures verbatim.`}
        </Task>

        <Approval
          id="ship-gate"
          output={outputs.gate}
          onDeny="fail"
          request={{ title: "Approve shipping", summary: "All milestones checked + e2e green. Approve to run the deploy node." }}
        />

        <Task id="deploy" agent={deployer} output={outputs.deploy} label="deploy">
          {`Run the new-droplet bootstrap (bootnode/deploy/). liveDeploy=${liveDeploy}. ` +
            (liveDeploy ? `Execute the prepared idempotent scripts and report each step.` : `DRY-RUN: print the exact steps/commands, execute nothing outward-facing.`)}
        </Task>
      </Sequence>
    </Workflow>
  );
});
