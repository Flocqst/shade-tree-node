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

- [x] **T-DEV-1 (P0) Real exit-auth verifier.** Replace `MockWithdrawVerifier` with the real
  Groth16 verifier so `StakedReputationSet.initiateExit`/`withdraw` are genuinely ZK-authorized
  (prove knowledge of the identity secret) on chain. *Accept:* a withdrawal with a bogus proof
  reverts `BadProof`; a valid one succeeds; Foundry test with the real verifier.
- [x] **T-DEV-2 (P0) RLN leaf removal parity.** `reconstructRoot` rebuilds a fresh tree of
  survivors (renumbering indices); an on-chain slash that zeroes a leaf in place would diverge
  (`lib/root-provider.mjs` COORDINATION note). Make JS and contract agree on removal semantics.
  *Accept:* register 3, slash the middle, both sides compute the identical root; test. DONE (loop-26): JS aligned
  to the contract's zero-in-place convention; three-way triangulated proof; full suite green.
- [x] **T-DEV-2b (P2, added loop-26) Rust RLN tree removal parity.** `rust/rgoe-rln/src/tree.rs` (T-RUST-2c) is
  insertion-only — no removal path. To stay consistent with the loop-26 JS reconstruction and the contract's
  immutable indices, add a `remove(index)` that zeroes the leaf at its ORIGINAL index (leaf → the tree zero value,
  other indices/paths preserved) and recomputes the root. *Accept:* Rust tree root after register-3/remove-middle
  == the JS `reconstructRoot` root == the contract root (extend the tree-parity harness with a removal case).
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
- [x] **T-DEV-12 (P2) Bootnode active health probing.** Optionally dial each announced onion and
  reflect reachability in `health`, so a silently-dead gateway is demoted before a client hits it.

## 2. Testing  *(go hard here — this is Gate 1)*

**Testing philosophy for this project.** It is a privacy/crypto system, so a test is only
worth something if it can *fail* on a real defect. Bias toward: adversarial inputs over happy
paths; golden/differential fixtures over hand-rolled expected values (so JS and the coming Rust
client are checked against the *same* vectors); property + fuzz over example-based where a
surface takes untrusted bytes; and killing a mutant (does the test catch a flipped comparison?)
over line coverage. Every parser, every signature check, and every state machine (spent-set,
slash, stake lifecycle) gets negative and concurrent cases, not just a positive one.

- [x] **T-TEST-1 (P0) Real-Tor local fleet integration test.** `test/integration/fleet-e2e.mjs`:
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
- [x] **T-TEST-7 (P1) Load/soak tests.** Bootnode announce storm (K onions × M heartbeats),
  gateway request throughput, concurrent directory fetch; assert bounded memory (no leak over a
  soak) and stable latency. *Accept:* a `test/load/` harness + a recorded baseline.
- [x] **T-TEST-8 (P1) Deploy bootstrap e2e in a container.** Run `bootnode/deploy/bootstrap.sh`
  inside an Ubuntu container in CI (or a documented local job); assert services start and onions
  publish. *Accept:* the bootstrap is tested, not just hand-run once.
- [x] **T-TEST-21 (P1, added+done loop-18) Adversarial hardening of the receipt + version-negotiation surfaces.**
  The two freshest wire surfaces (loop-16/17) had only their authors' tests. `test/protocol-adversarial.selftest.mjs`
  adds 209 assertions driving the REAL `lib/receipt.mjs` + `gateway.mjs`/`rgoe-client.mjs` version code: receipt
  tamper/wrong-key/wrong-gateway, cross-protocol confusion both directions (announce sig ↔ receipt sig never
  interchange), epoch canonicalization, totality (~20 garbage inputs never throw), version out-of-range/non-integer
  rejection with value-safe repr, disjoint-range fail-closed, and proof a downgraded/garbage version can't strip
  the target binding. *Result:* no defect found — the surfaces hold.
- [x] **T-TEST-22 (P2, added+done loop-18) Golden cross-impl vectors for the receipt surface.** Extended
  `testdata/vectors.json` + `test/vectors.selftest.mjs` (additively — no existing vector changed) to byte-pin the
  RECEIPT_DOMAIN, canonical receipt bytes, and the ed25519 receipt signature from a fixed seed, plus the stable
  version-negotiation reason-label literals. Hex derived by running `lib/receipt.mjs`, not hand-written. This is
  the anti-drift contract the coming Rust client (rust/rgoe-proto) will be checked against for receipts.
- [x] **T-DOC-7 (P1, added+done loop-18) Consolidated auditor threat model.** `docs/THREAT-MODEL.md`: assets,
  6 adversary classes, trust assumptions (trusted-for vs NOT), 15 security properties each cited to
  `file:function`, an honest residual-risks/out-of-scope list, and a "where to start" audit checklist. One
  property (per-dial onion-control challenge) marked "claimed, unverified" rather than overstated.
- [x] **T-TEST-9 (P1) CI matrix + lint + audit.** DONE (loop-11): ci.yml -> Node 20/22/24 matrix (full suite + forge) + lint job + audit job; `eslint.config.js` (pragmatic bug-net, passes clean); `npm run lint` / `npm run audit:ci`. Subsumes T-HARD-2 (dependabot for npm/cargo/actions; audit gate at critical-blocking + high-informational, with the unavoidable-transitive-advisory rationale documented).
- [x] **T-TEST-10 (P2) Mutation testing.** Stryker over the verify/slash/directory paths to prove
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
- [x] **T-TEST-14 (P1) Chaos / failure-injection e2e.** In the real-Tor integration harness: kill a
  gateway mid-request (client fails over, no dropped connection to the caller), drop the bootnode
  (client uses last-known-good), lapse an operator's stake mid-session (entry demoted). *Accept:*
  each fault has a passing scenario.
- [x] **T-TEST-15 (P1) Fuzz regression corpus.** DONE (loop-14): `testdata/corpus/regressions.json` (16 curated adversarial inputs drawn from real audit findings) replayed first+fast in `test/fuzz.selftest.mjs`; documented add-procedure. No entry revealed a still-unfixed bug.
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
- [x] **T-DEPLOY-3 (P1) Infra-as-code.** Provision + configure the fleet via OpenTofu + Ansible
  (in `agent-devops`), not hand-ssh. *Accept:* `tofu apply` + a playbook stand up a gateway
  reproducibly.
- [x] **T-DEPLOY-4 (P1) Systemd hardening.** DONE (loop-11): the generated units get NoNewPrivileges, ProtectSystem=strict (ReadWritePaths=deploy-state), ProtectHome, PrivateTmp, ProtectKernel*, RestrictAddressFamilies (AF_INET/INET6/UNIX for Tor SOCKS), RestrictNamespaces, LockPersonality, SystemCallFilter=@system-service, empty CapabilityBoundingSet, MemoryMax=512M/TasksMax=256. MemoryDenyWriteExecute omitted (breaks V8 JIT). ~9.6->~2.x systemd-analyze score.
- [x] **T-DEPLOY-5 (P1) Onion key backup/restore.** Documented, encrypted, off-box backup of HS
  keys + a tested restore. *Accept:* restore a gateway's onion on a new box from backup.
- [x] **T-DEPLOY-6 (P2) Zero-downtime rolling update** across the fleet (drain → update → rejoin).
- [x] **T-DEPLOY-7 (P2) Persistent on-chain deployment** of `GatewayRegistry` + `StakedReputationSet`
  wired to the live fleet (reuse Sepolia or a chosen L2).

## 4. Website & status

- [x] **T-WEB-1 (P1) Live fleet status page.** DONE (loop-10): `web/status-server.mjs` + `web/status.html` -- fetch bootnode /health + /directory (over Tor or dev http), verify the signature against the pinned signer, render fleet size/health/staked. Privacy-scrubbed: onions truncated to 16 chars, operator address dropped to a staked bool. `web/status.selftest.mjs` (18 checks, incl. no-leak assertions).
- [x] **T-WEB-2 (P2) Landing refresh.** DONE (loop-14): `docs/post/RUN-A-GATEWAY.md` + `docs/post/JOIN.md` (landing-companion how-tos, commands verified, honest pre-ship status). Existing post HTML/figures untouched.
- [x] **T-WEB-3 (P2) Docs site.** Render `docs/` as a browsable site.
- [x] **T-WEB-4 (P3) Fleet map** (regions/ASNs, privacy-preserving).

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
- [x] **T-RUST-2 (P1) Rust client MVP — DONE (loop-22/23): egresses over Tor, JS gateway accepts.** Gate-2's
  gating definition is met: the Rust client passes conformance (loop-19) AND egresses byte-for-byte-compatibly
  with the JS reference — a real over-Tor `rgoe egress` was ACCEPTED by the live gateway (loop-23, reproduced by
  me). Full-DISTRIBUTABLE polish remains as its own items: T-RUST-3 (rotation/failover/LKG/bootnode-discovery
  parity), T-RUST-4 (release binaries). PRODUCTION-trust (orthogonal to the client): real exit verifier T-DEV-1,
  trusted setup T-HARD-1, CI real-Tor T-TEST-1. Details of the deterministic core below.
