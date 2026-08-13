# Ship plan: from working reference to robustly shipped

This is the execution roadmap to take reputation-gated onion egress from a working,
tested reference implementation to something robustly deployed, monitored, documented,
and safe for others to run. It is the source of truth for the autonomous build loop.

For the *protocol design* milestones (what each feature is and why) see
[`ROADMAP.md`](ROADMAP.md). This doc is the *shipping* backlog: concrete, checkable
tasks across every workstream, prioritized, with acceptance criteria.

---

## Loop protocol (how an iteration works)

Each loop iteration:

1. Read this file. Pick the **highest-priority unchecked task** whose dependencies are
   met (P0 before P1 before P2; within a tier, top-down). Prefer finishing an in-progress
   item over starting a new one.
2. Implement ONE vertical slice completely: code + tests + docs for that task.
3. **Gate before commit:** `npm test` green (node selftests + `forge test`), plus the
   task's own acceptance criteria demonstrated. Never commit red.
4. Check the box here, add a one-line entry to the [Changelog](#changelog) with the date,
   commit (conventional-commit message, `Co-Authored-By` trailer), and push.
5. Stop. The next iteration picks up the next task.

**Definitions of done (apply to every task):**
- Every new module ships with a `*selftest.mjs`; every wire/parse surface gets an
  adversarial test; every contract change gets a Foundry test.
- Docs updated in the same slice (never a separate "docs later" task).
- No secret ever committed or logged. No new dependency without a note on why.
- Honest scope: if a task is partially done, split it and mark what remains.

**Never do autonomously (flag for the human instead):** rotate/replace production onion or
operator keys, spend real funds, run a trusted-setup ceremony, deploy a breaking change to a
live gateway serving members, or merge to `main` without CI green.

---

## Sequencing and release gates

**We do NOT deploy live until the code is hardened by tests and the distributable client
exists.** Order of operations:

1. **Gate 1 — Test hardening (workstream 2).** Every P0 test task done: real-Tor integration,
   fuzz/property tests on every parser, remaining unit selftests, the consolidated adversarial
   suite, contract fuzz + invariants, coverage gates. The suite must be deep enough that an
   auditor and the loop both trust "green" completely.
2. **Gate 2 — Rust client (workstream 7b).** The conformance harness plus a Rust client MVP that
   passes it and egresses byte-for-byte like the JS reference. This is the client people actually
   run, so it exists before we invite anyone to a live fleet.
3. **Gate 3 — Deploy (workstream 3).** Only now: first live deployment, multi-gateway, IaC,
   systemd hardening, monitoring wired.

Development-correctness P0s (workstream 1) run alongside Gate 1 (they are what the tests test).

## Current focus

> **Pre-ship. Do NOT deploy.** Drive Gate 1 (test hardening) and Gate 2 (Rust client) to done first.
> Next up: **T-TEST-3** (fill remaining unit selftests) and **T-TEST-2** (fuzz/property tests),
> then **T-TEST-1** (real-Tor integration) and **T-RUST-1** (conformance harness).
> `T-DEPLOY-*` is BLOCKED until Gate 1 + Gate 2 are green.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `(Pn)` priority.

---

## 1. Development & correctness  *(go hard here)*

Protocol and code gaps between "works in the happy path" and "correct under an adversary
and at scale."

- [ ] **T-DEV-1 (P0) Real exit-auth verifier.** Replace `MockWithdrawVerifier` with the real
  Groth16 verifier so `StakedReputationSet.initiateExit`/`withdraw` are genuinely ZK-authorized
  (prove knowledge of the identity secret) on chain. *Accept:* a withdrawal with a bogus proof
  reverts `BadProof`; a valid one succeeds; Foundry test with the real verifier.
- [ ] **T-DEV-2 (P0) RLN leaf removal parity.** `reconstructRoot` rebuilds a fresh tree of
  survivors (renumbering indices); an on-chain slash that zeroes a leaf in place would diverge
  (`lib/root-provider.mjs` COORDINATION note). Make JS and contract agree on removal semantics.
  *Accept:* register 3, slash the middle, both sides compute the identical root; test.
- [ ] **T-DEV-3 (P0) Message-to-target binding.** Bind the RLN signal to the request target so a
  captured envelope cannot be redirected to a different destination within the tunnel. *Accept:*
  an envelope built for `a.com:443` is rejected if replayed against `b.com:443`; test.
- [ ] **T-DEV-4 (P1) Bootnode persistence.** The registry is in-memory, so a restart drops the
  whole fleet until every gateway re-announces. Write-through to a small store (JSON/sqlite) and
  reload verified entries on boot (re-checking freshness). *Accept:* announce, restart the
  bootnode, `/directory` still lists live entries; test with an injected clock.
- [ ] **T-DEV-5 (P1) Client zero-trust operator re-verification.** In stake mode, the client
  should fetch `GET /gateway/<onion>` and re-verify `operatorSig` + `isStaked(operator)` itself,
  not trust the bootnode's `staked` label. *Accept:* a bootnode that pairs a staked operator with
  an onion that operator never signed is rejected client-side; test.
- [x] **T-DEV-6 (P1) Announce rate-limiting + per-onion caps.** DONE (loop-2, from the audit):
  per-onion re-announce throttle (`RGOE_BOOTNODE_MIN_REANNOUNCE`, cheap pre-verify reject),
  registry size cap (`RGOE_BOOTNODE_MAX_ENTRIES`; a new onion is refused when full, existing ones
  still refresh), and self-attested `weight` clamped to `MAX_WEIGHT=1000` so one gateway cannot
  capture ~all client traffic. Tested in `bootnode/selftest.mjs` (registry hardening).
- [ ] **T-DEV-7 (P1) Config validation + fail-fast.** Every entrypoint validates required config
  and prints a precise error + nonzero exit on bad/missing values (bad onion, missing signer, bad
  address, unreachable RPC). *Accept:* a table-driven selftest of bad configs per command.
- [ ] **T-DEV-8 (P1) Graceful shutdown / connection draining.** Gateway and bootnode handle
  SIGTERM: stop accepting, drain in-flight, exit clean. *Accept:* a request in flight during
  SIGTERM completes; test.
- [ ] **T-DEV-9 (P2) On-chain incremental tree + root accessor.** So `LightClientRootProvider`
  works (it currently throws). Put the root in a storage slot provable via `eth_getProof`. *Accept:*
  the light provider returns a root validated against a header; test.
- [ ] **T-DEV-10 (P2) Configurable egress policy.** Beyond `:443`-only: an allow/deny list of
  target host:port ranges, default-deny. *Accept:* policy enforced + logged; test.
- [ ] **T-DEV-11 (P2) Directory scale.** Compress/paginate `/directory`; bound entry count; a
  stable ETag so clients can skip unchanged fetches. *Accept:* 10k-entry directory served + fetched
  under a size/latency budget; load test.
- [ ] **T-DEV-12 (P2) Bootnode active health probing.** Optionally dial each announced onion and
  reflect reachability in `health`, so a silently-dead gateway is demoted before a client hits it.

## 2. Testing  *(go hard here — this is Gate 1)*

**Testing philosophy for this project.** It is a privacy/crypto system, so a test is only
worth something if it can *fail* on a real defect. Bias toward: adversarial inputs over happy
paths; golden/differential fixtures over hand-rolled expected values (so JS and the coming Rust
client are checked against the *same* vectors); property + fuzz over example-based where a
surface takes untrusted bytes; and killing a mutant (does the test catch a flipped comparison?)
over line coverage. Every parser, every signature check, and every state machine (spent-set,
slash, stake lifecycle) gets negative and concurrent cases, not just a positive one.

- [ ] **T-TEST-1 (P0) Real-Tor local fleet integration test.** `test/integration/fleet-e2e.mjs`:
  bring up an ephemeral tor + bootnode + 2 gateways + client; assert discovery, a successful
  egress, per-request rotation across both gateways, failover when one is killed, and a live
  over-spend → on-chain slash (against anvil). Gated behind `RGOE_IT=1` (needs tor). *Accept:*
  green on a tor-capable box; documented skip otherwise.
- [x] **T-TEST-2 (P0) Fuzz/property tests.** `test/fuzz.selftest.mjs` (seeded mulberry32, replayable):
  hostile input to `onionToPubkey`, `parseHttp`, `verifyDirectory`, `verifyAnnounce` (total, garbage
  => ok:false, never throws/hangs), plus the round-trip and `canonicalDirectoryBytes`
  permutation-invariance properties. Passes across seeds. *Remaining:* envelope/`validTarget` parse
  (not yet exported) and address-encoding fuzz — fold in with T-DEV-7.
- [~] **T-TEST-3 (P0) Fill remaining unit selftests.** DONE: `lib/root-provider.mjs`
  (`lib/root-provider.selftest.mjs`, 12 assertions w/ a `newGroup` oracle); `lib/semaphore.mjs` /
  `lib/rln.mjs` epoch + signal primitives (`lib/semaphore.selftest.mjs`, 17 assertions — currentEpoch
  boundary/monotonicity, requestSignal determinism = the deterministic-retry invariant). REMAINING:
  `group/enroll.mjs` (commitment-only, secret stays local), `group/sign-directory.mjs`,
  `bootnode/heartbeat.mjs` (operator resolution). *Accept:* each has a selftest the runner discovers.
- [ ] **T-TEST-4 (P0) Consolidated adversarial/security suite.** `test/security/`: poisoned
  directory, MITM bootnode, replay, stake lapse mid-session, grafted onion, over-budget slash,
  signer swap. Some exist in module selftests; consolidate + expand into one auditable place.
- [ ] **T-TEST-5 (P1) Foundry fuzz + invariants + gas.** Fuzz `register/exit/withdraw/slash`
  (random bonds, addresses, timings); invariants (`activeCount` == live stakes; contract balance
  == sum of live bonds); `forge snapshot` gas baseline in CI; `forge coverage` with a floor. *Accept:*
  fuzz + invariant runs green in CI; coverage gate set.
- [ ] **T-TEST-6 (P1) Node coverage gate.** Wire `c8` over the selftests; fail CI below a set
  threshold; publish the report. *Accept:* `npm run coverage` + CI gate.
- [ ] **T-TEST-7 (P1) Load/soak tests.** Bootnode announce storm (K onions × M heartbeats),
  gateway request throughput, concurrent directory fetch; assert bounded memory (no leak over a
  soak) and stable latency. *Accept:* a `test/load/` harness + a recorded baseline.
- [ ] **T-TEST-8 (P1) Deploy bootstrap e2e in a container.** Run `bootnode/deploy/bootstrap.sh`
  inside an Ubuntu container in CI (or a documented local job); assert services start and onions
  publish. *Accept:* the bootstrap is tested, not just hand-run once.
- [ ] **T-TEST-9 (P1) CI matrix + lint + audit.** Node 20/22/24; with/without foundry; add eslint
  + prettier checks; `npm audit --audit-level=high` gate; ZK-artifact hash check vs `ARTIFACTS.md`.
- [ ] **T-TEST-10 (P2) Mutation testing.** Stryker over the verify/slash/directory paths to prove
  the tests actually catch regressions. *Accept:* mutation score reported; obvious survivors killed.
- [x] **T-TEST-11 (P0) Golden crypto fixtures (shared with Rust).** DONE (loop-4):
  `testdata/vectors.json` (fixed test seeds) + `test/vectors.selftest.mjs` re-derive and byte-pin
  the deterministic surfaces: key→onion derivation, `canonicalDirectoryBytes`, the ed25519 directory
  signature, `canonicalAnnounceBytes`, the announce onion signature, and the operator-auth message.
  This is both a regression guard for the JS wire formats and the anti-drift contract T-RUST-1 will
  check the Rust client against. *Note:* RLN Groth16 proofs are non-deterministic, so they are
  verified for equivalence (`lib/rln.selftest.mjs`), not byte-pinned here.
- [ ] **T-TEST-12 (P0) RLN slash-math property test.** Over many random (secret, epoch, slot)
  triples and message pairs: one signal never slashes; two distinct signals on one nullifier ALWAYS
  reconstruct the exact secret and derive the right rateCommitment; a distinct nullifier never
  cross-triggers. *Accept:* thousands of randomized rounds, zero false slash / zero missed slash.
- [ ] **T-TEST-13 (P1) Concurrency / race tests.** Hammer the gateway spent-set with concurrent
  `admit()` on the same nullifier (honest replay vs over-spend interleavings) and the bootnode
  registry with concurrent announces; assert exactly-once slash and no lost/duplicated entries.
  *Accept:* deterministic outcome under N concurrent workers.
- [ ] **T-TEST-14 (P1) Chaos / failure-injection e2e.** In the real-Tor integration harness: kill a
  gateway mid-request (client fails over, no dropped connection to the caller), drop the bootnode
  (client uses last-known-good), lapse an operator's stake mid-session (entry demoted). *Accept:*
  each fault has a passing scenario.
- [ ] **T-TEST-15 (P1) Fuzz regression corpus.** Persist any crashing/hanging input a fuzzer finds
  into `testdata/corpus/` and replay it as a fast regression on every run. *Accept:* corpus wired
  into the suite; a seeded known-bad input is caught.
- [ ] **T-TEST-16 (P2) Timing/side-channel sanity.** Assert verify latency is independent of which
  member proved (no fingerprint via timing), reusing the crypto bench. *Accept:* spread within noise
  across members, recorded.

## 3. Deployment & infrastructure

- [ ] **T-DEPLOY-1 (P0, BLOCKED by Gate 1 + Gate 2) First live deployment.** Deploy the bootnode +
  a gateway (to `anon-egress` or a fresh droplet), announce the gateway, and verify a laptop client
  egresses through the fleet end to end. Do NOT start until the test suite is hardened and the Rust
  client MVP passes conformance. *Accept:* `curl -x` through the client returns the gateway IP;
  `/directory` lists it. Take care not to disrupt the existing live gateway on `anon-egress`.
- [ ] **T-DEPLOY-2 (P1) Multi-gateway across regions/ASNs.** At least 2 gateways on different
  providers/regions so rotation spreads the both-ends AS vantage. *Accept:* directory shows ≥2, the
  client rotates across them.
- [ ] **T-DEPLOY-3 (P1) Infra-as-code.** Provision + configure the fleet via OpenTofu + Ansible
  (in `agent-devops`), not hand-ssh. *Accept:* `tofu apply` + a playbook stand up a gateway
  reproducibly.
- [ ] **T-DEPLOY-4 (P1) Systemd hardening.** `NoNewPrivileges`, `ProtectSystem=strict`,
  `PrivateTmp`, `ProtectHome`, `MemoryMax`, `TasksMax`, minimal `CapabilityBoundingSet` on all
  units. *Accept:* `systemd-analyze security` score improved; services still work.
- [ ] **T-DEPLOY-5 (P1) Onion key backup/restore.** Documented, encrypted, off-box backup of HS
  keys + a tested restore. *Accept:* restore a gateway's onion on a new box from backup.
- [ ] **T-DEPLOY-6 (P2) Zero-downtime rolling update** across the fleet (drain → update → rejoin).
- [ ] **T-DEPLOY-7 (P2) Persistent on-chain deployment** of `GatewayRegistry` + `StakedReputationSet`
  wired to the live fleet (reuse Sepolia or a chosen L2).

## 4. Website & status

- [ ] **T-WEB-1 (P1) Live fleet status page.** Pull bootnode `/health` + `/directory` (via a
  tor-capable fetch or a small server-side proxy) and show fleet size, per-gateway health, last
  announce, bootnode reachability. No operator identities. *Accept:* a deployed page that updates.
- [ ] **T-WEB-2 (P2) Landing refresh.** Extend the existing write-up site with "run a gateway" and
  "join the set" sections and the CLI quickstart.
- [ ] **T-WEB-3 (P2) Docs site.** Render `docs/` as a browsable site.
- [ ] **T-WEB-4 (P3) Fleet map** (regions/ASNs, privacy-preserving).

## 5. Documentation

- [ ] **T-DOC-1 (P1) Operator runbook.** Deploy, monitor, rotate keys, respond to a slash, retire a
  gateway, join the fleet. *Accept:* `docs/OPERATOR.md`.
- [ ] **T-DOC-2 (P1) Incident response playbook.** Bootnode down, gateway compromised, key leak,
  chain/RPC outage, mass-DROP spike. *Accept:* `docs/INCIDENT.md`.
- [ ] **T-DOC-3 (P1) Wire-protocol + API spec.** The bootnode HTTP API and the envelope/announce
  wire formats, versioned. *Accept:* `docs/PROTOCOL-API.md`.
- [ ] **T-DOC-4 (P2) SECURITY.md** (disclosure policy) + **CONTRIBUTING.md** + ADRs for the load-
  bearing decisions (onion-off-chain, bootnode-as-cache, RLN-over-slot).

## 6. Hardening

- [ ] **T-HARD-1 (P0) Real trusted setup / artifact provenance.** Replace the untrusted testnet ZK
  artifacts; document the ceremony or pin audited artifacts; CI verifies hashes. *(Flag the ceremony
  itself for the human.)*
- [ ] **T-HARD-2 (P1) Supply chain.** Pin deps, commit the lockfile, `npm audit` gate,
  `npm ci --ignore-scripts` where possible, Dependabot. *Accept:* audit gate green in CI.
- [ ] **T-HARD-3 (P1) Log hygiene.** Assert no secret (member secret, operator key, onion seed) is
  ever logged; add a scrubbing test. *Accept:* a selftest greps captured logs for secret material.
- [~] **T-HARD-4 (P1) Endpoint hardening.** DONE (loop-2): the client's response read from the
  semi-trusted bootnode is now capped (`RGOE_BOOTNODE_MAX_RESP`, was unbounded => OOM lever), and
  the server's oversized-body rejection is tested. REMAINING: slow-loris/idle-timeout on the
  gateway tunnel, per-connection limits, request timeouts on the bootnode server, and a GLOBAL
  announce token-bucket (loop-3 self-review: the per-onion throttle does not slow an attacker
  minting fresh onions until the size cap fills, so up to `maxEntries` ed25519 verifies are
  reachable in a burst; a global rate cap throttles that pre-full).
- [ ] **T-HARD-5 (P2) Directory signer rotation.** Versioned signer with an overlap window so the
  pinned key can rotate without a flag day. *Accept:* clients accept old+new during overlap; test.
- [ ] **T-HARD-6 (P2) Contract audit prep.** Reentrancy/overflow re-review, consider an owner-slash
  timelock, static analysis (slither), a written invariants doc for auditors.
- [ ] **T-HARD-7 (P2) Tor hardening.** Vanguards-lite, PoW tuning, optional client-auth for a
  private fleet.

## 7b. Client implementation language (decision + Rust client)

**Decision (ADR).** Keep the **JavaScript client as the reference** implementation: it defines
the wire protocol and shares the security-critical checks (`lib/directory.mjs` onion↔key binding,
`verifyDirectory`, envelope format) with the gateway and bootnode, so there is exactly one source
of truth for those checks. Build a **Rust client as the distributable** for going live. The Rust
client is not chosen for raw speed (RLN proving already runs in wasm/native) but for two things JS
cannot match:

1. **Single static binary** distribution — no "install Node + npm install" for the people who run
   the client.
2. **Embedded Tor via [`arti`](https://gitlab.torproject.org/tpo/core/arti)** — the client is its
   own Tor client, removing the system-`tor`-daemon + SOCKS + `torrc` friction that is the biggest
   wart in the current client UX (and a security win: no separate process).

Stack: `arti` (Tor), [`zerokit`](https://github.com/vacp2p/zerokit) (PSE's canonical Rust RLN),
`alloy` (chain reads), `tokio`/`hyper`. The gateway and bootnode stay JS by default (operator-
controlled env; little upside to a rewrite, real risk in duplicating the trust-critical checks),
but T-RUST-0 records the full-stack option explicitly so it is a decision, not a drift.

This is **Gate 2**: the Rust client MVP (T-RUST-1 + T-RUST-2) must pass conformance before any live
deploy, because it is the client people will actually run.

- [ ] **T-RUST-0 (P1) Rust workspace + language ADR.** Scaffold a `rust/` cargo workspace
  (`rgoe-client` bin + a `rgoe-proto` lib for the shared checks) and write the ADR that pins the
  boundary: JS reference vs Rust distributable, and whether/when the gateway+bootnode also move to
  Rust (criteria: a second operator, an embedded/mobile target, or a security review demanding one
  language). *Accept:* `rust/` builds an empty workspace in CI; `docs/adr/` entry.
- [~] **T-RUST-1 (P1) Wire-format conformance harness.** SEEDED by T-TEST-11: `testdata/vectors.json`
  is the language-neutral fixture set and the JS side already reproduces every value
  (`test/vectors.selftest.mjs`). REMAINING: document the vector format in the wire spec (T-DOC-3) and
  add a Rust-side runner that asserts the same bytes, so the harness gates both implementations.
  *Accept:* the JS client reproduces every fixture (done); a Rust runner reproduces them too.
- [ ] **T-RUST-2 (P1) Rust client MVP.** `arti`-dialed onion connect + envelope send + tunnel, with
  the directory fetched and verified (onion↔key binding + pinned-signer signature) in Rust. RLN
  proving via `zerokit`. *Accept:* passes T-RUST-1 conformance; egresses through a live gateway
  byte-for-byte like the JS client.
- [ ] **T-RUST-3 (P2) Rust client parity.** Per-request slot + gateway rotation, failover,
  last-known-good caching, bootnode discovery — full parity with `client/rgoe-client.mjs`. *Accept:*
  the real-Tor integration test (T-TEST-1) passes with the Rust client swapped in.
- [ ] **T-RUST-4 (P2) Release binaries.** Cross-compiled static binaries (linux x86_64/arm64,
  macOS, windows) in CI releases; `rgoe` install without a runtime. *Accept:* a downloadable binary
  runs on a clean box with no Node/Tor installed.

## 7. Monitoring & observability

- [ ] **T-MON-1 (P1) Structured logging.** JSON logs with levels across gateway + bootnode; no
  secrets. *Accept:* logs parse; level configurable.
- [ ] **T-MON-2 (P1) Prometheus metrics.** Gateway: pass/drop/slash counters, verify-latency
  histogram, active tunnels. Bootnode: announces accepted/rejected by reason, directory size, fetch
  count. *Accept:* a `/metrics` endpoint (loopback) per role + tests.
- [ ] **T-MON-3 (P1) Dashboards + alerts.** Grafana dashboards (reuse the local OTel→Grafana stack)
  and alerts: gateway/bootnode down, slash event, stake lapse, announce-rejection spike. *Accept:*
  a dashboard JSON + alert rules in-repo.
- [ ] **T-MON-4 (P2) External uptime checks** against onion `/health` via a tor-capable prober.
- [ ] **T-MON-5 (P2) SLOs + error budget** for fleet availability and egress success rate.

---

## 8. Feature backlog (extensions)

New capabilities beyond hardening the current design. Post-Gate features unless noted; the loop
adds to this as it goes and pulls from it once Gates 1-2 are green.

- [ ] **T-FEAT-1 (P1) Bootnode federation / gossip.** More than one bootnode, gossiping announces
  so discovery is not a single availability point. A client can pin multiple bootnode signers and
  union their (independently-verified) directories. *Accept:* two bootnodes converge on the same
  live set; a client survives one going dark. *Why now-ish:* the bootnode is the one new
  single-point-of-availability the fleet added; this closes it.
- [ ] **T-FEAT-2 (P1) `rgoe join` guided onboarding.** One interactive command that does keygen +
  self-enroll + (optional) on-chain register + prints the exact client invocation, so a new member
  or gateway operator has a single front door. *Accept:* a fresh user joins the local fleet with one
  command.
- [ ] **T-FEAT-3 (P1) Client SDK packaging.** Publish `client/rgoe-client.mjs` as an npm package and
  the coming Rust client as a crate, both behind the conformance harness, so agents/apps embed the
  client instead of shelling the proxy. *Accept:* `import { RgoeClient }` from the published package
  works against a live fleet.
- [ ] **T-FEAT-4 (P2) Quality-aware rotation.** Clients report anonymized latency/success back; the
  bootnode aggregates it into the advertised `weight`/`health` (never per-member), so rotation
  favors good gateways beyond static weight. Must not become a linkability channel. *Accept:*
  a slow gateway loses weight fleet-wide; a privacy note proving no member is fingerprinted.
- [ ] **T-FEAT-5 (P2) Deterministic member subkeys.** Derive per-epoch or per-context commitments
  from one master secret (HD-style) so a member can rotate its on-chain commitment without a new
  enrollment ceremony, and hold several unlinkable personas from one backup. *Accept:* subkeys
  derive deterministically; each is independently enrollable + provable.
- [ ] **T-FEAT-6 (P2) Directory delta protocol.** `GET /directory?since=<etag>` returns only
  changed entries, so large fleets are cheap to keep fresh. *Accept:* a delta fetch after no change
  returns empty; after one announce returns one entry; client applies deltas + re-verifies.
- [ ] **T-FEAT-10 (P2, added loop-4) Gateway capability advertisement + capability-aware selection.**
  Gateways advertise capabilities in their signed announce (allowed egress ports/policy, a region/AS
  hint, protocol versions); clients select gateways matching the request's needs, so the fleet goes
  from "any gateway" to "the right gateway" as egress policy grows (T-DEV-10). Capabilities must be
  coarse enough not to fingerprint a member's request. *Accept:* an announce carries signed
  capabilities; a client needing port X only selects gateways advertising X; capability set is
  bucketed, not free-form.
- [ ] **T-FEAT-9 (P2, added loop-3) Threshold-signed directory.** Today the directory trusts one
  bootnode signer key; compromising it poisons every client's fleet view (they still can't be sent a
  forged onion — onion-control is re-checked — but entries could be omitted/reordered). Sign the
  directory with a k-of-n set of independent bootnode signers so no single key compromise steers the
  fleet. Composes with T-FEAT-1 (federation): each federated bootnode is one signer. *Accept:*
  clients accept a directory only with >= k valid signatures from the pinned signer set; a single
  rogue signer cannot produce an accepted directory. *Depends on:* T-FEAT-1.
- [ ] **T-FEAT-8 (P2, added loop-2) Reputation-weighted rate budget.** Today membership is binary
  and every member gets the same per-epoch slot budget `K`. Let standing scale the budget: a member
  with higher on-chain stake (or accrued good behavior) proves, in zero knowledge, a budget tier and
  gets a larger `K`, without revealing which member. Makes "reputation" a spectrum, not a bit, while
  keeping unlinkability. *Accept:* two tiers with different K, each proven in ZK; the gateway enforces
  the proven tier; a member cannot claim a tier they lack. *Depends on:* the RLN circuit taking a
  tier as a range-checked public input (T-DEV adjacent).
- [ ] **T-FEAT-7 (P3) Payment layer.** Wire the anonymous-payment design (`docs/PAYMENTS.md`:
  Cashu or an on-chain Privacy-Pools-funded stake) as an optional admission path, so egress can be
  paid-for without rebuilding the identity graph. *Accept:* a paid credential admits a member with
  no link to the funding source; scoped as its own sub-plan.

## Changelog

Append one line per completed task: `- YYYY-MM-DD  T-XXX-n  <what shipped>  (<commit>)`.

- 2026-08-13  (baseline) bootnode discovery, GatewayRegistry, CLI, Docker, docs, repo-wide
  tests (10 suites green), CI, and this plan. See PR #5.
- 2026-08-13  T-TEST-2  fuzz/property suite over every untrusted-input parser (test/fuzz.selftest.mjs);
  11 suites green. (a9c3d2c..)
- 2026-08-13  loop-1  T-TEST-3 (partial: root-provider reconstructRoot, 12 assertions w/ newGroup
  oracle); added feature backlog (T-FEAT-1..7); audit of recent work in progress. 12 suites green.
- 2026-08-13  loop-2  audit of loop-1 work (no HIGH defects; core model holds). Fixed all MED
  findings: T-DEV-6 (announce throttle + registry cap + weight clamp), T-HARD-4 (client response
  cap + server body-cap test), nonce/crypto import + ttlSec nits. Closed test-oracle gaps: weight
  proportionality, fail-closed stake reads (RPC error throws / empty 0x => false), body caps. 12
  suites green.
- 2026-08-13  loop-3  T-TEST-3 (semaphore/rln epoch + requestSignal primitives, 17 assertions);
  focused self-review of loop-2 hardening (sound; logged one global-rate-limit refinement under
  T-HARD-4); added T-FEAT-9 (threshold-signed directory). 13 suites green.
- 2026-08-13  loop-4  T-TEST-11 (golden cross-impl vectors: testdata/vectors.json +
  test/vectors.selftest.mjs, 11 assertions; seeds T-RUST-1); audit self-review of loop-3 test (sound);
  added T-FEAT-10 (gateway capability advertisement). 14 suites green.
