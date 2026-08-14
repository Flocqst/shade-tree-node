# Ship plan: from working reference to robustly shipped

This is the execution roadmap to take reputation-gated onion egress from a working,
tested reference implementation to something robustly deployed, monitored, documented,
and safe for others to run. It is the source of truth for the autonomous build loop.

For the *protocol design* milestones (what each feature is and why) see
[`ROADMAP.md`](ROADMAP.md). This doc is the *shipping* backlog: concrete, checkable
tasks across every workstream, prioritized, with acceptance criteria.

---

## Loop protocol (how an iteration works)

**Mode: AGGRESSIVE FAN-OUT** (set 2026-08-13). Each iteration parallelizes across independent tasks
instead of doing one at a time. Interval: 20 min (matched to batch duration so fires don't collide).

Each loop iteration:

1. Read this file. Select **~6 independent, unchecked tasks** whose dependencies are met, prioritized
   P0 > P1 > P2. Prefer tasks that create NEW files (test suites, docs) or touch disjoint files, so
   parallel agents never conflict. Reserve the big coherent chunks (Rust client, real-Tor integration,
   the on-chain P0s T-DEV-1/2) for FOCUSED single runs, not the fan-out batch.
2. **Fan out one subagent per task**, each with a tight spec: implement the slice, match house style,
   run its own tests to green, do not touch other files, report the files it created.
3. When the batch returns, **integrate**: run the FULL suite (`node scripts/test-all.mjs`) green, fix
   any interaction, then check the boxes, add Changelog lines, and commit + push (one commit per task
   or one batched commit). Never commit red.
4. Also each iteration: **audit** the previous batch's work (self-review or a review agent on the
   riskiest change) and **add ≥1 new feature** to the backlog.
5. The next iteration picks the next ~6. Pipeline where useful: launch batch N while committing N-1.

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
- [x] **T-DEV-3 (P0) Message-to-target binding.** DONE (loop-5). The client now sends the request
  `nonce` in the envelope; the gateway recomputes `calculateSignalHash(requestSignal(target, nonce))`
  and binds it to the proof's committed `x` (`verifyEnvelope` check 2b), failing closed if the nonce
  is absent. A captured proof re-submitted with a swapped target (or nonce) is rejected
  `target-not-bound`. Closes the redirect where a malicious gateway replays a member's proof to a
  peer with a different destination. Tested in `lib/rln.selftest.mjs` (swapped target, swapped nonce,
  missing nonce); wire change threaded through `client/rgoe-client.mjs`, the gateway, and
  `scripts/demo-e2e.mjs`. HARDENED (loop-6 self-audit): the signal is newline-delimited, so
  `verifyEnvelope` now rejects a `target`/`nonce` carrying the delimiter or an over-long nonce
  (`bad-signal-field`) BEFORE hashing, keeping `(target,nonce)->signal` injective independent of the
  gateway's later `validTarget` filter (`signalFieldSafe`). Residual (own item, T-FEAT-12):
  same-target exact-envelope replay across non-colluding gateways.
- [x] **T-DEV-4 (P1) Bootnode persistence.** DONE. `makeRegistry` takes an optional
  `RGOE_BOOTNODE_STORE` JSON path: every accepted announce is written through atomically (tmp +
  rename), and `loadPersisted()` on boot re-runs each stored record through the real announce path
  (onion control + operator/stake re-verified, tampered/forged entries dropped). Freshness on
  reload is the stored **TTL** (`expiresAt`), not the announce anti-replay ts-skew — so a restart
  minutes after the last heartbeat keeps the fleet (the initial reuse-announce() implementation
  wrongly dropped everything past the 120s skew; fixed). Deploy wires the store into the
  `rgoe-bootnode` systemd unit. *Accept (met, injected clock in `bootnode/selftest.mjs`):* announce,
  "restart" 300s later, `/directory` still lists live entries; entries past TTL drop; tampered /
  corrupt / unstaked-on-reload all handled.