- [~] **T-RUST-2-core (P1) Rust client MVP deterministic core — DONE (loop-19).**
  Done (focused single run): the conformance-backed deterministic client pipeline in Rust. `rgoe-proto`
  gained receipt verify (`canonical_receipt_bytes`/`verify_receipt`/`RECEIPT_DOMAIN`, hand-built bytes),
  version negotiation (`select_proto_version`/`accept_envelope_version` + pinned reason labels), and gateway
  selection (`clamp_weight`/`pick_gateway`/`selection_order`, injectable rng). `rgoe-client` is now a real CLI
  (`verify-directory`, `select`, `verify-receipt`) that parses untrusted JSON (serde in the client only; proto
  canonical path stays serde-free) and runs the trust-critical proto checks. 20 conformance + 9 unit tests green
  (byte-match the new `receipt` + `protoReasons` vectors from T-TEST-22); clippy/fmt clean. INTEGRATION AUDIT:
  JS↔Rust receipt-verify differential 48/48 over valid/wrong-onion/tamper cases, and an end-to-end verify→select
  smoke against a JS-signed directory (accepts pinned signer, rejects wrong = `signer-not-pinned`). *Remaining
  (T-RUST-2b):* the LIVE egress — `arti`-dialed onion connect + `zerokit` RLN Groth16 proving + real proxy —
  stubbed behind `live_egress()` (returns an honest not-implemented error). Gate 2 is not closed until 2b lands.
- [x] **T-RUST-2b (P1, added loop-19) Rust client live egress — RLN-INTEROP SLICE DONE (loop-20).**
  Done (focused single run): the Gate-2 CRUX — a Rust-generated RLN Groth16 envelope proof is ACCEPTED by the
  JS reference `lib/rln.mjs` verifyEnvelope (ok:true), against the repo's OWN `circuits/rln/*` artifacts. New
  crate `rust/rgoe-rln` (excluded from `default-members` so the everyday build stays 0.29s; build with
  `cargo build -p rgoe-rln`; harness `bash rust/rgoe-rln/interop/run.sh`). FORK RESOLVED: `rln = "3"` is zerokit
  3.0, which CANNOT consume this repo's snarkjs `rln_final.zkey` (it only reads its own arkzkey format + bundles
  its own trusted setup), so its proofs verify against zerokit's VK, not ours. Resolved via option (b) `ark-circom`:
  `read_zkey` loads the repo's `rln_final.zkey`, `WitnessCalculator` runs the repo's `rln.wasm` (same circom
  compile → no witness/wire mismatch), `ark-groth16`+`CircomReduction` proves, serialized snarkjs-shaped so rlnjs
  reads it. VERIFIED (mine, reran the harness): target binding via conformance-gated `rgoe-proto`
  calculate_signal_hash; public signals `[y,root,nullifier,x,externalNullifier]` == rlnjs; Rust proof verifies vs
  the repo `verification_key.json`; verifyEnvelope accepts; and a cross-impl over-spend (two Rust shares) recovers
  the exact identitySecret via JS reconstructSecret. *Remaining for T-RUST-2b (own items below):* T-RUST-2c
  (native Rust depth-20 Poseidon merkle tree — the root is currently supplied by a JS fixture), T-RUST-2d (wire
  proving into `rgoe-client` behind a feature), T-RUST-2e (the `arti` Tor dial + real proxy). Gate 2 stays open
  until egress runs end-to-end. Artifacts remain testnet-only (untrusted ceremony — T-HARD-1).
- [x] **T-RUST-2c (P1, added loop-20) Native Rust RLN merkle tree parity.** The interop slice took the membership
  merkle root + path from a JS fixture. Build the depth-20 Poseidon (BN254) incremental tree in Rust matching the
  rlnjs Semaphore-v3 group so the Rust client computes its own root/path from the member set. *Accept:* Rust tree
  root == rlnjs group root over the same member list; a Rust-computed path proves in the envelope and verifyEnvelope
  accepts. Cross-refs T-DEV-2 (leaf-removal parity) and T-RUST-3 (client parity).
- [x] **T-RUST-2d (P1, added loop-20) Wire RLN proving into rgoe-client.** Move the `rgoe-rln` prover behind a
  cargo feature on `rgoe-client` so `rgoe egress` can build a real envelope (still no Tor yet — send over a local
  socket to a JS gateway in an integration test). *Accept:* `rgoe egress` produces an envelope a JS gateway accepts,
  without the standalone harness.
- [x] **T-RUST-2e (P1, added loop-20) arti Tor dial + real proxy.** Add `arti-client` (default-features=false,
  features=["tokio","rustls"] — the compression feature MUST stay off: it links native zstd and collides with
  rln's sled; confirmed) + tokio to dial the selected gateway onion and proxy the CONNECT. *Accept:* the Rust
  client egresses through a LIVE gateway over Tor byte-for-byte-compatibly with the JS client; pairs with T-TEST-1
  real-Tor / T-TEST-8 container e2e. Closes Gate 2. DONE (loop-23): `arti-client` behind the `live` feature
  (default-features=false, features=["tokio","rustls","onion-service-client"]) + tor-rtcompat + tokio, all optional
  so the default build stays ~0.14s (cargo tree: no arti/tokio/ark in the default graph). The predicted zstd
  collision did NOT arise (prover is ark-circom, no sled; arti's async-compression resolves to pure-Rust zlib with
  default-features off). `rgoe egress` is transport-selectable (`--onion`/directory-select over arti by default,
  `--plain-tcp` escape hatch preserving loop-22). REAL OVER-TOR ACCEPT CAPTURED + reproduced by me
  (interop/egress-tor-run.sh, gated RGOE_TOR_E2E=1): Rust bootstraps embedded Tor, dials a published v3 HS for the
  gateway, gateway logs its egress-accept line. The over-Tor step stays gated (HS propagation slow/flaky, pairs
  with T-TEST-1); the plain-TCP Layer-3 accept remains the always-green authoritative check.
- [x] **T-RUST-2f (P3, added loop-23) Harden the over-Tor harness cleanup.** interop/egress-tor-run.sh leaked its
  gateway + tor children when its stdout was piped (SIGPIPE cut the EXIT trap before it killed the backgrounded
  procs). Make cleanup robust to a truncated pipe (trap on more signals / kill a process group / write a pidfile
  and reap unconditionally) so a piped run never leaves a gateway/tor listening. *Accept:* piping the harness to
  `head`/`tail` still leaves zero leftover tor/gateway processes.
- [x] **T-RUST-3 (P2) Rust client parity.** Per-request slot + gateway rotation, failover,
  last-known-good caching, bootnode discovery — full parity with `client/rgoe-client.mjs`. DONE (loop-24):
  rotation+failover, LKG cache (dircache.rs) with rollback/max-age guards, cross-session health (health.rs),
  bootnode discovery (plain-TCP proven, over-Tor gated). Deferred to T-RUST-3b: the persisted K-slot cursor +
  TorClient reuse across failover. *Accept:* the real-Tor integration test (T-TEST-1) passes with the Rust client
  swapped in — pairs with T-TEST-1's CI wiring.
- [x] **T-RUST-3b (P3, added loop-24) Per-request slot cursor + Tor client reuse.** Two honest follow-ups from
  T-RUST-3: (a) the JS client rotates through K slots/epoch (makeSlotPool) so repeated requests use distinct
  nullifiers; the Rust `--slot` flag exists but there's no PERSISTED cross-invocation slot cursor — add one (small
  on-disk cursor like the health cache) so a one-shot CLI advances slots between runs within an epoch; (b) over-Tor
  failover currently re-bootstraps arti per candidate — reuse one bootstrapped `TorClient` across the candidate
  loop (functionally correct today, just wasteful). *Accept:* consecutive `rgoe egress` runs in one epoch use
  distinct slots/nullifiers; a multi-candidate over-Tor failover bootstraps Tor once.
