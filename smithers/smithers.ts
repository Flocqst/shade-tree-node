/**
 * Smithers schema + bound API for shipping the Shade Tree roadmap.
 *
 * This is the roadmap AS CODE. Each milestone in docs/ROADMAP.md is a node here, so a
 * contributor can run the whole build durably (`bun run up`), watch it, approve the human
 * gates, and resume after a crash, instead of hand-driving the steps. Milestones already
 * built (the on-chain set, RLN, the fleet directory, the bootnode) run as verify-and-harden
 * nodes whose `check` runs the REAL test commands (forge test, the node selftests); the
 * open milestones (productionization, live deploy) run as implement-and-review loops.
 *
 * createSmithers(schema) registers a Zod schema per output "table" and returns the
 * schema-bound builders. Every Task writes a validated row; a schema mismatch makes the
 * agent retry with the validation error as feedback. Mirrors the house pattern in
 * ~/orbital-fleet-build and ~/content-cockpit/flow.
 */
import { z } from "zod";
import { createSmithers, approvalDecisionSchema } from "smithers-orchestrator";

export const schema = {
  /** Workflow input (seeded via --input, all optional). */
  input: z.object({
    operator: z.string().default("dmarz"),
    // Restrict the run to a subset of milestone ids (e.g. ["bootnode","productionize"]).
    only: z.array(z.string()).default([]),
    // When true, the deploy milestone actually runs its scripts; otherwise it dry-runs.
    liveDeploy: z.boolean().default(false),
  }),

  /** Front human gate — reuses Smithers' own approval shape so the write always validates. */
  gate: approvalDecisionSchema,

  /** Per-milestone research note (scoped to just what the milestone needs). */
  research: z.object({
    milestone_id: z.string(),
    summary: z.string(),
    files_to_touch: z.array(z.string()).default([]),
    interfaces: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
  }),

  /** Per-milestone plan with machine-checkable acceptance + validation commands. */
  plan: z.object({
    milestone_id: z.string(),
    steps: z.array(z.string()),
    acceptance_criteria: z.array(z.string()).default([]),
    validation_commands: z.array(z.string()).default([]),
  }),

  /** Producer output of the per-milestone ReviewLoop (the actual work). */
  implementation: z.object({
    milestone_id: z.string(),
    summary: z.string(),
    files_changed: z.array(z.string()).default([]),
    commands_run: z.array(z.string()).default([]),
    notes: z.string().default(""),
  }),

  /** Reviewer output of the per-milestone ReviewLoop. MUST include `approved`. */
  review: z.object({
    milestone_id: z.string().default(""),
    approved: z.boolean(),
    findings: z
      .array(z.object({ severity: z.enum(["low", "medium", "high"]).default("low"), issue: z.string() }))
      .default([]),
    blocking_issues: z.array(z.string()).default([]),
  }),

  /** Objective, command-driven verdict (forge test, node selftests, doctor). */
  checkVerdict: z.object({
    milestone_id: z.string().default(""),
    passed: z.boolean(),
    results: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string().default("") })).default([]),
  }),

  /** Whole-system Panel: one row per reviewer lens. MUST include `approved`. */
  panelReview: z.object({ approved: z.boolean(), lens: z.string().default(""), issues: z.array(z.string()).default([]) }),

  /** Whole-system Panel: moderator synthesis. MUST include `approved`. */
  panelVerdict: z.object({ approved: z.boolean(), summary: z.string(), blocking: z.array(z.string()).default([]) }),

  /** Full local end-to-end suite verdict (build + run everything, assert). */
  e2e: z.object({ passed: z.boolean(), summary: z.string(), failures: z.array(z.string()).default([]) }),

  /** Deploy result (the new-droplet bootstrap; dry-run unless input.liveDeploy). */
  deploy: z.object({
    deployed: z.boolean(),
    dryRun: z.boolean().default(true),
    steps: z.array(z.string()).default([]),
    notes: z.string().default(""),
  }),
};

export const api = createSmithers(schema);

export const {
  Workflow,
  Task,
  Approval,
  Sequence,
  Parallel,
  Branch,
  Loop,
  smithers,
  outputs,
} = api;
