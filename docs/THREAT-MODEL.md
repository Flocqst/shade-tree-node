# Threat model

This is the consolidated, auditor-facing threat model for the reputation-gated onion egress
system. It names the assets, the actors and adversary classes, states what each party is trusted
for and — more importantly — what it is *not* trusted for, and maps each security property to the
exact code that enforces it (`file:function`). It ends with the known residual risks (honestly, and
cross-referenced to the tracked tasks) and a short "where to start" for a review.

Ground rules for this document:

- Every enforced property below cites the function that enforces it. Where a property is designed
  but the enforcement path is not fully wired in the shipped code, it is marked **claimed,
  unverified** rather than asserted.
- This is a reference implementation, **unaudited**, with **testnet-only ZK artifacts** from an
  untrusted phase-2 ceremony (`circuits/rln/ARTIFACTS.md`, `SECURITY.md`). Nothing here is a
  production security guarantee. Read `docs/AUDIT.md` first; this page is its threat-model companion.

---

## 1. Assets

| Asset | What it is | Where it lives | Compromise impact |
|---|---|---|---|
| Member identity secret | The app field-element secret behind a Semaphore v3 / RLN identity | Client only, never on the wire | Full impersonation of that member; recovering it is exactly what a slash does to punish over-spend |
| `identitySecret` | `Poseidon2(nullifier, trapdoor)` of the identity; the value a slash reveals | Derived client-side (`lib/rln.mjs:identitySecretOf`) | Reconstructable by anyone who sees two shares under one nullifier — that is the slashing mechanism, not a leak |
| Member unlinkability | The property that a gateway cannot tie two of a member's requests together | Enforced by RLN nullifier structure + fleet rotation | Loss = a member becomes a coherent profile to an operator |
| Gateway onion identity key | The ed25519 seed behind a v3 `.onion` (a `.onion` **is** this pubkey) | Operator host (`tor/hs/`, `bootnode/keygen.mjs`) | Lets an attacker impersonate that gateway in the directory/announce |
| Directory signer key | The pinned ed25519 key that signs the fleet directory | Bootnode / offline signer | Lets an attacker sign a poisoned fleet list — but see the layered onion↔key check below |
| On-chain bonds | Member bonds (`StakedReputationSet`) and operator bonds (`GatewayRegistry`) | Ethereum (Sepolia) | Fund-custody / slash-authorization bugs |
| Target metadata | The `host:port` a member egresses to (never plaintext) | Seen only by the gateway serving that request | The residual exposure the fleet-rotation design is built to spread to ~1/N |

---

## 2. Actors and adversary classes

**Honest actors**

- **Member (client).** Holds a membership secret, proves membership per request, selects a gateway
  per request, egresses over a Tor rendezvous with no exit node. Anonymous to the gateway (the
  gateway sees `127.0.0.1`).
- **Gateway / operator.** Runs an onion service that proxies member egress to a public IP. Optionally
  stakes an operator address on chain. Pays the gas to slash a member over-spender.
- **Bootnode.** Publishes its own v3 onion, collects gateway announces, and serves a *signed*
  directory of live gateways. Signs the directory with the pinned signer key.
- **On-chain registry.** `StakedReputationSet` (members) and `GatewayRegistry` (operators): canonical,
  public, tamper-evident stake + membership state.

**Adversary classes** (each is addressed in §4/§5):

- **A1 — Malicious gateway.** A gateway a member dials. Wants to deanonymize the member, redirect a
  member's proof to a different target, replay/amplify a captured envelope, or forge a receipt.
- **A2 — Malicious / replaying bootnode.** Wants to steer a client to a hostile gateway, inject an
  onion, resurrect a dropped/slashed gateway with an old-but-validly-signed directory, or paste a
  fake `staked` label.
- **A3 — Network observer, member end.** Sees the member's local traffic into Tor. (Out of scope to
  the same degree Tor itself is: a global passive adversary.)