- [x] **T-RUST-4 (P2) Release binaries.** Cross-compiled static binaries (linux x86_64/arm64,
  macOS, windows) in CI releases; `rgoe` install without a runtime. *Accept:* a downloadable binary
  runs on a clean box with no Node/Tor installed.

## 7. Monitoring & observability

- [x] **T-MON-1 (P1) Structured logging.** DONE (loop-13): `lib/log.mjs` (zero-dep leveled logger, `RGOE_LOG_FORMAT=text|json` default text so output shape is unchanged, `RGOE_LOG_LEVEL`, guarded JSON.stringify). Routed gateway + bootnode log points 1:1 through it (PASS->info, DROP->warn, etc.), preserving the exact substrings the sepolia integration greps. `lib/log.selftest.mjs`.
- [x] **T-MON-2 (P1) Prometheus metrics.** DONE (loop-11): `lib/metrics.mjs` (zero-dep counters/gauges/histogram + Prometheus text render). Bootnode exposes `GET /metrics` (announces by result/reason, directory fetches, live gateways gauge); gateway (raw TCP) exposes metrics via a separate loopback http server on `RGOE_METRICS_PORT` (off by default) -- pass/drop by reason, slashes, active tunnels, verify-latency histogram. `lib/metrics.selftest.mjs`.
- [x] **T-MON-3 (P2) Dashboards + alerts.** DONE (loop-12): `monitoring/grafana-dashboard.json` (panels on the real T-MON-2 metric names, verify-latency histogram_quantile) + `monitoring/alerts.yml` (9 rules cross-ref SLO.md/INCIDENT.md) + `monitoring/README.md` (loopback scrape via tunnel). Burn-rate alerts deferred (need production volume).
- [x] **T-MON-4 (P2) External uptime checks.** DONE (loop-12): `scripts/uptime-probe.mjs` -- fetch bootnode /health + /directory over Tor, verify the signature against the pinned signer, emit JSON or `--format nagios` (exit 0/2), fail closed, privacy-scrubbed (count only). `scripts/uptime-probe.selftest.mjs` + `monitoring/UPTIME.md`.
- [x] **T-MON-5 (P2) SLOs + error budget.** DONE (loop-11): `docs/SLO.md` -- 6 SLIs mapped to the T-MON-2 metrics, proposed SLOs with windows/rationale, error-budget math tied to INCIDENT.md, explicit non-SLOs (anonymity is correctness not availability). Three targets flagged [NEEDS DATA] until a real fleet/cohort exists.
- [x] **T-FEAT-1 (P1) Bootnode federation / gossip.** More than one bootnode, gossiping announces
  so discovery is not a single availability point. A client can pin multiple bootnode signers and
  union their (independently-verified) directories. *Accept:* two bootnodes converge on the same
  live set; a client survives one going dark. *Why now-ish:* the bootnode is the one new
  single-point-of-availability the fleet added; this closes it.
- [x] **T-FEAT-2 (P1) `rgoe join` guided onboarding.** DONE (loop-10): `group/join.mjs` -- `rgoe join [member]` composes self-enrollment (secret to stderr, commitment + next commands to stdout) and `rgoe join gateway` mints an onion + prints the gateway/heartbeat commands. `group/join.selftest.mjs`.
- [x] **T-FEAT-3 (P2) Client SDK packaging.** DONE (loop-13): package.json `exports` (`./client`) + conservative `files` allowlist (stays `private:true` until the gates) + `docs/SDK.md` (constructor opts, fetch/connect, env, example). bin/entrypoints unaffected (internal relative imports not gated by exports).
- [x] **T-FEAT-4 (P2) Quality-aware rotation.** Clients report anonymized latency/success back; the
  bootnode aggregates it into the advertised `weight`/`health` (never per-member), so rotation
  favors good gateways beyond static weight. Must not become a linkability channel. *Accept:*
  a slow gateway loses weight fleet-wide; a privacy note proving no member is fingerprinted.
