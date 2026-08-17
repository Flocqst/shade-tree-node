# smithers/ — ship the roadmap, durably

This is the [reputation-gated onion egress](../README.md) roadmap encoded as a
[Smithers](https://smithers.sh) workflow: each milestone in
[`docs/ROADMAP.md`](../docs/ROADMAP.md) is a node, so a contributor can run the whole
build durably, watch it, clear the human gates, and resume after a crash instead of
hand-driving every step. It is the "so others can build on it" artifact: fork it, add a
milestone to `MILESTONES` in `ship.tsx`, and run.

## What it does

```
brief-gate ............... HUMAN confirms the brief
per milestone, in parallel:
  research → plan → build-loop (implement ⇄ review until approved) → check (real tests)
panel .................... security / correctness / operability lenses
e2e ...................... run the full local suite green
ship-gate ................ HUMAN approves shipping
deploy ................... new-droplet bootstrap (dry-run unless liveDeploy)
```

Milestones already built (`staked-set`, `rln`, `fleet-directory`, `bootnode`) run their
loop as *verify-and-harden*; the `check` node runs the REAL commands (`forge test`, the
node selftests), so "done" is proven, not asserted. The open milestone (`productionize`)
runs as implement-and-review.

## Run it

Needs [Bun](https://bun.sh) ≥ 1.3 and Claude Code auth on the machine (the worker agents
use `ClaudeCodeAgent`, no API key).

```bash
cd smithers
bun install
bun run up                                   # full roadmap
bun run up -- --input '{"only":["productionize"]}'   # one milestone
bun run up -- --input '{"liveDeploy":true}'          # actually run the deploy node
bun run ps                                   # watch active runs
bun run resume                               # resume after a crash / an approval
```

The two `Approval` gates (`brief-gate`, `ship-gate`) suspend the run as a row until you
approve; nothing runs outward-facing without the `ship-gate`, and `deploy` is a dry-run
unless you pass `liveDeploy`.

## Files

| file | purpose |
|---|---|
| `smithers.ts` | Zod schema per output table + the schema-bound node builders |
| `agents.ts` | the worker agents (researcher, planner, implementer, reviewer, checker, panel, e2e, deployer) |
| `ship.tsx` | the milestone DAG |
| `smithers.config.ts` | pins the sqlite store |

The workspace is self-contained (its own `package.json`), so it never pulls Bun/Zod into
the main Node app's dependency set.