- **A4 — Network observer, gateway end.** Sees the gateway's egress to the public destination.
  Knowing a gateway's own exit is explicitly *not* the threat (`docs/ROADMAP.md` #3).
- **A5 — Over-spending / tier-forging member.** A member that tries to exceed its rate budget, reuse
  a slot, or claim membership it does not hold.
- **A6 — Sybil operator.** An entity that spins up many gateways (and/or many stakes) to raise its
  odds of being the operator a given member rotates onto.

---

## 3. Trust assumptions — what each party is and is NOT trusted for

**The Tor network / v3 onion addressing.**
Trusted for: rendezvous confidentiality and the fact that a v3 `.onion` *is* an ed25519 public key,
so reaching the service at all requires it to hold that key. NOT trusted for: hiding a member's own
exit from the member (it never does; path selection is client-side by design), nor for enumerating
gateways (blinded HSDir descriptors deliberately prevent that — hence the app-layer directory).

**The bootnode.**
Trusted for: *availability* of a fresh fleet view and for the operator↔onion *pairing label* in
stake mode unless the client re-verifies. NOT trusted for: injecting an onion it does not control
(each entry's `pubkey` must equal the key derived from its own `.onion`, `lib/directory.mjs:verifyDirectory`),
nor for authenticity of the list beyond what the pinned signer covers, nor as a trust root. A
hostile bootnode can at worst **omit** a gateway or briefly list one whose stake lapsed — it cannot
**inject** one. "The bootnode is a cache, not a trust root" is the load-bearing sentence here.

**The pinned directory signer (`RGOE_DIR_SIGNER`).**
Trusted for: authenticating *which list* is the fleet. NOT trusted with a default — there is
intentionally **no default signer** (`client/selection.mjs:parsePinnedSigners`); an unpinned
directory is trust-on-first-use, exactly the poisoning surface the signature closes. Even a
compromised signer cannot graft in a hostile onion under a pubkey it does not control, because the
onion↔pubkey binding is checked independently per entry (see §5).

**The on-chain registry / RPC.**
Trusted like any node read. Stake/root reads default to `latest` (dev-chain friendly) and can be
pinned to a confirmation depth for reorg safety (`RGOE_CONFIRMATIONS`,
`lib/gateway-registry.mjs:blockTag`, `lib/root-provider.mjs`). NOT trusted to be reorg-safe at
default settings — that is an operator config. The **onion is never on chain**
(`contracts/GatewayRegistry.sol`): only an operator *address* stakes, so the fleet stays
un-enumerable and one stake can rotate across many onions.

**The admission ceremony.**
Trusted as the Sybil-resistance root (whatever adds a leaf). The RLN proof *gates* membership; it
does not *create* reputation. NOT trusted to provide anonymity of enrollment beyond what the chosen
admission policy inherently leaks (enrollment is publicly timestamped; `docs/ROADMAP.md` #2).

**The gateway operator.**
Trusted for: nothing cryptographic about the member. It sees a member's `host:port` targets
(metadata only, never plaintext) for requests routed to it. NOT trusted to be non-colluding — the
defense against a colluding operator set is RLN's per-slot nullifiers (a colluding set still cannot
rejoin a member's requests) combined with per-request rotation.

---

## 4. Security properties and where they are enforced

Each row cites the enforcing function. "Enforced" means verified present in the shipped source;
"claimed, unverified" flags a designed-but-not-fully-wired path.

### 4.1 Client anonymity to the gateway
The gateway terminates a Tor rendezvous and sees `127.0.0.1` for every request; there is no exit
node and no client IP on the wire. **Enforced** by the transport (onion service dial in the shim /
`client/rgoe-client.mjs`), not by app crypto. Adversary A1/A4.

### 4.2 Membership soundness
A request carries a real RLN Groth16 proof of membership in a `rateCommitment` leaf of the depth-20
tree, checked against the currently-accepted root set. **Enforced** by
`lib/rln.mjs:verifyEnvelope` (check 3 root membership + check 4 Groth16 verify) over
`recentRoots`. A forged set fails the root check; a bad proof fails verification. Adversary A5.

### 4.3 Per-request unlinkability + rate cap (RLN)
The RLN nullifier is a function of the identity, the per-epoch `externalNullifier`, and a **private
`messageId` (slot)**; a member rotates the slot per request, yielding distinct, mutually-unlinkable
nullifiers, capped at `K` per epoch (`K_SLOTS`, default 8). **Enforced** by
`lib/rln.mjs:proveForSlot` (`messageId = i`, range-checked in the circuit) and the top-of-file RLN
semantics comment; the gateway keys its spent-set on the proof's *public-signal* nullifier
(`lib/rln.mjs:verifyEnvelope` returns `nullifier` from `publicSignals`, never the envelope's copy),
so a lying envelope cannot desync accounting. What the gateway learns is a fresh nullifier per slot
and nothing tying two slots to one member. Adversary A1 (incl. colluding set).

### 4.4 Message-to-target binding
A captured proof cannot be redirected to a different destination. The committed public `x` is
`calculateSignalHash(requestSignal(target, nonce))`; the gateway recomputes it from the envelope's
`target`+`nonce` and requires it to equal `ps.x`. **Enforced** by `lib/rln.mjs:verifyEnvelope`
check **2b**, gated by `lib/rln.mjs:signalFieldSafe` (rejects newline/oversize fields that could
make the newline-delimited `requestSignal` non-injective) and failing closed (`unbound-target`) when
`nonce`/`target` are absent. The invariant note in the code is explicit that 2b is only meaningful
*with* check 4 (`ps.x` is attacker-supplied until the Groth16 proof verifies). Adversary A1.
(Tracked history: T-DEV-3, now built.)

### 4.5 Over-spend detection and slashing
Two distinct public `x` values under the *same* nullifier are two points on the degree-1 line, so
the `identitySecret` is Shamir-reconstructed and the leaf is slashed exactly once. **Enforced** by
`gateway/gateway.mjs:makeSpentSet` (`admit` → the "distinct public x under the same nullifier"
branch → `reconstruct`/`derive`/`slash`), `lib/rln.mjs:reconstructSecret` +
`lib/rln.mjs:deriveCommitment`, and on chain `contracts/StakedReputationSet.sol:slash`
(**permissionless** — the secret is a cryptographic proof of over-spend; `slash` re-derives
`commitmentOf(secret)` and reverts `BadSecret` on mismatch). Adversary A5.

### 4.6 Per-gateway replay defense
An exact-envelope resend to the *same* gateway is idempotent within a short window (honest
dropped-connection retry) and rejected after it. **Enforced** by `gateway/gateway.mjs:makeSpentSet`:
the `seenEnv` fingerprint `nullifier|share.x|nonce` plus `replayWindowMs` (default 5s) →
`replay` (accept) vs `replayed-envelope` (drop). **Scope limit:** this is per-process, per-gateway
only; there is no shared spent-set across non-colluding gateways (residual T-FEAT-20, §5). Adversary
A1.

### 4.7 Directory authenticity, signer pinning, rotation allowlist
The whole list is ed25519-signed by a pinned signer, and the pinned argument is an **allowlist**
(single key, or an overlap set for rotation). **Enforced** by `lib/directory.mjs:verifyDirectory`
(+ `normalizePinnedSigners`): the signature must verify under *some* pinned key AND the declared
`dir.signer`, when present, must itself be pinned — this is an allowlist, not "trust any signer"; an
unpinned or wrong signer is rejected (`signer-not-pinned` / `bad-signature`). Rotation without a
flag day: `RGOE_DIR_SIGNER` accepts a comma-separated `{old,new}` overlap set
(`client/selection.mjs:parsePinnedSigners`; T-HARD-5, built). Adversary A2.

### 4.8 Onion↔key self-authentication (poisoned-directory defense)
Each directory/announce entry's `pubkey` must equal the ed25519 key encoded in its own v3 `.onion`
address; a v3 address *is* that key, so a grafted or swapped onion cannot claim a pubkey it does not
control. **Enforced** by `lib/directory.mjs:onionToPubkey` (checksum-validated recovery) inside
`verifyDirectory` (per-entry `pubkey-onion-mismatch` / `bad-onion` rejection), and at announce time
by `bootnode/announce.mjs:verifyAnnounce` (`onionSig` verified via
`lib/directory.mjs:verifyOnionControl` over `canonicalAnnounceBytes`, freshness-bounded by `ts`/skew
and optional `seenNonce`). The onion is never on chain (`contracts/GatewayRegistry.sol`). Adversary
A1/A2.

*Note (claimed, unverified):* `lib/directory.mjs:verifyOnionControl` also exists as a **live per-dial
challenge**, but the code comment says to "wire the challenge/response into the gateway envelope
handshake" — the shipped per-dial handshake was not confirmed to call it. Connection-time onion
control is instead provided by Tor itself (you cannot reach a v3 onion without the service holding
its key); the announce signature provides it at directory-build time.

### 4.9 Directory rollback / stale-replay defense
An ed25519 directory signature is valid forever, so a hostile/replaying bootnode could serve an
*old* validly-signed directory to resurrect a dropped or slashed gateway, and stateless
`verifyDirectory` would accept it clean. Two guards close this in `client/selection.mjs:ensureLoaded`:

- **Monotonic issued floor** (`lastAcceptedIssued`): a *fresh* directory whose `issued` predates the
  newest already accepted is rejected (`directory rollback rejected`); the last-known-good cache is
  exempt but still raises the floor. Stops *in-session* rollback.
- **Absolute max-age bound** (`RGOE_DIRECTORY_MAX_AGE_MS` + skew grace): a *fresh* directory older
  than the bound is rejected (`directory too stale`). **OFF by default** (T-FEAT-21), so a cold-start
  client with no prior state has *no* staleness bound unless configured — see §5. Both fail closed to
  the last-good in-memory fleet / cache. Adversary A2.

### 4.10 Client-side weight clamp (traffic-concentration defense)
Selection weight is gateway-attested, so a poisoned static directory or compromised signer could
try to concentrate a member's traffic on one gateway (a deanonymization lever). **Enforced** on the
client by `lib/directory.mjs:clampWeight` (`MAX_WEIGHT = 1000`, negatives floored, NaN → 1),
independent of the bootnode's own announce-time clamp (`bootnode/server.mjs` `MAX_WEIGHT`). Adversary
A1/A2/A6.

### 4.11 Operator↔onion binding + live stake (stake mode)
In `admission=stake`, an announce carries a durable operator ECDSA authorization binding
operator↔onion plus a live on-chain stake check. **Enforced** by
`bootnode/announce.mjs:verifyAnnounce` (`verifyOperatorSig` recovers the operator from
`operatorAuthMessage` and confirms it equals `operator`; `isStaked` gated by `requireStake`, with a
chain-read failure hard-rejecting rather than silently passing) against
`contracts/GatewayRegistry.sol:isStaked` via `lib/gateway-registry.mjs:makeStakeVerifier`. Revocation
= unstaking (`isStaked` flips false, entry drops next refresh). Adversary A2/A6.

### 4.12 Client zero-trust operator re-verification
The signed directory carries a bootnode `staked`/`operator` label the client cannot check from the
entry alone. With `RGOE_VERIFY_STAKE=1` the client refuses to take the label on faith: for every
entry claiming stake it fetches `GET /gateway/<onion>` and re-runs the same two proofs
(`verifyAnnounce` sigs + live `isStaked`), dropping any that fail. **Enforced** by
`client/selection.mjs:reverifyGateway` / `filterReverified` (T-DEV-5). **OFF by default**, so the
default path still trusts the bootnode's pairing label — flagged as a residual in `SECURITY.md`.
Adversary A2.

### 4.13 Receipt privacy (no linkability channel)
A gateway's signed egress-success receipt is a per-*gateway* liveness attestation carrying **zero**
request-linkable data: only a schema version, the gateway's own `.onion` (self-authenticating via
`onionToPubkey`), a **coarse epoch bucket**, and a constant `ok:true`. **Enforced** by
`lib/receipt.mjs:canonicalReceiptBytes` / `buildReceipt` / `verifyReceipt`, with a receipt-only
domain tag (`RECEIPT_DOMAIN`) providing domain separation so a receipt signature can never be
confused with an announce/directory signature by the same onion key. Deliberately absent: member
identity, nullifier (or any prefix), share, target `host:port`, request nonce, fine timestamp, or a
counter. Consequence stated honestly in-code: two receipts from one gateway in one epoch are
byte-identical, so a receipt proves gateway liveness, not that *your* request egressed — the missing
per-request binding is exactly the linkability channel refused. The client-side tally that consumes
receipts is local-only, off by default, never transmitted
(`client/selection.mjs:reportReceipt`, `RGOE_RECEIPT_SCORING`). Adversary A1.

### 4.14 On-chain stake / root reorg-safety
Stake and root reads can be pinned to a confirmation depth so a reorg cannot flip an admission
decision under the gateway. **Enforced** by `lib/gateway-registry.mjs:blockTag` (reads at
`head - RGOE_CONFIRMATIONS`, or `finalized`) and `lib/root-provider.mjs` (confirmation-depth
`eth_getLogs` up to `head - N` / `finalized`). **Default is `latest`** (dev-chain friendly), so
reorg safety is opt-in via `RGOE_CONFIRMATIONS` — an honest default-config caveat, not a guarantee.
Adversary A2.

### 4.15 Version-negotiation downgrade resistance
The gateway declares an inclusive envelope-version range and checks the incoming `v` **before any
field is read**, so a garbage or out-of-range version never reaches `verifyEnvelope`. **Enforced** by
`gateway/gateway.mjs:acceptEnvelopeVersion` (sole version authority; `bad-version` for
non-integers, `unsupported-version` for out-of-range; absent `v` == legacy v3). The advertised range
rides back on rejection so a client can re-select. **Limit:** capability advertisement is *not yet
signed* into the directory/announce (T-FEAT-10 deferred), so a MITM could rewrite the advertised
range — but this does **not** weaken the membership proof: version choice cannot forge §4.2/§4.3.
Adversary A1.

---

## 5. Known residual risks and out-of-scope

These are documented limitations, not new findings. Cross-referenced to `docs/SHIP-PLAN.md`,
`docs/ROADMAP.md`, and `SECURITY.md`.

**Residual (tracked, will change the security surface when built):**

- **Cross-fleet replay / rate is not fleet-wide (T-FEAT-20, ROADMAP #1/#3).** §4.6 defends *one*
  gateway. Non-colluding gateways share no spent-set, so a malicious gateway can fan a captured
  envelope to peers (each accepts it once), and a member spreading requests across `N` gateways gets
  up to `N`× its intended budget. The fix (a gossiped per-epoch nullifier tally) must be paired with
  RLN's per-request nullifiers so the shared tally is not itself a linkability channel.
- **Exit-auth verifier is a mock (T-DEV-1, P0).** `StakedReputationSet.initiateExit`/`withdraw` use
  `MockWithdrawVerifier`, so the ZK authorization of a member exit/withdraw is not real yet. A real
  Groth16 verifier is required before withdrawals are genuinely proof-gated.
- **RLN leaf-removal parity (T-DEV-2, P0).** `reconstructRoot` rebuilds a fresh tree of survivors
  (renumbering indices); an on-chain slash that zeroes a leaf in place would diverge. JS and contract
  removal semantics must be made to agree before on-chain slashing is trustworthy end-to-end.
- **Trusted-setup provenance (T-HARD-1, P0).** The ZK artifacts came from an **untrusted testnet
  phase-2 ceremony** (`circuits/rln/ARTIFACTS.md`). No real anonymity or funds until a real ceremony
  or pinned audited artifacts (with CI hash verification) land. This is the single biggest caveat.
- **Cold-start directory staleness (T-FEAT-21).** The rollback floor (§4.9) only bounds staleness
  *within* a session; the absolute max-age bound is **off by default**, so a brand-new client can
  accept a validly-signed but months-old directory from a replaying bootnode. Set
  `RGOE_DIRECTORY_MAX_AGE_MS` to close it.
- **Stale `staked` label by default (T-DEV-5).** Client zero-trust operator re-verification (§4.12)
  exists but is **off by default**; the default path trusts the bootnode's operator↔onion pairing
  label.
- **Reorg safety off by default (§4.14).** `latest` reads unless `RGOE_CONFIRMATIONS` is set.
- **Unsigned capability/version advertisement (T-FEAT-10, §4.15).**
- **Deploy bootstrap not integration-tested.** `bootnode/deploy/bootstrap.sh` runs as root on a
  fresh box with no integration test; read it before running it (`docs/AUDIT.md`, `SECURITY.md`).

**Explicitly out of scope (design boundaries, not bugs):**

- **Global passive network adversary (A3).** Same posture as Tor itself; not defended here.
- **Knowing your own exit.** A member knowing which gateway it egresses through is not the threat
  (`docs/ROADMAP.md` #3); multi-hop gateways are deliberately not the plan.
- **Payments, sourcing clean egress IPs, rendezvous/onion DoS.** Operator responsibilities / out of
  scope per the README "Scope" section and `SECURITY.md`.
- **Sybil operators inflating rotation odds (A6).** Rotation spreads a member across the live fleet;
  a Sybil that runs many gateways raises its share of any one member's traffic. Staking
  (`admission=stake`) raises the cost but does not eliminate it; the anonymity argument rests on
  RLN's per-slot unlinkability (§4.3) holding even against a *colluding* set, not on any single
  operator being honest.

---

## 6. Audit checklist — where to start

Highest-value review targets, roughly in order of trust concentration:

1. **`lib/directory.mjs`** — the trust core. Confirm `verifyDirectory` rejects: unsigned, wrong
   signer, non-pinned declared signer, tampered field, grafted onion, pubkey↔onion mismatch. Confirm
   `onionToPubkey` checksum validation and `clampWeight`. Read alongside `lib/directory.selftest.mjs`.
2. **`lib/rln.mjs:verifyEnvelope`** — walk checks 1→4 in order and confirm 2b (target binding) is
   never trusted without 4 (Groth16 verify), and that `nullifier`/`share` come from `publicSignals`,
   not the envelope. Confirm `signalFieldSafe` runs before hashing. Beside `lib/rln.selftest.mjs`.
3. **`gateway/gateway.mjs:makeSpentSet`** — the over-spend/slash and replay control flow. Confirm
   slash-exactly-once, the `seenEnv` replay window, and that failures don't crash the path. Confirm
   `acceptEnvelopeVersion` is the sole version gate.
4. **`bootnode/announce.mjs:verifyAnnounce`** — the discovery loop's admission. Confirm onion-sig +
   operator-sig + `isStaked` ordering, freshness/skew, nonce replay, and that a chain-read failure
   hard-rejects under `requireStake`. Beside `bootnode/selftest.mjs`.
5. **`client/selection.mjs:ensureLoaded`** — the rollback floor + max-age bound + last-known-good
   fallback; and `reverifyGateway`/`filterReverified` for the zero-trust stake path.
6. **`contracts/StakedReputationSet.sol` + `contracts/GatewayRegistry.sol`** — stake lifecycle, the
   permissionless member `slash` vs the governed gateway `slash`, fund custody, the mock exit
   verifier (T-DEV-1). Beside `test/*.t.sol` and `docs/CONTRACTS-AUDIT.md`.

For the full attack matrix run against live code, see `test/adversarial.selftest.mjs`. For the
per-component trust boundaries and suggested reading order, see `docs/AUDIT.md`.