- [x] **T-FEAT-24 (P3, added loop-18; CORRECTED) Regression test for SWRR `_swrr` map bounding.** Correction to
  the loop-18 audit note: `_swrr` is ALREADY bounded — `spreadSelectionOrder` (`client/selection.mjs:384-387`)
  deletes every deficit key not in the current live fleet on each call, and when `RGOE_ROTATION_SPREAD` is off
  the map is never written at all, so there is no unbounded-growth bug (my original claim that it "is never
  pruned" was wrong — I hadn't read `spreadSelectionOrder` closely). The pruning is verified structurally but
  NOT yet covered by an explicit regression test (`_swrr` is module-private). Residual, minor: add a test seam
  (e.g. export `_swrrSize()`) and a `client/rotation.selftest.mjs` case that drives a spread, fully swaps the
  fleet's onions, drives another spread, and asserts the map retains only current-fleet keys — so a future edit
  can't silently reintroduce the leak. *Accept:* the test proves post-rotation `_swrr` holds only live-fleet keys.
- [x] **T-FEAT-5 (P2) Deterministic member subkeys.** DONE (loop-11): `lib/subkeys.mjs` -- HMAC-SHA512(master, `rgoe-subkey:v1\n{context}\n{index}`) mod FIELD -> a valid RLN secret; `deriveIdentity` composes it to a registerable rateCommitment. Determinism, unlinkability across 80 context/index pairs, field-range, RLN composition, master isolation, + a pinned golden vector. `lib/subkeys.selftest.mjs`.
- [x] **T-FEAT-6 (P2) Directory delta protocol.** DONE (loop-14): `GET /directory/delta?since=<etag>` -> {added, removed, unchanged, + the signed directory's signer/signature/order} or {full:true}. Client reconstructs base+delta and runs verifyDirectory, so a forged delta fails the signature/onion-binding (worst case: omit or refetch, per ADR 0003). Bounded version history. `bootnode/directory-delta.selftest.mjs` (incl. an adversarial forged-delta case).
- [x] **T-FEAT-17 (P2) Per-request SOCKS circuit isolation.** DONE (loop-12): `socksAuthForRequest(seed)` -> the client sends a unique SOCKS userId/password per REQUEST (seeded from the request nonce, so retries/failover of one request reuse its circuit while different requests get distinct circuits), so Tor `IsolateSOCKSAuth` gives each request its own circuit. Harmless against a no-auth SOCKS (verified vs node_modules/socks). Default-on (`RGOE_SOCKS_ISOLATION=0` to disable). `client/socks-isolation.selftest.mjs`.
- [x] **T-FEAT-20 (P2, added loop-14) Cross-fleet shared nonce tally (the T-FEAT-12 residual).** T-FEAT-12 defends ONE gateway against exact-envelope replay, but a non-colluding fleet has no shared spent-set, so a malicious gateway can fan a captured envelope to peers (each sees it once). Add a gossiped/shared per-epoch spent-nullifier tally across gateways (composes with T-FEAT-1 federation) so the rate cap + replay defense hold fleet-wide. Must pair with RLN's per-request nullifiers so the shared tally is not itself a linkability channel (ROADMAP #1). *Accept:* a replay to a SECOND gateway is rejected once the tally propagates. DONE (loop-29): the tally UNIT + loopback transport + gateway wiring (only nullifier+epoch cross, fail-open, default off). Remaining = the real transport (T-FEAT-20b).
- [ ] **T-FEAT-20b (P2, added loop-29) Real cross-host fleet-tally gossip transport.** T-FEAT-20 shipped the
  injectable tally + a loopback transport (two in-process gateways). Build the real async cross-host transport
  that implements the same `publish(nullifier,epoch)` / `subscribe(cb)` seam over the network (e.g. a
  gossip/pubsub among gateways, or via a bootnode relay), preserving the privacy invariant (ONLY nullifier+epoch
  on the wire) and fail-open behavior (a partition/malicious peer never denies service). Composes with T-FEAT-1
  federation (peers are already discovered). *Accept:* two gateways on separate processes/hosts reject a
  cross-gateway replay once gossip propagates; a killed peer degrades to per-gateway defense with no outage.
- [ ] **T-TEST-23 (P3, added loop-29) Make the test runner robust to parallel resource contention.**
  `scripts/test-all.mjs` runs node selftests and, under load (observed twice in loop-29 with concurrent
  subagents), 4 unrelated suites (`lib/metrics`, `test/adversarial`, `test/concurrency`, `test/log-hygiene`)
  flaked — all pass individually and on a clean re-run. Make the runner resilient: either bound concurrency,
  auto-retry a failed suite once in isolation before declaring red, or mark the genuinely
  contention-sensitive suites to run serially. *Accept:* the full suite is stable under a loaded machine
  (no false red from contention); a real failure still fails.
- [x] **T-FEAT-21 (P2, added loop-15) Directory `issued` max-age bound (client-side).** loop-15 F2 gave the client a monotonic `issued` FLOOR (never accept a directory older than the newest seen), which stops rollback within a session. It does NOT bound staleness on a COLD start: a client with no prior state accepts whatever `issued` the bootnode first serves, so a bootnode that is simply far behind (or is replaying a months-old directory to a fresh client) is undetectable. Add an optional absolute freshness bound — reject a fresh directory whose `issued` is older than `now - RGOE_DIRECTORY_MAX_AGE_MS` — with a generous default and clock-skew grace, fail-closed to the last-good cache. Must not break legitimate static-file directories (opt-in / large default). *Accept:* a directory `issued` beyond the max-age bound is rejected on first load; a within-bound one loads; the bound is configurable and off by default for file sources.
- [x] **T-TEST-18 (P2, added loop-15) Kill the OnchainStakeVerifier surviving mutants.** T-TEST-10's Stryker run scored 66% on `lib/gateway-registry.mjs`; every survivor clusters in the on-chain `OnchainStakeVerifier` path — error-message strings not asserted, the `now - hit.at < cacheMs` expiry boundary (`<` vs `<=`) untested, the operator cache-key `.toLowerCase()` untested (mixed-casing), the allowlist `.filter(Boolean)` drop untested, and the `typeof ret === "string"` / `/^0x0*/` return-shape guards untested. Source is correct; the suite just doesn't prove it. Add targeted cases to `lib/gateway-registry.selftest.mjs` to kill each. *Accept:* a re-run of `npx stryker run --mutate lib/gateway-registry.mjs` shows the named survivors killed (score materially up), source unchanged.
- [x] **T-TEST-19 (P1, added loop-16) Cover the `blockTag()` reorg-safety branch of OnchainStakeVerifier.** T-TEST-18's Stryker run left the ENTIRE `RGOE_CONFIRMATIONS > 0` head-N branch in `lib/gateway-registry.mjs` `blockTag()` (compute `latest - confirmations` and read stake at that older block) untested — every current test reads at `latest`, so no mutant in that branch is killed and a regression that silently disabled finality/reorg protection would pass green. This is real coverage of a security control (reading stake at a confirmed depth so a reorg can't flash a fake stake), not cosmetic. Add cases with an injected `eth_blockNumber` + a stubbed archival read asserting the request targets `latest - N` (hex) and that `RGOE_CONFIRMATIONS=0`/unset still reads `latest`. *Accept:* the `blockTag` branch mutants die; both the confirmed-depth and latest paths are asserted; source unchanged.
- [x] **T-FEAT-16 (P2, added loop-10) Gateway egress self-check before announce.** A gateway with broken clearnet egress (bad routing, firewall) would still announce and then DROP every member it gets routed. Have the gateway verify it can actually reach a :443 target on startup (and periodically) before it heartbeats to the bootnode, and stop announcing if egress fails, so a broken gateway removes itself from the fleet. *Accept:* a gateway with a blocked egress does not appear in /directory; a healthy one does; the check is metadata-only (no member traffic).
- [x] **T-FEAT-15 (P2, added loop-9) Automated encrypted key backup/restore.** The operator runbook
  marks onion-identity + operator-key backup as manual `tar | gpg`. Add `rgoe backup` / `rgoe restore`
  that GPG-encrypts the onion identity seed(s) + (optionally) the operator key to an off-box target
  and restores them on a fresh box, so key loss is recoverable and the procedure is not ad hoc.
  *Accept:* backup then restore on a clean box reproduces the same onion; secrets never written
  unencrypted; documented in OPERATOR.md.
- [x] **T-RUST-1b (P1) Signal-hash + operator-sig conformance vectors.** DONE (loop-10): added `signalHash` + a pinned-key `operatorAnnounce` to testdata/vectors.json (asserted JS-side); Rust `calculate_signal_hash` (keccak256 big-endian >>8) implemented + conformance-tested byte-exact. Operator-ECDSA verify_announce still stubbed (secp256k1/EIP-191 dep) but the vector now exists.
- [x] **T-FEAT-14 (P2) SearXNG / agent egress adapter.** DONE (loop-12): `docs/ADAPTERS.md` (proxy-style SearXNG `outgoing.proxies` snippet verified vs official docs + library-style RgoeClient; HTTPS-only constraint documented) + `examples/agent-egress.mjs`. Closes back to the origin use case.
- [x] **T-FEAT-13 (P2, added loop-7) Signed egress success receipts.** A gateway that accepts a
  proof could still silently drop the actual egress. Have the gateway return a small signed receipt
  (its onion pubkey signs `{nullifier-prefix, ts, ok}` — NO target, to avoid a logging channel) so a
  client can confirm the egress happened and accumulate evidence against a gateway that gates-then-
  drops, feeding the quality-aware rotation (T-FEAT-4). *Accept:* a successful egress returns a
  verifiable receipt; a gateway that drops traffic produces none; receipts carry no per-request
  target/member-identifying data.
- [x] **T-FEAT-22 (P2, added loop-16) Client receipt accumulation → quality-aware rotation.** T-FEAT-13
  now emits verifiable per-epoch egress-success receipts, but the client only checks the current one and
  discards it (`tunnel.rgoe.receipt`). Persist a bounded, decaying per-gateway receipt tally next to the
  existing gateway-health cache (`client/selection.mjs` T-FEAT-19 store) — a gateway that keeps returning
  valid receipts earns a selection bonus; one that accepts proofs but never produces a receipt (gate-then-
  drop signal) is deprioritized. Must not add a linkability channel (store only the gateway onion + a
  count/EWMA the client already learned locally, never receipt bytes tied to a request) and must be OFF
  by default / fully additive. Feeds the broader T-FEAT-4 quality-aware rotation. *Accept:* a gateway with
  a strong recent receipt record is preferred over an equal-weight silent one; disabling the feature
  restores today's weight-only selection exactly; the tally is bounded and privacy-preserving.
- [x] **T-FEAT-23 (P1, added loop-17) Wire receipt scoring into the client — close T-FEAT-22's seam.** T-FEAT-22
  shipped the accumulation engine (`reportReceipt`) and scoring in `client/selection.mjs` but deliberately did
  NOT edit `client/rgoe-client.mjs` (to stay disjoint from the loop-17 version-negotiation work), so the ONE
  line that folds a verified receipt into the tally is documented-but-unwired: after the existing
  `const receipt = this._verifyReceipt(ack.receipt, usedOnion, emit);` in `connect()`, call
  `if (receipt.present) reportReceipt(usedOnion, { valid: receipt.valid === true });`. Add the call, import
  `reportReceipt`, and add an integration selftest that drives a real connect()-path (injected ack with a
  receipt) and asserts the tally is updated only when `RGOE_RECEIPT_SCORING` is on and `receipt.present`.
  Must remain byte-identical to today when the flag is off. *Accept:* an end-to-end connect with a valid
  receipt raises that gateway's selection factor; flag-off is unchanged; the seam is no longer dangling.
- [x] **T-FEAT-12 (P2) Cross-gateway replay defense (per-epoch nonce cache).** DONE (per-gateway half, loop-14): `makeSpentSet` fingerprints (nullifier, share.x, nonce); an identical envelope within `RGOE_REPLAY_WINDOW_MS` (5s) is an idempotent honest retry, later => rejected `replayed-envelope` (drop metric + log). Slash logic untouched; failover safe (hits different gateways). `gateway/replay-cache.selftest.mjs`. REMAINING: the fleet-wide gossiped tally (T-FEAT-20).
- [x] **T-FEAT-11 (P2, added loop-5) Envelope/protocol version negotiation.** The wire envelope is
  now v3-with-nonce (loop-5). Add explicit min/max version negotiation between client and gateway (and
  in the announce/directory) so the envelope and announce formats can evolve to v4+ without a flag
  day: a gateway advertises supported versions, the client picks the highest mutually supported, and
  an unknown version is rejected with a clear reason rather than a silent mis-parse. *Accept:* a
  client and gateway on overlapping ranges interoperate; on disjoint ranges they fail with a precise
  version error; a downgrade cannot strip the target binding.
- [ ] **T-TEST-20 (P2, added loop-17) Directory version-range advertisement + negotiation e2e.** T-FEAT-11
  negotiates protocol version only over the client↔gateway handshake (the gateway advertises its range in the
  version-reject reply); it explicitly deferred advertising the supported range in the SIGNED announce/directory
  so a client could pre-filter or pre-select before dialing. Add the range to `bootnode/announce.mjs` +
  `lib/directory.mjs` (additive, verified fields — old directories without it still verify) and have
  `client/selection.mjs` prefer a gateway whose advertised range overlaps the client's, plus an end-to-end
  test exercising directory-advertised range → client pre-selection → gateway handshake agreement. Composes
  with T-FEAT-10 (capability advertisement). *Accept:* a directory carrying per-gateway version ranges verifies;
  a client skips a gateway with no mutual version BEFORE dialing; absent ranges behave exactly as today.
- [ ] **T-FEAT-10 (P2, added loop-4) Gateway capability advertisement + capability-aware selection.**
  Gateways advertise capabilities in their signed announce (allowed egress ports/policy, a region/AS
  hint, protocol versions); clients select gateways matching the request's needs, so the fleet goes
  from "any gateway" to "the right gateway" as egress policy grows (T-DEV-10). Capabilities must be
  coarse enough not to fingerprint a member's request. *Accept:* an announce carries signed
  capabilities; a client needing port X only selects gateways advertising X; capability set is
  bucketed, not free-form.
- [x] **T-FEAT-9 (P2, added loop-3) Threshold-signed directory.** Today the directory trusts one
  bootnode signer key; compromising it poisons every client's fleet view (they still can't be sent a
  forged onion — onion-control is re-checked — but entries could be omitted/reordered). Sign the
  directory with a k-of-n set of independent bootnode signers so no single key compromise steers the
  fleet. Composes with T-FEAT-1 (federation): each federated bootnode is one signer. *Accept:*
  clients accept a directory only with >= k valid signatures from the pinned signer set; a single
  rogue signer cannot produce an accepted directory. *Depends on:* T-FEAT-1. DONE (loop-30, JS): additive
  signers/signatures/threshold, distinct-pinned-signer counting, adversarial-total; golden vectors unchanged.
  Rust parity = T-FEAT-9b.