- [x] **T-DEV-5 (P1) Client zero-trust operator re-verification.** DONE (loop-9): `client/selection.mjs` `reverifyGateway`/`filterReverified` (env `RGOE_VERIFY_STAKE=1`, off by default). For any entry claiming stake it fetches `GET /gateway/<onion>`, re-runs onion+operator sigs (verifyAnnounce) + live `isStaked`, and DROPS a gateway whose label the bootnode faked or whose stake lapsed. `client/verify-stake.selftest.mjs`. Closes the stale-label gap the incident playbook + adversarial suite flagged.
- [x] **T-DEV-6 (P1) Announce rate-limiting + per-onion caps.** DONE (loop-2, from the audit):
  per-onion re-announce throttle (`RGOE_BOOTNODE_MIN_REANNOUNCE`, cheap pre-verify reject),
  registry size cap (`RGOE_BOOTNODE_MAX_ENTRIES`; a new onion is refused when full, existing ones
  still refresh), and self-attested `weight` clamped to `MAX_WEIGHT=1000` so one gateway cannot
  capture ~all client traffic. Tested in `bootnode/selftest.mjs` (registry hardening).
- [x] **T-DEV-7 (P1) Config validation.** DONE (module, loop-13): `lib/config.mjs` -- pure per-role (bootnode/gateway/client/member-enroll) required/optional validators grounded in what code actually reads (honestly narrowed the ambiguous rules); `validateConfig(role,env)->{ok,errors}`. `lib/config.selftest.mjs`. WIRING into entrypoints deferred to T-DEV-7b.
- [x] **T-DEV-8 (P1) Graceful shutdown / connection draining.** DONE (loop-10): exported `makeGracefulShutdown` on gateway + bootnode; SIGTERM/SIGINT -> server.close() + drain (RGOE_SHUTDOWN_TIMEOUT_MS, default 10s) then force-exit. Signal handlers installed only under the main guard (import is side-effect-free). `test/shutdown.selftest.mjs`.
- [ ] **T-DEV-9 (P2) On-chain incremental tree + root accessor.** So `LightClientRootProvider`
  works (it currently throws). Put the root in a storage slot provable via `eth_getProof`. *Accept:*
  the light provider returns a root validated against a header; test.
- [x] **T-DEV-10 (P2) Configurable egress policy.** DONE (loop-12): exported `makeEgressPolicy({allow,deny})` (default-deny; deny wins; `*`/`*.suffix`/exact host + `*`/exact port). `RGOE_EGRESS_ALLOW`/`RGOE_EGRESS_DENY`, default `*:443` = exactly the old behavior (byte-equivalence table proves it). A policy reject DROPs `bad-target-policy` + increments the metric. Startup warns when widened past :443 (no longer metadata-only). `gateway/egress-policy.selftest.mjs`.
- [x] **T-DEV-11 (P2) Directory scale.** DONE (loop-12): GET /directory gains a strong sha256 ETag + If-None-Match (304 on unchanged) + gzip (Accept-Encoding), all transport-only (signature/content unchanged). Removed the dead verifyDirectory import. Pagination deferred (registry maxEntries caps count). `bootnode/directory-scale.selftest.mjs`.
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
  (12 assertions), `lib/semaphore.mjs`/`lib/rln.mjs` epoch+signal primitives (17), `group/enroll.mjs`
  (`group/enroll.selftest.mjs`, 17 — the security property: only the commitment reaches stdout, the
  secret goes to stderr, and the published leaf == rateCommitment of the withheld secret),
  `group/sign-directory.mjs` (`group/sign-directory.selftest.mjs` — sign/verify + tamper + wrong-signer,
  library-level to avoid repo pollution). REMAINING: only `bootnode/heartbeat.mjs` (operator resolution).