- [ ] **T-FEAT-9b (P2, added loop-30) Rust threshold-directory verify parity.** The Rust port
  `rust/rgoe-proto/src/lib.rs verify_directory` + its `Directory` struct are single-signer only (they treat a
  threshold directory as `unsigned`). Add `signers`/`signatures`/`threshold` to the struct and a
  `verify_directory_threshold` sibling mirroring the JS distinct-pinned-signer counting + reason codes, and
  conformance-check it against the `thresholdDirectory` vector. *Accept:* Rust accepts a valid 2-of-3 threshold
  directory and rejects sub-threshold/duplicate/unpinned, matching JS; single-sig path unchanged.
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
- 2026-08-13  loop-14 (AGGRESSIVE FAN-OUT, 6 agents + 1 review) closed 6 tasks: T-DEV-7b (config
  validation wired into the CLI, fail-fast), T-FEAT-12 (per-gateway replay cache), T-FEAT-6 (directory delta
  with reconstruct-and-verify trust), T-FEAT-19 (client gateway-reputation persistence), T-TEST-15 (fuzz
  regression corpus, 16 entries), T-WEB-2 (landing how-tos). AUDIT of the loop-13 signer-rotation allowlist:
  clean (unpinned signer can never verify; empty fails closed; single-string backward-compat exact). Fixed
  the one LOW footgun it found (0x-prefixed pin silently rejected -> now accepted) + regression test.
  40 node+forge suites green; lint clean. Added T-FEAT-20 (cross-fleet shared nonce tally).
- 2026-08-13  loop-15  Fan-out batch of 6 (disjoint files): T-FEAT-16 (gateway egress self-check before
  announce — metadata-only TCP connect probe, skips the heartbeat when clearnet egress is down so a broken
  gateway ages out of /directory), T-DEV-12 (bootnode active health probing — per-onion consecutive-fail
  demote to health:"down", off by default via RGOE_BOOTNODE_PROBE), T-FEAT-15 (encrypted key backup/restore —
  scrypt+AES-256-GCM, no plaintext to disk, `rgoe backup`/`restore`), T-TEST-10 (Stryker mutation testing
  over the verify/slash/directory paths, diagnostic not gate), T-WEB-3 (zero-dep docs-site generator, 43
  pages), T-DEPLOY-6 (health-gated rolling update + multi-box drain sequencing). AUDIT of the directory
  /delta protocol: clean (adds no forgery power — onion↔pubkey binding + reconstruct-and-verify hold, every
  mismatch fails closed to a full refetch). Fixed the F2 it surfaced (directory ROLLBACK/stale-replay: the
  bootnode signs its own directory and ed25519 sigs never expire, so a hostile/replaying bootnode could serve
  an OLD signed directory to resurrect a dropped/slashed gateway — client now enforces a monotonic `issued`
  floor in selection.mjs, fail-closed to the last-good fleet; client/directory-rollback.selftest.mjs). Fixed
  test-all discovery walking `.stryker-tmp` (phantom mutated-source failures). 43 node selftests green; lint
  clean. Added T-FEAT-21 (directory issued max-age bound) + T-TEST-18 (OnchainStakeVerifier mutant-gap tests).
- 2026-08-14  loop-16  Fan-out batch of 6 (disjoint files): T-FEAT-21 (client-side directory `issued`
  max-age bound — closes the cold-start staleness gap the monotonic floor can't cover; off by default,
  scales issued-seconds*1000 vs Date.now, fail-closed; client/directory-maxage.selftest.mjs), T-TEST-18
  (killed the OnchainStakeVerifier mutant survivors T-TEST-10 found — mutation score 66%→72%, 17 assertions
  across error-strings/cache-boundary/lowercase-key/filter(Boolean)/return-shape; remaining survivors shown
  to be equivalent mutants), T-TEST-14 (chaos/failure-injection e2e — 27 fail-closed assertions: dead
  gateway failover, partial/all-down fleet, fetch-throws→LKG-cache, corrupt signature, onion↔pubkey graft,
  reverify faults), T-TEST-7 (bounded deterministic soak ~1.2s — replay cache bounded across 40k volume,
  weight-clamp holds over 30k draws, registry flood caps; RGOE_SOAK=1 heavy variant), T-DEPLOY-3
  (OpenTofu/Terraform IaC — DO droplet+firewall+cloud-init that delegates to bootstrap.sh at a pinned ref;
  tofu validate clean, nothing applied), T-FEAT-13 (privacy-preserving signed egress receipts — onion-key
  signed, coarse-epoch only, domain-separated from announce sigs, ZERO per-request/member/target fields,
  default off byte-identical; lib/receipt.mjs + gateway/receipt.selftest.mjs + docs/RECEIPTS.md). AUDIT:
  all six ship with adversarial selftests; receipt privacy (no linkability channel) and IaC (no secrets, no
  duplicated provisioning) reviewed at spec time. Hygiene: eslint now ignores `.stryker-tmp/` + `reports/`
  so a mutation run can't break `npm run lint`. 48 node + 53 Foundry tests green; lint clean. Added T-TEST-19
  (blockTag reorg-safety branch tests) + T-FEAT-22 (client receipt accumulation → quality-aware rotation).
- 2026-08-14  loop-17  Fan-out batch of 6 (disjoint files): T-TEST-19 (covered the untested
  OnchainStakeVerifier `blockTag()` reorg-safety branch — asserts the stake read targets confirmed depth
  head-N, not `latest`; killed every finality-critical mutant, remaining one shown equivalent), T-FEAT-22
  (client receipt accumulation → quality-aware selection: bounded/decaying EWMA per gateway, ±BONUS weight
  factor, off by default & byte-identical when off, stores only onion+3 local numbers = no linkability;
  reportReceipt seam exposed, one-line client wire-up documented), T-FEAT-11 (envelope protocol version
  negotiation — client picks highest mutual version, fail-closed on disjoint ranges, absent-version==v3
  backward-compat, target binding stays independent of version), T-DEPLOY-7 (Foundry deploy script for
  GatewayRegistry+StakedReputationSet matched to real constructors + ONCHAIN-DEPLOY runbook; simulated in
  3 scenarios, nothing broadcast — live broadcast is a gated operator step), T-DEPLOY-5 (onion-identity
  continuity tooling: derive `.onion` from a bare `hs_ed25519_secret_key` + restore a Tor HS dir with
  correct perms, so the SAME onion survives a box rebuild), T-WEB-4 (privacy-preserving fleet diversity
  map — aggregate/self-declared coarse labels only, small buckets folded, no onion→geo resolution). AUDIT
  (riskiest change = T-DEPLOY-5's HAND-ROLLED ed25519 A=a·B, needed because node:crypto only derives a
  pubkey from a 32-byte seed not the expanded scalar): cross-checked the derivation against node:crypto over
  200 random keys — 200/200 match; hardened its selftest from 1 to 24 cross-checked keys. Verified T-WEB-4's
  suite (its agent never delivered a final report) and T-DEPLOY-7's forge suite directly. 52 node + 53
  Foundry tests green; lint clean; receipt cache gitignored. Added T-TEST-20 (directory version-range
  advertisement + negotiation e2e) + T-FEAT-23 (wire receipt scoring into rgoe-client — close T-FEAT-22's
  one-line integration seam).