- [x] **T-TEST-4 (P0) Consolidated adversarial/security suite.** DONE (loop-8, `test/adversarial.selftest.mjs`, 27 checks): poisoned directory, MITM bootnode, forged-announce matrix, stake lapse, registry DoS -- one auditor-facing place, each attack run against real code + proven defeated. Stake-lapse client re-check pending T-DEV-5 (flagged in-suite).
- [x] **T-TEST-5 (P1) Foundry fuzz + invariants + gas.** DONE (loop-8): 11 fuzz + 4 invariant tests (no forge-std added; `test/FuzzHelpers.sol` + `*.fuzz.t.sol` + `*.invariant.t.sol`). forge 38->53 tests; invariants (`activeCount`==live stakes, balance==sum of bonds) run 4096 calls each, 0 reverts. Gas baselines recorded (no stray .gas-snapshot committed). Deeper runs: raise runs/depth from 64/64.
- [x] **T-TEST-6 (P1) Node coverage gate.** DONE (loop-9): `c8` devDep + `npm run coverage` with a measured floor (lines 60 / functions 63 / branches 78, set below current so it's a real regression gate) + `.c8rc.json` scoping to shipped code. Not in default `npm test`; CI wiring is T-TEST-9.
- [ ] **T-TEST-7 (P1) Load/soak tests.** Bootnode announce storm (K onions × M heartbeats),
  gateway request throughput, concurrent directory fetch; assert bounded memory (no leak over a
  soak) and stable latency. *Accept:* a `test/load/` harness + a recorded baseline.
- [ ] **T-TEST-8 (P1) Deploy bootstrap e2e in a container.** Run `bootnode/deploy/bootstrap.sh`
  inside an Ubuntu container in CI (or a documented local job); assert services start and onions
  publish. *Accept:* the bootstrap is tested, not just hand-run once.
- [x] **T-TEST-9 (P1) CI matrix + lint + audit.** DONE (loop-11): ci.yml -> Node 20/22/24 matrix (full suite + forge) + lint job + audit job; `eslint.config.js` (pragmatic bug-net, passes clean); `npm run lint` / `npm run audit:ci`. Subsumes T-HARD-2 (dependabot for npm/cargo/actions; audit gate at critical-blocking + high-informational, with the unavoidable-transitive-advisory rationale documented).
- [ ] **T-TEST-10 (P2) Mutation testing.** Stryker over the verify/slash/directory paths to prove
  the tests actually catch regressions. *Accept:* mutation score reported; obvious survivors killed.
- [x] **T-TEST-11 (P0) Golden crypto fixtures (shared with Rust).** DONE (loop-4):
  `testdata/vectors.json` (fixed test seeds) + `test/vectors.selftest.mjs` re-derive and byte-pin
  the deterministic surfaces: key→onion derivation, `canonicalDirectoryBytes`, the ed25519 directory
  signature, `canonicalAnnounceBytes`, the announce onion signature, and the operator-auth message.
  This is both a regression guard for the JS wire formats and the anti-drift contract T-RUST-1 will
  check the Rust client against. *Note:* RLN Groth16 proofs are non-deterministic, so they are
  verified for equivalence (`lib/rln.selftest.mjs`), not byte-pinned here.
- [x] **T-TEST-12 (P0) RLN slash-math property test.** DONE (loop-7, `test/rln-slash.property.selftest.mjs`, 165 assertions/15 rounds with real proofs).
- [x] **T-TEST-13 (P1) Concurrency / race tests.** DONE (loop-7, `test/concurrency.selftest.mjs`: 48-way concurrent admit => exactly-once slash; 400-way across 200 nullifiers => no cross-trigger; 60 concurrent announces => no lost/dup entries).
- [ ] **T-TEST-14 (P1) Chaos / failure-injection e2e.** In the real-Tor integration harness: kill a
  gateway mid-request (client fails over, no dropped connection to the caller), drop the bootnode
  (client uses last-known-good), lapse an operator's stake mid-session (entry demoted). *Accept:*
  each fault has a passing scenario.
- [ ] **T-TEST-15 (P1) Fuzz regression corpus.** Persist any crashing/hanging input a fuzzer finds
  into `testdata/corpus/` and replay it as a fast regression on every run. *Accept:* corpus wired
  into the suite; a seeded known-bad input is caught.
- [x] **T-TEST-16 (P2) Timing/side-channel sanity.** DONE (loop-7, `test/timing.selftest.mjs`: per-member verify medians within ~1.1-1.3x, gated at 2x; Groth16 verify is witness-oblivious).
- [x] **T-TEST-17 (P1) Fast/slow test split.** DONE (loop-10): `RGOE_FAST=1`/`--fast` in scripts/test-all.mjs skips the 3 real-proof suites + forge and prints exactly what it skipped; `npm run test:fast` ~7s vs ~86s full. Also fixed a pre-existing wall-clock flake in `lib/rln.selftest.mjs` (pin verifyEnvelope nowMs to the proof's epoch).
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
- [x] **T-DEPLOY-4 (P1) Systemd hardening.** DONE (loop-11): the generated units get NoNewPrivileges, ProtectSystem=strict (ReadWritePaths=deploy-state), ProtectHome, PrivateTmp, ProtectKernel*, RestrictAddressFamilies (AF_INET/INET6/UNIX for Tor SOCKS), RestrictNamespaces, LockPersonality, SystemCallFilter=@system-service, empty CapabilityBoundingSet, MemoryMax=512M/TasksMax=256. MemoryDenyWriteExecute omitted (breaks V8 JIT). ~9.6->~2.x systemd-analyze score.
- [ ] **T-DEPLOY-5 (P1) Onion key backup/restore.** Documented, encrypted, off-box backup of HS
  keys + a tested restore. *Accept:* restore a gateway's onion on a new box from backup.
- [ ] **T-DEPLOY-6 (P2) Zero-downtime rolling update** across the fleet (drain → update → rejoin).
- [ ] **T-DEPLOY-7 (P2) Persistent on-chain deployment** of `GatewayRegistry` + `StakedReputationSet`
  wired to the live fleet (reuse Sepolia or a chosen L2).

## 4. Website & status

- [x] **T-WEB-1 (P1) Live fleet status page.** DONE (loop-10): `web/status-server.mjs` + `web/status.html` -- fetch bootnode /health + /directory (over Tor or dev http), verify the signature against the pinned signer, render fleet size/health/staked. Privacy-scrubbed: onions truncated to 16 chars, operator address dropped to a staked bool. `web/status.selftest.mjs` (18 checks, incl. no-leak assertions).
- [ ] **T-WEB-2 (P2) Landing refresh.** Extend the existing write-up site with "run a gateway" and
  "join the set" sections and the CLI quickstart.
- [ ] **T-WEB-3 (P2) Docs site.** Render `docs/` as a browsable site.
- [ ] **T-WEB-4 (P3) Fleet map** (regions/ASNs, privacy-preserving).

## 5. Documentation

- [x] **T-DOC-1 (P1) Operator runbook.** DONE (loop-8, `docs/OPERATOR.md`): deploy, join, day-2, key mgmt, slash response, rotate/retire, config -- all commands verified against bin/rgoe.mjs + deploy scripts; honestly marks key-backup + gateway-exit as manual `cast` (not-yet-tooled).
- [x] **T-DOC-2 (P1) Incident response playbook.** DONE (loop-8, `docs/INCIDENT.md`): 7 scenarios grounded in AUDIT.md; surfaced the client-side weight-clamp gap (now fixed) + cross-refs T-HARD-5/T-DEV-4/T-DEV-5/T-FEAT-12 for not-yet-tooled paths.
- [x] **T-DOC-3 (P1) Wire-protocol + API spec.** DONE (loop-7): `docs/PROTOCOL-API.md` -- canonical byte encodings, onion<->key binding, announce + directory + envelope wire formats, bootnode HTTP API, every rejection reason, and a conformance map to testdata/vectors.json. Every claim cited to file:symbol. Unblocks the Rust conformance runner (T-RUST-1).
- [x] **T-DOC-4 (P2) SECURITY.md** DONE (loop-9): `SECURITY.md` (unaudited/testnet status, in-scope vs known residuals, GitHub private-advisory reporting) + `CONTRIBUTING.md` (test commands, house conventions, the trust-model invariants a contributor must not break, gate ordering).
- [x] **T-DOC-5 (P2) README polish pass.** DONE (loop-10): skimmable what/why/how lede, pruned the stale "deployed and verified live" overclaim to match pre-ship reality, reworked Run-it around the `rgoe` CLI, and a full Docs index linking every doc that now exists.
- [ ] **T-HARD-1 (P0) Real trusted setup / artifact provenance.** Replace the untrusted testnet ZK
  artifacts; document the ceremony or pin audited artifacts; CI verifies hashes. *(Flag the ceremony
  itself for the human.)*
- [x] **T-HARD-2 (P1) Supply chain.** DONE (loop-11, with T-TEST-9): `.github/dependabot.yml` (npm/cargo/actions weekly) + `npm audit` gate (critical blocking, high informational). Lockfile committed. Remaining polish: pin transitive advisories as Dependabot lands upstream fixes.
- [x] **T-HARD-3 (P1) Log hygiene.** DONE (loop-8, `test/log-hygiene.selftest.mjs`, 25 assertions, mutation-verified): static scan of every log call across 9 files + dynamic capture (bootnode, gateway spent-set, enroll) => no secret/seed logged. Fixed the one note it found: the dry-run slasher no longer prints any bytes of the reconstructed secret (`gateway/gateway.mjs`).
- [~] **T-HARD-4 (P1) Endpoint hardening.** DONE (loop-2): the client's response read from the
  semi-trusted bootnode is now capped (`RGOE_BOOTNODE_MAX_RESP`, was unbounded => OOM lever), and
  the server's oversized-body rejection is tested. REMAINING: slow-loris/idle-timeout on the
  gateway tunnel, per-connection limits, request timeouts on the bootnode server, and a GLOBAL
  announce token-bucket (loop-3 self-review: the per-onion throttle does not slow an attacker
  minting fresh onions until the size cap fills, so up to `maxEntries` ed25519 verifies are
  reachable in a burst; a global rate cap throttles that pre-full).
- [x] **T-HARD-5 (P2) Directory signer rotation.** DONE (loop-13): `verifyDirectory` accepts a pinned-signer ALLOWLIST (single string still works byte-for-byte); `RGOE_DIR_SIGNER` takes a comma-separated overlap set. Rotation: add new to client set -> rotate bootnode key -> drop old. Still an allowlist (unpinned/wrong signer rejected). `lib/directory-rotation.selftest.mjs`.
- [x] **T-HARD-6 (P2) Contract audit prep.** DONE (loop-9): `docs/CONTRACTS-AUDIT.md` (inventory, 8 written invariants each tied to a test, per-function reentrancy/CEI/access walk, honest limitations) + `slither.config.json`. slither not installed here; config left for later.
- [x] **T-HARD-7 (P2) Tor hardening.** DONE (loop-11): `docs/TOR-HARDENING.md` (PoW tuning, vanguards, v3 client-auth -- corrected from the deprecated v2 mechanism, process/OS, SOCKS circuit isolation) + `bootnode/deploy/torrc.hardened` reference fragment (server/client tagged, version-dependent options flagged).
- [x] **T-RUST-0 (P1) Rust workspace + language ADR.** DONE (loop-8): `rust/` cargo workspace (`rgoe-proto` lib + `rgoe-client` bin) builds; `cargo test` passes 3 (request_signal, operator_auth_message, signal_field_safe -- already matching testdata/vectors.json). Stubs cite JS file:symbol + PROTOCOL-API.md. ADR `docs/adr/0001-client-language.md`. Gate 2 started.
- [x] **T-RUST-1 (P1) Wire-format conformance harness.** DONE (loop-9): `rust/rgoe-proto` implements onion<->key, canonical directory/announce bytes, ed25519 verify, and `verify_directory` (full ordered reasons); `rust/rgoe-proto/tests/conformance.rs` (13 tests) asserts byte-match vs `testdata/vectors.json` -- Rust proven to match the JS reference. Deferred for lack of a pinned vector: `calculate_signal_hash` + operator-ECDSA `verify_announce` (see T-RUST-1b).
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

- [x] **T-MON-1 (P1) Structured logging.** DONE (loop-13): `lib/log.mjs` (zero-dep leveled logger, `RGOE_LOG_FORMAT=text|json` default text so output shape is unchanged, `RGOE_LOG_LEVEL`, guarded JSON.stringify). Routed gateway + bootnode log points 1:1 through it (PASS->info, DROP->warn, etc.), preserving the exact substrings the sepolia integration greps. `lib/log.selftest.mjs`.
- [x] **T-MON-2 (P1) Prometheus metrics.** DONE (loop-11): `lib/metrics.mjs` (zero-dep counters/gauges/histogram + Prometheus text render). Bootnode exposes `GET /metrics` (announces by result/reason, directory fetches, live gateways gauge); gateway (raw TCP) exposes metrics via a separate loopback http server on `RGOE_METRICS_PORT` (off by default) -- pass/drop by reason, slashes, active tunnels, verify-latency histogram. `lib/metrics.selftest.mjs`.
- [x] **T-MON-3 (P2) Dashboards + alerts.** DONE (loop-12): `monitoring/grafana-dashboard.json` (panels on the real T-MON-2 metric names, verify-latency histogram_quantile) + `monitoring/alerts.yml` (9 rules cross-ref SLO.md/INCIDENT.md) + `monitoring/README.md` (loopback scrape via tunnel). Burn-rate alerts deferred (need production volume).
- [x] **T-MON-4 (P2) External uptime checks.** DONE (loop-12): `scripts/uptime-probe.mjs` -- fetch bootnode /health + /directory over Tor, verify the signature against the pinned signer, emit JSON or `--format nagios` (exit 0/2), fail closed, privacy-scrubbed (count only). `scripts/uptime-probe.selftest.mjs` + `monitoring/UPTIME.md`.
- [x] **T-MON-5 (P2) SLOs + error budget.** DONE (loop-11): `docs/SLO.md` -- 6 SLIs mapped to the T-MON-2 metrics, proposed SLOs with windows/rationale, error-budget math tied to INCIDENT.md, explicit non-SLOs (anonymity is correctness not availability). Three targets flagged [NEEDS DATA] until a real fleet/cohort exists.
- [ ] **T-FEAT-1 (P1) Bootnode federation / gossip.** More than one bootnode, gossiping announces
  so discovery is not a single availability point. A client can pin multiple bootnode signers and
  union their (independently-verified) directories. *Accept:* two bootnodes converge on the same
  live set; a client survives one going dark. *Why now-ish:* the bootnode is the one new
  single-point-of-availability the fleet added; this closes it.
- [x] **T-FEAT-2 (P1) `rgoe join` guided onboarding.** DONE (loop-10): `group/join.mjs` -- `rgoe join [member]` composes self-enrollment (secret to stderr, commitment + next commands to stdout) and `rgoe join gateway` mints an onion + prints the gateway/heartbeat commands. `group/join.selftest.mjs`.
- [x] **T-FEAT-3 (P2) Client SDK packaging.** DONE (loop-13): package.json `exports` (`./client`) + conservative `files` allowlist (stays `private:true` until the gates) + `docs/SDK.md` (constructor opts, fetch/connect, env, example). bin/entrypoints unaffected (internal relative imports not gated by exports).
- [ ] **T-FEAT-4 (P2) Quality-aware rotation.** Clients report anonymized latency/success back; the
  bootnode aggregates it into the advertised `weight`/`health` (never per-member), so rotation
  favors good gateways beyond static weight. Must not become a linkability channel. *Accept:*
  a slow gateway loses weight fleet-wide; a privacy note proving no member is fingerprinted.
- [x] **T-FEAT-5 (P2) Deterministic member subkeys.** DONE (loop-11): `lib/subkeys.mjs` -- HMAC-SHA512(master, `rgoe-subkey:v1\n{context}\n{index}`) mod FIELD -> a valid RLN secret; `deriveIdentity` composes it to a registerable rateCommitment. Determinism, unlinkability across 80 context/index pairs, field-range, RLN composition, master isolation, + a pinned golden vector. `lib/subkeys.selftest.mjs`.
- [ ] **T-FEAT-6 (P2) Directory delta protocol.** `GET /directory?since=<etag>` returns only
  changed entries, so large fleets are cheap to keep fresh. *Accept:* a delta fetch after no change
  returns empty; after one announce returns one entry; client applies deltas + re-verifies.
- [x] **T-FEAT-17 (P2) Per-request SOCKS circuit isolation.** DONE (loop-12): `socksAuthForRequest(seed)` -> the client sends a unique SOCKS userId/password per REQUEST (seeded from the request nonce, so retries/failover of one request reuse its circuit while different requests get distinct circuits), so Tor `IsolateSOCKSAuth` gives each request its own circuit. Harmless against a no-auth SOCKS (verified vs node_modules/socks). Default-on (`RGOE_SOCKS_ISOLATION=0` to disable). `client/socks-isolation.selftest.mjs`.
- [ ] **T-FEAT-16 (P2, added loop-10) Gateway egress self-check before announce.** A gateway with broken clearnet egress (bad routing, firewall) would still announce and then DROP every member it gets routed. Have the gateway verify it can actually reach a :443 target on startup (and periodically) before it heartbeats to the bootnode, and stop announcing if egress fails, so a broken gateway removes itself from the fleet. *Accept:* a gateway with a blocked egress does not appear in /directory; a healthy one does; the check is metadata-only (no member traffic).
- [ ] **T-FEAT-15 (P2, added loop-9) Automated encrypted key backup/restore.** The operator runbook
  marks onion-identity + operator-key backup as manual `tar | gpg`. Add `rgoe backup` / `rgoe restore`
  that GPG-encrypts the onion identity seed(s) + (optionally) the operator key to an off-box target
  and restores them on a fresh box, so key loss is recoverable and the procedure is not ad hoc.
  *Accept:* backup then restore on a clean box reproduces the same onion; secrets never written
  unencrypted; documented in OPERATOR.md.
- [x] **T-RUST-1b (P1) Signal-hash + operator-sig conformance vectors.** DONE (loop-10): added `signalHash` + a pinned-key `operatorAnnounce` to testdata/vectors.json (asserted JS-side); Rust `calculate_signal_hash` (keccak256 big-endian >>8) implemented + conformance-tested byte-exact. Operator-ECDSA verify_announce still stubbed (secp256k1/EIP-191 dep) but the vector now exists.
- [x] **T-FEAT-14 (P2) SearXNG / agent egress adapter.** DONE (loop-12): `docs/ADAPTERS.md` (proxy-style SearXNG `outgoing.proxies` snippet verified vs official docs + library-style RgoeClient; HTTPS-only constraint documented) + `examples/agent-egress.mjs`. Closes back to the origin use case.
- [ ] **T-FEAT-13 (P2, added loop-7) Signed egress success receipts.** A gateway that accepts a
  proof could still silently drop the actual egress. Have the gateway return a small signed receipt
  (its onion pubkey signs `{nullifier-prefix, ts, ok}` — NO target, to avoid a logging channel) so a
  client can confirm the egress happened and accumulate evidence against a gateway that gates-then-
  drops, feeding the quality-aware rotation (T-FEAT-4). *Accept:* a successful egress returns a
  verifiable receipt; a gateway that drops traffic produces none; receipts carry no per-request
  target/member-identifying data.
- [ ] **T-FEAT-12 (P2, added loop-6) Cross-gateway replay defense (per-epoch nonce cache).** Target
  binding (T-DEV-3) stops a captured proof being REDIRECTED, but an exact-envelope replay to the SAME
  target still egresses, and across non-colluding gateways there is no shared spent-set, so a
  malicious gateway could replay a member's envelope to peers and amplify the member's apparent
  traffic on one proof. Add a per-epoch seen-nonce cache on the gateway (reject an exact replay), and
  design an optional shared/gossiped spent-nullifier tally across the fleet (composes with T-FEAT-1
  federation) so the rate cap holds fleet-wide. *Accept:* an exact replay to one gateway is rejected;
  a design note for the cross-gateway tally with its linkability tradeoff (must pair with RLN's
  per-request nullifiers, ROADMAP #1).
- [ ] **T-FEAT-11 (P2, added loop-5) Envelope/protocol version negotiation.** The wire envelope is
  now v3-with-nonce (loop-5). Add explicit min/max version negotiation between client and gateway (and
  in the announce/directory) so the envelope and announce formats can evolve to v4+ without a flag
  day: a gateway advertises supported versions, the client picks the highest mutually supported, and
  an unknown version is rejected with a clear reason rather than a silent mis-parse. *Accept:* a
  client and gateway on overlapping ranges interoperate; on disjoint ranges they fail with a precise
  version error; a downgrade cannot strip the target binding.
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

- [x] **T-CHORE-1 (P3) Remove dead imports.** DONE (loop-12): removed the 6 eslint-flagged unused imports; `npm run lint` now 0 warnings.

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
- 2026-08-13  loop-5  audit found + fixed a P0: T-DEV-3 message-to-target binding (gateway recomputes
  the signal hash from target+nonce and binds it to the proof's x; a swapped-target replay is now
  rejected). Wire change threaded through client/gateway/demo-e2e; 3 new rln.selftest cases. Added
  T-FEAT-11 (envelope version negotiation). 14 suites green.
- 2026-08-13  loop-6  audited the loop-5 P0 fix; hardened it (signalFieldSafe: reject delimiter in
  target/nonce + over-long nonce before hashing, keeping the signal encoding injective); 3 new
  rln.selftest cases. Added T-FEAT-12 (cross-gateway replay defense). 14 suites green.
- 2026-08-13  loop-6b independent adversarial review of the target binding CONFIRMED it holds (no
  breaks); it recommended the newline-injection test (already added loop-6) and documenting the
  2b<-check4 authority invariant (now a code comment in verifyEnvelope). Replay-to-original-target
  scoping matches T-FEAT-12.
- 2026-08-13  loop-7 (AGGRESSIVE FAN-OUT, 6 parallel agents) closed 5 test tasks in one tick:
  T-TEST-12 (slash-math property, 165 assertions), T-TEST-13 (concurrency/race), T-TEST-16 (timing
  sanity), and T-TEST-3 enroll + sign-directory. 19 suites green. T-DOC-3 (wire spec) landing next.
  Added T-FEAT-13 (egress success receipts).
- 2026-08-13  loop-8 (AGGRESSIVE FAN-OUT, 6 parallel agents) closed 6 tasks: T-TEST-4 (adversarial
  scenarios), T-TEST-5 (Foundry fuzz+invariants, forge 38->53), T-HARD-3 (log hygiene + secret-free
  slash log fix), T-DOC-1 (operator runbook), T-DOC-2 (incident playbook), T-RUST-0 (Rust workspace +
  ADR -- Gate 2 started, cargo test green). Audit fix: client-side weight clamp in pickGateway (a
  static/poisoned directory can no longer skew selection past MAX_WEIGHT). 21 suites green. Added
  T-TEST-17 (fast/slow split) + T-FEAT-14 (SearXNG/agent adapter).
- 2026-08-13  loop-9 (AGGRESSIVE FAN-OUT, 6 parallel agents) closed 6 tasks: T-RUST-1 (Rust
  conformance harness -- 13 tests byte-match testdata/vectors.json; Gate 2 proven), T-DEV-4 (bootnode
  persistence; a review agent caught + fixed a TTL-vs-skew reload bug that would blank the fleet on
  restart), T-DEV-5 (client zero-trust stake re-verify -- closes the stale-label gap), T-DOC-4
  (SECURITY + CONTRIBUTING), T-HARD-6 (contract audit guide + slither cfg), T-TEST-6 (c8 coverage
  gate). 23 suites green (node+forge) + rust cargo test 16. Added T-FEAT-15 (key backup) + T-RUST-1b
  (signal-hash/operator-sig vectors). NOTE: real-proof suites make npm test >2min -> T-TEST-17 is now
  P1-urgent; one transient rln.selftest flake observed under load (passes standalone/clean).
- 2026-08-13  loop-10 (AGGRESSIVE FAN-OUT, 6 parallel agents; cadence 10->20min) closed 6 tasks:
  T-TEST-17 (fast lane 7s vs 86s + fixed the rln wall-clock flake), T-DEV-8 (graceful shutdown), T-DOC-5
  (README polish -- pruned the deployed-live overclaim), T-WEB-1 (privacy-scrubbed fleet status page --
  first website deliverable), T-FEAT-2 (rgoe join onboarding), T-RUST-1b (signal-hash vector + Rust
  calculate_signal_hash byte-exact). 26 node+forge suites green + rust 17 conformance. Added T-FEAT-16
  (gateway egress self-check).
- 2026-08-13  loop-11 (AGGRESSIVE FAN-OUT, 6 agents + 1 review) closed 7 tasks: T-MON-2 (Prometheus
  metrics, bootnode /metrics + gateway metrics listener), T-TEST-9+T-HARD-2 (CI matrix + eslint + audit
  + dependabot), T-DEPLOY-4 (systemd hardening ~9.6->~2.x), T-HARD-7 (Tor hardening doc + torrc),
  T-FEAT-5 (member subkeys + golden vector), T-MON-5 (SLOs). AUDIT of the loop-10 status server: privacy
  scrub + signature gating HOLD; found + fixed a real total-ness bug in lib/directory.mjs verifyDirectory
  (threw on a non-string signer) + regression test + fuzz now injects it. 28 node+forge suites green.
  Added T-FEAT-17 (per-request SOCKS circuit isolation) + T-CHORE-1 (dead-import cleanup).
- 2026-08-13  loop-12 (AGGRESSIVE FAN-OUT, 6 agents) closed 7 tasks: T-DEV-11 (directory ETag/304/gzip),
  T-DEV-10 (configurable egress policy, default byte-equivalent to :443-only), T-FEAT-17 (per-request SOCKS
  circuit isolation), T-MON-3 (Grafana dashboard + 9 alert rules), T-MON-4 (external Tor uptime prober),
  T-FEAT-14 (SearXNG/agent adapter), T-CHORE-1 (dead imports -> lint 0 warnings). 32 node+forge suites green;
  eslint clean. Added T-FEAT-18 (status-page history/sparkline).
- 2026-08-13  loop-13 (AGGRESSIVE FAN-OUT, 6 agents + 1 review) closed 6 tasks: T-MON-1 (structured
  logging), T-HARD-5 (signer-rotation allowlist), T-FEAT-18 (status history/sparkline), T-FEAT-3 (client SDK
  packaging), T-DEV-7 (config-validation module), T-DOC-6 (ADRs 0002-0005). AUDIT of the loop-12 egress
  policy: guarantees hold, but found + fixed a HIGH trailing-dot FQDN bypass (`sub.evil.com.` evaded a
  `*.evil.com` deny) via host canonicalization + a regression test. 36 node+forge suites green; lint clean.
  Added T-DEV-7b (wire config validation) + T-FEAT-19 (client gateway-reputation persistence).