- 2026-08-14  loop-18  Fan-out batch of 6 (disjoint files): T-FEAT-23 (closed T-FEAT-22's seam — wired
  reportReceipt into rgoe-client's connect() via the existing LAZY _sel() import [a static import would fire
  before the constructor sets directory/signer env]; full connect()-path integration selftest), T-TEST-8
  (containerized bootstrap e2e — new bootstrap-e2e.yml + e2e-container.sh running bootstrap.sh under real
  systemd in a privileged ubuntu:24.04; the agent launched Docker and ran it to a PASS on arm64 — units
  active, onions published, /health ok — and fixed a real harness bug), T-TEST-21 (209-assertion adversarial
  hardening of the receipt + version surfaces, no defect found), T-DOC-7 (auditor THREAT-MODEL.md, 15
  properties cited to file:function, honest residuals), T-TEST-22 (additive golden vectors byte-pinning the
  receipt canonical bytes + sig for the coming Rust conformance), T-FEAT-4 (quality-aware rotation — smooth
  weighted round-robin slot-0 for anti-stickiness/spread, flag-gated off by default, long-run weighted
  distribution preserved exactly, all exports intact). AUDIT (riskiest = T-FEAT-4's SWRR ordering): verified
  the scheduler is the canonical nginx SWRR (total recomputed per pick, winner deficit -= total, all-zero →
  uniform, phase jitter so clients don't emit linkable sequences); the flag-off path is byte-identical (proven)
  and the T-FEAT-23×T-FEAT-4 interaction on selection.mjs is covered by receipt-integration passing green.
  55 node selftests + 53 Foundry tests green; lint clean. Added T-FEAT-24 (bound the SWRR `_swrr` state map)
  + T-DEV-9 flagged for a focused on-chain run (not fan-out).
- 2026-08-14  loop-18b (correction)  The loop-18 audit note above claimed T-FEAT-4's `_swrr` map "is never
  pruned" — that was WRONG. Re-reading `spreadSelectionOrder` (`client/selection.mjs:384-387`): it deletes every
  deficit key not in the current live fleet on each spread call, and the map is never written when the flag is
  off, so there is no unbounded-growth bug. Corrected T-FEAT-24 to its real residual: add an explicit regression
  test for the (already-present) bounding. Recording the correction rather than silently editing history.
- 2026-08-14  loop-19  FOCUSED single run (not fan-out): Rust client MVP deterministic core (T-RUST-2, Gate 2).
  `rgoe-proto` gained receipt verify + version negotiation + gateway selection, each ported from the cited JS
  and byte-pinned against testdata/vectors.json (the new receipt + protoReasons vectors); `rgoe-client` is now a
  real CLI (verify-directory / select / verify-receipt) parsing untrusted JSON (serde client-side only, proto
  canonical path stays serde-free). 20 conformance + 9 unit tests green; clippy + fmt clean. The live egress
  (arti Tor dial + zerokit RLN proving + real proxy) is honestly stubbed and split out as T-RUST-2b — Gate 2
  stays open until it lands. INTEGRATION AUDIT: ran a JS↔Rust receipt-verify differential (48/48 agree over
  valid/wrong-onion/tampered-flag/tampered-sig across 12 fresh identities) and an end-to-end verify→select smoke
  against a JS-signed directory (pinned signer accepted, wrong signer rejected `signer-not-pinned`). Only rust/
  files touched. Added T-RUST-2b (live egress) to the backlog.
- 2026-08-14  loop-20  FOCUSED single run (not fan-out): T-RUST-2b RLN-INTEROP slice — the Gate-2 CRUX. A
  Rust-generated RLN Groth16 envelope proof is ACCEPTED by the JS reference verifyEnvelope (ok:true), against
  the repo's own circuits/rln/* artifacts. FEASIBILITY (probed before building): the rln+arti dep graph hit a
  native-zstd `links` collision (sled vs async-compression), cleared by feature surgery; cold compile 45s, no
  toolchain wall. FORK (as predicted): zerokit 3.0 can't read the repo's snarkjs .zkey (own arkzkey format +
  bundled setup), resolved via ark-circom loading the repo's own rln_final.zkey + rln.wasm (same circom compile,
  zero witness-mismatch risk). New crate rust/rgoe-rln, excluded from default-members so the everyday build stays
  0.29s. INTEGRATION AUDIT (mine): reran `bash rust/rgoe-rln/interop/run.sh` — target binding, public-signal
  equivalence with rlnjs, Rust proof verifies vs the repo verification_key.json, verifyEnvelope accepts the Rust
  envelope, and a cross-impl over-spend recovers the exact identitySecret. Guardrails held (rgoe-proto 9+20 green,
  default build 0.29s, clippy/fmt clean, only rust/ touched). T-RUST-2b marked [~]; filed T-RUST-2c (native
  merkle tree), T-RUST-2d (wire into rgoe-client), T-RUST-2e (arti Tor dial) as the remaining Gate-2 slices.
- 2026-08-14  loop-21  FOCUSED single run: T-RUST-2c native Rust RLN merkle tree parity. The Rust side now
  computes its OWN depth-20 Poseidon root+path (was borrowing a JS fixture root). TREE CONVENTION (read from the
  pinned deps, not guessed): lib/rln.mjs newGroup → rlnjs's nested Semaphore v3 @semaphore-protocol/group@3.15.2
  → @zk-kit/incremental-merkle-tree — binary poseidon2(BN254), fixed depth 20, zero value =
  keccak256(be32(RLN_IDENTIFIER=1))>>8 (NOT 0, NOT Poseidon), left-to-right insertion. Key finding: the app's
  top-level Semaphore v4 LeanIMT does NOT match — rlnjs reaches into the nested v3 group. Built src/tree.rs (via
  light-poseidon 0.4 on the crate's ark 0.5, byte-matches poseidon-lite) + a tree emitter bin + tree_parity tests
  + interop/tree-run.sh. INTEGRATION AUDIT (mine): reran the harness — Rust root == rlnjs group root over 4 member
  sets, and a Rust-computed root+path (single-member AND member-at-index-1 with real internal-node siblings) drives
  the prover to a verifyEnvelope ok:true. Guardrails: rgoe-proto 9+20 green, tree_parity 5/5, default build 0.07s,
  clippy/fmt clean, only rust/ touched, no regression in the loop-20 run.sh. T-RUST-2c done; T-RUST-2d/2e remain.
- 2026-08-14  loop-22  FOCUSED single run: T-RUST-2d — wire the RLN prover + native tree into rgoe-client. The
  REAL JS gateway (gateway/gateway.mjs) now ACCEPTS the Rust `rgoe egress` envelope end-to-end over a plain TCP
  socket (Tor deferred to T-RUST-2e). Prover promoted to a library `rgoe-rln/src/prover.rs` (build_envelope: native
  tree root/path + target binding via rgoe-proto calculate_signal_hash + native externalNullifier + ark-circom
  Groth16 over the repo zkey, self-verified before return); added native external_nullifier + a test pinning it to
  4 JS reference values. rgoe-client gains an OPTIONAL `live` cargo feature (`dep:rgoe-rln`) so the DEFAULT build
  stays fast (cargo tree confirms no ark/wasmer in the default graph; default build 0.19s). `rgoe egress` builds
  the envelope and dials plain TCP, matching client/rgoe-client.mjs framing byte-for-byte (JSON+\n, ack read to
  first \n). Fork hit + fixed: a TCP connect-probe half-opened the gateway's envelope read and EPIPE-crashed it —
  readiness now waits on the `gateway up` log line. INTEGRATION AUDIT (mine): ran interop/egress-run.sh — Layer 2
  (verify-socket) and Layer 3 (real gateway process) both ACCEPT the Rust envelope; the harness backs up/restores
  group/members.json (confirmed clean via git status after). Guardrails: rgoe-proto 9+20 green, rgoe-rln 5 tree +
  1 externalNullifier green, default build 0.19s, clippy/fmt clean (default AND --features live), only rust/
  touched. T-RUST-2d done. ONLY T-RUST-2e (arti Tor dial) remains to close Gate 2.
- 2026-08-14  loop-23  FOCUSED single run: T-RUST-2e arti Tor dial — GATE 2 CODE PATH CLOSED. The Rust client
  now egresses over EMBEDDED TOR: `rgoe egress --onion` bootstraps arti, dials the gateway's v3 onion, and the
  live JS gateway ACCEPTS the RLN envelope end-to-end over Tor. `arti-client` (default-features=false,
  features=tokio/rustls/onion-service-client) + tor-rtcompat + tokio, all behind the `live` feature and optional,
  so the DEFAULT build stays ~0.14s (cargo tree: no arti/tokio/ark in the default graph). The loop-19 zstd `links`
  worry did NOT materialize — the prover is ark-circom (no sled), and arti's async-compression with
  default-features off resolves to pure-Rust zlib (no native zstd). Transport is selectable (`--onion`/directory
  over Tor by default, `--plain-tcp` preserves loop-22). INTEGRATION AUDIT (mine): reran the plain-TCP
  egress-run.sh (Layer 3 gateway accept, authoritative always-green) AND the gated over-Tor egress-tor-run.sh
  (RGOE_TOR_E2E=1, system tor present) — independently reproduced a REAL over-Tor gateway accept on the first
  attempt. Guardrails: rgoe-proto 9+20 green, default build 0.14s, clippy/fmt clean (default AND --features live).
  Marked T-RUST-2 [x] (MVP: conformance + byte-for-byte over-Tor egress = Gate-2 definition met). Filed T-RUST-2f
  (harden the over-Tor harness's cleanup — it leaked gateway/tor children when its stdout was piped). Remaining
  for a full distributable: T-RUST-3 (rotation/failover/LKG/discovery parity), T-RUST-4 (binaries); production
  trust is orthogonal (T-DEV-1 real verifier, T-HARD-1 trusted setup, T-TEST-1 CI real-Tor). Only rust/ touched.
- 2026-08-14  loop-24  FOCUSED single run: T-RUST-3 Rust client operational parity + T-RUST-2f harness cleanup.
  The Rust `rgoe` client now has the JS client's resilient per-request loop (behind the `live` feature; default
  build stays 0.44s, cargo tree clean): (1) gateway ROTATION + FAILOVER — one envelope built and reused across an
  ordered candidate list (deterministic-retry parity), rotate on dial failure, a gateway that replies is terminal;
  (2) LAST-KNOWN-GOOD directory cache (new dircache.rs) — verify fresh vs pinned signer, enforce the rollback
  `issued` floor + optional max-age (T-FEAT-21), fall back to the verified cache when fresh fails, never serve an
  unverified directory (ported the client-side guards, which rgoe-proto didn't have); (3) cross-session gateway
  health persistence (new health.rs, byte-compatible with selection.mjs's cache + privacy guard + 14d decay);
  (4) bootnode discovery — `fetch-directory` (plain-TCP/file, proven) and over-Tor `--bootnode-onion` (compiles +
  clippy-clean, E2E gated like the tor harness). Also FIXED T-RUST-2f: the new failover-lkg-run.sh uses
  `trap cleanup EXIT INT TERM HUP PIPE` + pidfile reap, so a piped/signalled run leaks zero gateway/tor procs.
  INTEGRATION AUDIT (mine): ran failover-lkg-run.sh PIPED (the exact loop-23 leak trigger) — Layer A: dead first
  candidate (127.0.0.1:1 refused) → client rotates → real gateway ACCEPTS the same envelope; Layer B: LKG
  write/fallback + a validly-signed rollback (issued 100<200) REFUSED with the cache kept; zero leaked processes,
  members.json restored. Guardrails: proto 9+20 green, rgoe-client 12 tests green (default AND --features live),
  default build 0.44s, clippy/fmt clean, egress-run.sh still passes, no new deps, only rust/ touched. T-RUST-3 +
  T-RUST-2f done. Filed T-RUST-3b (persisted K-slot cursor + reuse one bootstrapped TorClient across failover).
- 2026-08-14  loop-25  FOCUSED single run: T-RUST-4 release binaries — the Rust client is now a DOWNLOADABLE
  distributable. `.github/workflows/release.yml` (new, tag v* / workflow_dispatch; ci.yml untouched): a `default`
  matrix cross-compiles the pure-Rust core `rgoe` (linux gnu+musl x86_64/aarch64 via cargo-zigbuild, macOS
  native, windows-msvc) + a `live` matrix builds the egress binary NATIVELY per runner (no wasmer/arti
  cross-compile rabbit hole), strips via the existing release profile, uploads assets with .sha256. Self-contained
  live binary: new `embedded-artifacts` feature on rgoe-rln include_bytes!s rln.wasm + rln_final.zkey +
  verification_key.json (behind rgoe-client's `live` feature); prover.rs `circuits_dir: Option` (None = embedded),
  `--circuits` now optional. rust/INSTALL.md added (download/checksum/run + default-vs-live platform tables +
  testnet-only-artifacts caveat). INTEGRATION AUDIT (mine): default release binary 453KB with a clean graph (no
  ark/arti/wasmer — cargo tree); live binary 16.25MB (embeds 7.6MB artifacts); ran `rgoe egress` with NO
  --circuits (log `circuits=embedded`) → the real verifyEnvelope ACCEPTED the proof; loop-22 egress-run.sh
  (external path) still passes; release.yml is valid YAML (jobs set-version/default/live). Guardrails: proto 9+20
  green, clippy/fmt clean (default AND --features live), only rust/ + .github/workflows/release.yml touched, no git
  tag/release created (operator triggers). T-RUST-4 done. THE "MAKE IT A REAL DISTRIBUTABLE" GOAL IS COMPLETE
  (T-RUST-2/2b/2c/2d/2e/3/4 all done); T-RUST-3b (slot cursor) is the only minor client follow-up left.
- 2026-08-14  loop-26  FOCUSED single run: T-DEV-2 RLN leaf-removal parity (Gate-1 correctness). Found the
  contract (StakedReputationSet.sol) is the source of truth and uses ZERO-IN-PLACE (append-only immutable index
  via nextIndex++, slash/exit deletes the member but preserves every other index — matches Semaphore v3
  removeMember→delete→update(index, zeroes[0])). So the JS side was WRONG: reconstructRoot rebuilt a compacted
  tree of survivors (renumbering), diverging from the contract root after any removal. FIX (JS only, contract
  untouched): rewrote lib/root-provider.mjs reconstructRoot as an event-replay mirroring the contract —
  register→addMember at the next index, slash/exit/withdraw→removeMember at the ORIGINAL index (zero-in-place),
  tracking commitment→live-index. Also fixed a latent bug (the old commitment-keyed removed-Set permanently
  dropped a slashed-then-re-registered commitment; the replay re-admits it at a fresh index, matching the
  contract's test_ReRegister_AfterSlash). Corrected lib/root-provider.selftest.mjs cases #3/#4 which asserted the
  WRONG renumber semantics (called out explicitly, justified against the contract) and added an independent
  zero-in-place oracle. AUDIT (mine): the fix triangulates three INDEPENDENT ways — reconstructRoot (event-replay)
  == direct oracle (addMember×3 then removeMember(1)) == pinned GOLDEN_ROOT, AND asserted ≠ the old renumber root
  (regression guard), AND a new Foundry test_Slash_Middle_PreservesIndices proves the contract keeps indices 0/2
  (vacated slot never reused). register-3/slash-middle root =
  14367190620832145537223890636337926502210861635134078778082353204233456513838. Full suite 56/56 green (node +
  54 Foundry). Filed T-DEV-2b (Rust tree removal parity — rgoe-rln/tree.rs is insertion-only; must adopt the same
  zero-in-place convention when removal is added). Next Gate-1 item: T-TEST-1 (wire real-Tor e2e into CI).
- 2026-08-14  loop-27  FOCUSED single run: T-TEST-1 real-Tor fleet e2e (Gate-1). A local + CI harness that runs
  the JS REFERENCE client end-to-end through a real published .onion gateway over REAL Tor: client discovers/dials
  the gateway onion over Tor, mints a real per-request RLN proof, the gateway ACCEPTS + proxies the CONNECT, and a
  local sink receives the tunneled connection. Deliverables (all new, no source edits): test/real-tor-e2e.sh
  (local, gated RGOE_TOR_E2E=1, publishes the gateway HS via system tor + SOCKS, retries the dial, asserts
  client-ok + gateway egress-log + sink-hit, soft-skips on propagation timeout), test/real-tor-e2e-client.mjs
  (thin driver over RgoeClient.connect), test/real-tor-e2e-container.sh (authoritative CI runner over the
  systemd-container fleet from bootstrap.sh), .github/workflows/real-tor-e2e.yml (additive; ci.yml untouched),
  test/REAL-TOR-E2E.md. Reuses the SIGPIPE-robust cleanup (trap EXIT INT TERM HUP PIPE + pidfile reap).
  INTEGRATION AUDIT (mine): ran the harness PIPED — this time local Tor bootstrapped and I OBSERVED a REAL
  over-Tor accept end-to-end: `{"accept":true,"onion":"hhkv...piad","nullifier":"14137..."}`, gateway logged
  `egress target=... nullifier=...`, sink logged `connection #1 from gateway`. No-leak verified (piped run, zero
  leftover tor/gateway/sink procs; members.json restored). Suite 56/56 green (harness is not part of it); YAML
  valid. NOTE: the over-Tor step stays gated/soft-skip in CI + locally because HS descriptor propagation is
  network-dependent (the agent's own run soft-skipped when Tor stalled — honestly reported). GATE 1 tractable
  items DONE (T-DEV-2 + T-TEST-1); only T-DEV-1 remains, BLOCKED on the human trusted setup T-HARD-1.
- 2026-08-14  loop-28  FOCUSED single run: T-DEV-1 real Groth16 exit-auth verifier (Gate-1 P0). Discovery: this
  was only PRODUCTION-trust-blocked, not code-blocked — the withdraw circuit dev artifacts already ship, so wiring
  the real verifier USES the existing (testnet) ceremony output rather than running one (T-HARD-1 stays the human
  production item). Replaced MockWithdrawVerifier with a real verifier: `contracts/WithdrawGroth16Verifier.sol`
  (snarkjs zkey export solidityverifier from the committed withdraw_final.zkey, renamed to avoid the RLN
  Groth16Verifier clash) + `contracts/WithdrawVerifier.sol` (IWithdrawVerifier adapter). LOAD-BEARING mapping
  (confirmed empirically by generating a real proof + inspecting publicSignals): withdraw circuit public signals =
  [identityCommitment, address] (identityCommitment = Poseidon1([identitySecret])); the member LEAF is the RLN rate
  commitment Poseidon2([identityCommitment, K=8]). verify() checks Groth16 over [identityCommitment, addr] AND
  Poseidon2([identityCommitment,K])==commitment (ties proof to THIS member's leaf) AND addr = context%FIELD (binds
  the action/recipient) — returns false (clean BadProof) on any bad proof. Real-proof golden fixture
  (testdata/withdraw-proof.json, NO witness/secret) + generator. DeployRegistry.s.sol: opt-in
  RGOE_DEPLOY_REAL_VERIFIER=1 (default stays Mock so the reveal-secret demo path is preserved). Cheats.sol +
  readFile/parseJsonBytes (additive). INTEGRATION AUDIT (mine): reran the 11 WithdrawVerifier.t.sol tests — valid
  exit/withdraw authorize (withdraw pays the recipient); tampered / wrong-context / wrong-commitment /
  wrong-recipient / malformed all revert BadProof; fixture verified secret-free; Mock intact. Full suite 56/56
  node + 65 Foundry (8 suites) green. Testnet-only caveat placed in both contracts' NatSpec + deploy warning +
  fixture + generator (all -> circuits/rln/ARTIFACTS.md). GATE 1 CODE PATH COMPLETE (T-DEV-1/2 + T-TEST-1). The
  only thing between here and a real deploy is the HUMAN-run production trusted-setup ceremony (T-HARD-1) — I
  cannot and must not run it. Gate 3 (deploy) is unblocked on code, gated on that ceremony + a human deploy go.
- 2026-08-14  loop-29  BREADTH fan-out of 5 (disjoint files): T-FEAT-1 (bootnode federation/gossip —
  RGOE_BOOTNODE_PEERS pull loop re-verifies each gossiped gateway through the SAME verifyAnnounce path
  [onion-control + operator sig + live isStaked]; the peer's directory signature carries ZERO admission weight;
  pulls the self-authenticating per-gateway announce, not /directory; TTL from the origin announce; 40 offline
  assertions incl. 7 rejection cases; default byte-identical), T-FEAT-20 (cross-fleet shared nonce tally, closes
  the T-FEAT-12 fleet-wide residual — only (nullifier,epoch) crosses the wire [per-epoch pseudorandom, no
  member/share.y/target → no linkability], FAIL-OPEN defense-in-depth, bounded/epoch-scoped; two-gateway replay
  rejected; a distributed over-spend is rejected but NOT slashed cross-gateway [refuses to ship share.y];
  default byte-identical), T-DEV-2b (Rust tree remove() zero-in-place — register-3/remove-middle root ==
  the loop-26 JS golden, confirmed 3 ways), T-RUST-3b (persisted K-slot cursor [K=8 from lib/rln.mjs; advances
  0→1→2, resets on epoch roll] + single-bootstrap TorClient reuse across failover), T-FEAT-24 (regression test
  proving the SWRR _swrr map prunes departed-fleet keys after a full churn). INTEGRATION AUDIT (mine): reran the
  federation rejection suite (all 7 forged/tampered/stale/unstaked cases rejected + not merged) and the
  fleet-tally privacy/two-gateway/fail-open cases; confirmed only (nullifier,epoch) crosses. Guardrails: JS suite
  57/57, Rust rgoe-client 21 / rgoe-proto 9+20 / rgoe-rln 6+1 green, default Rust build fast (clean graph),
  clippy/fmt/lint clean, all files disjoint. Filed T-FEAT-20b (real async cross-host fleet-tally gossip transport
  — this run is loopback-only) + T-TEST-23 (make scripts/test-all.mjs robust to parallel resource contention;
  4 unrelated suites flaked under load twice this loop, all pass individually).
- 2026-08-14  loop-30  FOCUSED single run: T-FEAT-9 threshold-signed directory (M-of-N). Removes the
  single-directory-signer trust point — composes with loop-29 federation (each bootnode = one signer). STRICTLY
  ADDITIVE: three OPTIONAL top-level fields (signers/signatures/threshold) EXCLUDED from canonicalDirectoryBytes
  exactly like the single-sig signer/signature, so every signer signs the SAME canonical bytes and the encoding
  is byte-unchanged; a directory with none of them falls through to the unchanged single-signer path (the 1-of-1
  case). verifyDirectory delegates to verifyDirectoryThreshold when threshold fields are present: accept iff
  >= threshold DISTINCT signers from the client's PINNED allowlist (reuses normalizePinnedSigners / the T-HARD-5
  rotation set) each produced a valid sig. TOTAL/adversarial-safe: duplicate signer counted once, unpinned
  ignored, malformed skipped (no throw), bad-threshold / threshold-exceeds-signers / threshold-not-met:g/w
  reasons. New exports signDirectoryThreshold / verifyDirectoryThreshold / ed25519PubFromSeed;
  lib/directory-threshold.selftest.mjs. INTEGRATION AUDIT (mine): git-diffed testdata/vectors.json — the existing
  canonicalDirectoryBytesHex/directorySignature vectors are UNTOUCHED (additive only: new thresholdDirectory
  block, whose canonical bytes == the existing canonicalDirectoryBytesHex, proving same-bytes signing); rotation
  + vectors selftests green unchanged; adversarial garbage → ok:false no throw. Full suite 59/59 green; lint
  clean. Filed T-FEAT-9b (Rust verify_directory threshold parity — the Rust port is single-signer only).
