# Incident response

Operational playbook for the seven failure modes that matter. Each entry: symptoms, immediate
containment, root-cause investigation, recovery, prevention. Read `docs/AUDIT.md` first for the
trust model these procedures rely on. Where a step is not yet tooled it says so and points at the
`docs/SHIP-PLAN.md` task.

The single fact that shapes every response: **the bootnode and its signer authenticate a list, they
are not a trust root.** Clients re-derive each onion's ed25519 key from its own `.onion` address
(`lib/directory.mjs` `onionToPubkey`) and, in stake mode, can re-check the operator on chain. So the
worst a compromised bootnode or signer can do is OMIT or reorder gateways, never INJECT an onion it
does not control. Keep that boundary in mind before escalating.

---

## 1. Bootnode down / unreachable

**Symptoms.** `GET /directory` over Tor times out or refuses. Clients log a fresh-fetch failure and
fall back; `loadDirectory` returns `{ source: "cache" }` instead of `"fresh"`. `/health` unreachable.

**Why the fleet keeps working.** Clients cache the last-known-good directory
(`RGOE_DIRECTORY_CACHE`, default `cache/bootnode-directory.lkg`). `loadDirectory` re-verifies the
cached copy against the same pinned signer and serves it when the fresh fetch fails or is absent.
Gateways egress independently of the bootnode: they announce TO it, they do not route THROUGH it. A
member holding a valid directory (fresh or cached) keeps selecting and dialing gateways with no
bootnode in the path. A dead bootnode degrades to the previous good fleet, never to nothing.

**Immediate containment.** None required for existing clients. New clients with no cache and no
static `RGOE_DIRECTORY` fallback cannot bootstrap discovery until the bootnode returns; point them at
a static signed directory file (`RGOE_DIRECTORY` + `RGOE_DIR_SIGNER`) as a stopgap if one is
published.

**Root-cause investigation.** Check the box: process alive, `RGOE_BOOTNODE_PORT` bound on
`127.0.0.1`, Tor HS descriptor published for the bootnode onion, `node scripts/doctor.mjs` for
env/tor/deps. Confirm gateways can reach `POST /announce` (a network partition looks like a dead
bootnode from the client side only).

**Recovery.** Restart `bootnode/server.mjs`. Note: the registry is in-memory, so a restart drops the
whole fleet until every gateway re-announces on its next heartbeat (up to `RGOE_BOOTNODE_HEARTBEAT`,
default 300s). Persistence across restarts is **not yet built** (SHIP-PLAN T-DEV-4); until it lands,
expect a re-announce settling window after every bootnode restart. The signer key persists on disk
(`RGOE_BOOTNODE_SIGNER_KEY`), so the pinned signer is unchanged and clients accept the rebuilt
directory with no re-pin.

**Prevention.** Run redundant bootnodes (each its own onion + signer, clients pin one). Keep the LKG
cache path writable so degradation actually works. Publish a static signed directory as a cold
fallback. Automated bootnode failover is **not tooled**; failover today is a manual client re-point.

---

## 2. Bootnode signer key compromised

**Symptoms.** A directory signed by the pinned signer lists gateways you did not authorize, drops
known-good ones, or reorders/reweights to concentrate traffic. Signature verifies (that is the
problem), so `verifyDirectory` returns `ok` on a list you distrust.

**What the attacker CAN do.** Sign a poisoned list: omit honest gateways, reorder, inflate a
weight (capped at `MAX_WEIGHT=1000` on the bootnode, but a raw signed file bypasses that clamp),
or list an onion whose stake has lapsed.

**What the attacker CANNOT do.** Inject a gateway it controls under an onion it does not hold the
key for. Every entry's `pubkey` must equal the key derived from its own `.onion` address, and the
client re-derives it (`verifyDirectory` enforces `pubkey-onion-mismatch`). A grafted onion fails the
client's own check. In stake mode the client can additionally re-check `isStaked(operator)` on chain.
So a stolen signer degrades to OMIT / reorder / stale-stake, not to a controlled malicious exit.

**Immediate containment.** Treat the signer as burned. Weight concentration is the real lever (it
narrows which gateway a member is likely to hit), so if the poisoned list is skewing selection,
push clients back onto a trusted static directory (`RGOE_DIRECTORY` + the OLD-but-trusted signer) or
a redundant bootnode with a different signer while you rotate.

**Root-cause investigation.** Compare the live `/directory` against a known-good snapshot: which
onions were dropped, added, reweighted. Every added onion is by definition one whose key the attacker
holds OR a public honest gateway (the binding guarantees no third option). Audit the box holding
`RGOE_BOOTNODE_SIGNER_KEY` for exfiltration.

**Recovery.** Rotate the pinned signer. **This is manual: versioned signer rotation with an overlap
window is NOT built (SHIP-PLAN T-HARD-5).** Today rotation means: mint a new signer, re-sign the
directory (bootnode does this automatically on next boot with the new key file), and **redistribute
the new `RGOE_DIR_SIGNER` to every client out of band.** There is no overlap window, so this is a
flag day: clients on the old pin reject the new directory (`signer-not-pinned` / `bad-signature`) and
fall back to their LKG cache until re-pinned. Plan the cutover accordingly.

**Revoke.** Once clients are re-pinned to the new signer, the old signer's directories are inert (no
client trusts them). No on-chain revocation exists or is needed; the pin IS the trust anchor.

**Prevention.** Keep the signer key off the network-facing surface, minimal blast radius. Ship
T-HARD-5 so rotation stops being a flag day. Keep static-directory fallback ready so containment does
not depend on the compromised bootnode.

---

## 3. Gateway compromised / malicious

**Symptoms.** A member reports a target it did not request, traffic amplification on one proof,
selective dropping, or you have out-of-band evidence an operator is misbehaving (censoring,
tampering, downtime).

**What a malicious gateway CAN do.**
- See the `host:port` targets (`:443` only, metadata) of requests routed to it. It never sees
  plaintext (TLS is end-to-end client-to-target).
- Drop, delay, or selectively censor requests routed to it.
- Replay an exact envelope to the SAME target and amplify the member's apparent traffic on one
  proof. Cross-gateway replay defense is **NOT built (SHIP-PLAN T-FEAT-12)**: there is no shared
  spent-set across non-colluding gateways and no per-epoch seen-nonce cache yet, so this replay
  succeeds today.

**What a malicious gateway CANNOT do.**
- Forge membership. A valid RLN Groth16 proof against a recent admission root is required; it cannot
  mint one.
- Redirect a captured proof to a DIFFERENT target. The proof's committed `x` is bound to
  `requestSignal(target, nonce)` and the gateway recomputes it (`verifyEnvelope`, T-DEV-3 DONE); a
  swapped target or nonce is rejected `target-not-bound` / `bad-signal-field`.
- De-anonymize the client. Onion rendezvous, no exit node; the gateway sees `127.0.0.1` for every
  request.

**Immediate containment.** Remove it from the fleet. There is no deregister endpoint by design; the
mechanism is TTL drop:
- If you control the operator: **stop its heartbeat.** The entry ages out after
  `RGOE_BOOTNODE_TTL` (default 900s) with no one deregistering it.
- If you do not: the bootnode cannot forcibly evict a still-announcing onion, but in stake mode you
  can cut its stake (see Recovery) so `isStaked` flips false and it drops on the next refresh.
Clients also route around a bad gateway locally: `reportHealth` marks it `down` after 2 failures and
`pickGateway` skips it, and `selectionOrder` fails over to the rest of the fleet on dial timeout.

**Root-cause investigation.** Pull the offending gateway's logs (`DROP` / `PASS` / `ERROR` lines,
`egress->` targets). Confirm the misbehavior class: redirect (should be impossible, `target-not-bound`
would have fired), replay/amplification (T-FEAT-12, expected until built), or censorship/downtime.
Identify the operator address from its announce (`GET /gateway/<onion>` returns the stored signed
announce with `operator` + `operatorSig`).

**Recovery.** Gateway slashing is **governed, not permissionless** by design: gateway misbehavior is
a subjective judgment. The owner calls `GatewayRegistry.slash(operator, receiver)`. It works whether
the operator is active or mid-unbonding (the unbonding window keeps it slashable, closing the
exit-to-dodge escape). This is a deliberate asymmetry vs the member slash, which is a cryptographic
proof and therefore permissionless.

**Prevention.** Per-request rotation across N non-colluding gateways spreads target metadata to
~1/N; RLN's fresh per-request nullifiers stop even colluding gateways from rejoining a member's
requests. Require `admission=stake` so misbehavior has a bond behind it. Ship T-FEAT-12 to close the
replay/amplification gap.

---

## 4. Onion identity SEED leak

**Symptoms.** Two gateways answering for the same `.onion`, an announce you did not send verifying
under your onion key, or direct evidence the 32-byte seed (`tor/hs/identity.local.json`, or Tor's
`hs_ed25519_secret_key`) leaked.

**What it means.** The seed IS the onion. Whoever holds it can publish the HS descriptor and sign
announces indistinguishably from the legitimate gateway (`onionSig` verifies against the address).
The onion is impersonable. Onion control is no longer yours.

**Immediate containment.** Stop trusting that onion. Stop its heartbeat so the honest entry ages out
(`RGOE_BOOTNODE_TTL`). Understand that stopping YOUR heartbeat does not stop the attacker's: they can
keep announcing the stolen onion, and the binding check passes for them because they hold the key.
The only real fix is to retire the onion.

**Root-cause investigation.** Audit the box holding the seed and identity file. Determine exposure
window. Any request routed to the impersonator during the window had its target metadata exposed to
the attacker (never plaintext, TLS stays end-to-end).

**Recovery.**
1. Retire the leaked onion. Consider it permanently burned; never reuse the seed.
2. Mint a new identity: `rgoe keygen <hsDir>` writes fresh Tor HS key files + a new
   `identity.local.json` seed.
3. Re-announce under the new onion (heartbeat with the new `RGOE_GW_IDENTITY`). Clients pick it up on
   the next directory refresh.
4. **On-chain operator stake is separate and survives.** The `GatewayRegistry` stakes an operator
   ADDRESS, never an onion; one stake rotates across many onions. Re-sign the durable operator
   authorization for the NEW onion (`operatorAuthMessage(newOnion, operator)`,
   `RGOE_GW_OPERATOR_KEY`) and the same bond backs the new identity. No re-stake, no new bond.

**Prevention.** Guard the seed like any signing key. It is the one secret whose leak cannot be
contained by the trust model, only by retiring the identity. Rotate onions periodically so a silent
leak has a bounded lifetime.

---

## 5. Chain / RPC outage

**Symptoms.** `eth_call` / `eth_getLogs` failing. Stake checks and root refreshes error in logs.
Applies only to on-chain profiles (`RGOE_GROUP_CONTRACT` / `RGOE_STAKE_MODE=onchain` set); the
`members.json` PoC path is unaffected.

**Stake reads (bootnode admission=stake).** `verifyAnnounce` **fails closed**: if the chain read
throws under `requireStake`, the announce is rejected `stake-check-failed:<msg>`, not passed. A chain
outage therefore blocks NEW/renewing stake-mode announces rather than admitting unverified gateways.
Already-resident entries keep serving until their TTL, then age out (they cannot renew without a
successful stake check). Result: the fleet shrinks safely toward whatever was already admitted, never
admits an unverified operator. The 15s `isStaked` cache (`RGOE_STAKE_CACHE_MS`) briefly masks a very
short blip.

**Root reads (gateway).** `lib/root-provider.mjs` `withCache` serves the last-known-good roots with a
`{ stale: true, error }` flag when a fresh fetch throws; `onChange` polling keeps the last-known-good
rather than crashing the gate. So the gateway keeps verifying member proofs against the last roots it
successfully read. A membership change during the outage is simply not seen until RPC returns (a
just-added member may be rejected; a just-removed member may still pass, bounded by the freshness
window).

**Gateway slashing.** Deferred, not lost. Without a reachable RPC (or without `RGOE_SLASH_KEY`) the
slasher logs a `SLASH (dry-run)` and the over-spend evidence is still detected locally; the on-chain
`slash()` tx is what is delayed. Re-submit once RPC returns.

**Immediate containment.** None forced. Confirm the outage is RPC, not consensus. Fail-closed stake +
last-known-good roots mean the system degrades safely on its own.

**Root-cause investigation.** Is `RGOE_RPC_URL` reachable? Provider down, rate-limited, or
partitioned? Check whether roots are being served stale (log shows `stale`/`error`).

**Recovery.** Restore RPC (prefer your own node for the solo-staker path). Stake-mode announces
resume admitting on the next successful check; root refresh catches up on the next poll; re-submit any
deferred slashes.

**Prevention.** Run your own RPC endpoint. Set `RGOE_CONFIRMATIONS` for reorg safety on a public
chain (stake reads default to `latest`, roots to `finalized`). Size the freshness window
(`RGOE_FRESHNESS_ROOTS`) so a brief outage does not strand recent members.

---

## 6. Mass-DROP spike (members failing the gate)

**Symptoms.** A surge of `DROP` lines in gateway logs, valid members reporting failures, egress rate
collapsing. The reason string on the `DROP` line is the diagnostic.

**Most likely cause: a root mismatch.** The proof's public root is not in the gateway's
`recentRoots`, so `verifyEnvelope` drops it. Candidates, in order:
- **`members.json` vs on-chain root divergence.** Client building proofs against one root source
  while the gateway reads another (`RGOE_GROUP_CONTRACT` set on one side only, or pointed at a
  different contract).
- **Epoch skew.** `verifyEnvelope` accepts only the current/previous epoch's external nullifier. A
  clock skew larger than one epoch between client and gateway drops otherwise-valid proofs. Look for
  the epoch-window reason on the DROP line.
- **`RGOE_EPOCH_SECONDS` mismatch** across sides (default 120). Different epoch lengths desynchronize
  the external nullifier immediately. Must match client and gateway.
- **`RGOE_SLOTS` / `RGOE_RLN_IDENTIFIER` mismatch.** Different rate cap or RLN identifier changes the
  external nullifier / circuit binding.
- **Freshness window too tight.** A membership change advanced the root and clients are still proving
  against a root that fell out of `RGOE_FRESHNESS_ROOTS`.

**Immediate containment.** Do not slash: these are gate rejections, not over-spends (no secret is
reconstructed on a DROP). Identify the dominant DROP reason from logs first.

**Root-cause investigation.** Read the DROP reasons on the gateway (`DROP <reason> target=`). Compare
the gateway's live `recentRoots` against the root clients are proving against. Check both sides'
`RGOE_EPOCH_SECONDS`, `RGOE_SLOTS`, `RGOE_RLN_IDENTIFIER`, and root source
(`RGOE_GROUP_CONTRACT` vs `members.json`). Confirm clocks. If on-chain, confirm the root provider is
not serving `stale` roots from a chain outage (see #5).

**Recovery.** Align the mismatched parameter across client and gateway, or widen
`RGOE_FRESHNESS_ROOTS` if the cause is a too-tight window during a membership change. No key rotation
or slashing involved.

**Prevention.** Pin `RGOE_EPOCH_SECONDS`, `RGOE_SLOTS`, `RGOE_RLN_IDENTIFIER`, and the root source
identically across every component (they are called out as must-match in `docs/CONFIG.md`). NTP-sync
gateway clocks.

---

## 7. Suspected over-spend / unexpected slashes

**Symptoms.** `SLASH` lines in gateway logs, a member reporting an unexpected on-chain slash, or a
bond drained you did not expect.

**What a legitimate slash requires.** A member over-spend is a cryptographic fact, not a judgment:
the gateway's spent-set (`gateway/gateway.mjs` `makeSpentSet`) sees TWO DISTINCT signals (distinct
public `x`) under the SAME `nullifier`. That is the L+1-th RLN evaluation point, which reconstructs
the identity secret (Shamir) and derives the rate-commitment leaf. An IDENTICAL replay (same
`share.x`) is deduped and is NEVER slashed. So a slash means two genuinely different points were
presented on one per-slot nullifier: the member exceeded its `RGOE_SLOTS` rate cap within the epoch.

**Immediate containment.** Do not assume malice. First verify the slash was legitimate before
treating it as an incident.

**Root-cause investigation.**
1. Confirm the reconstruction was real: two DISTINCT `x` values on ONE nullifier, not a mishandled
   replay. The code slashes exactly once per nullifier and dedups identical `x`; a slash on identical
   `x` would be a bug, investigate the spent-set.
2. Verify the on-chain slash tx: find the `SLASH tx <hash>` log line, confirm it mined, confirm the
   `commitment` matches the reconstructed leaf and the `receiver` is the intended address
   (`RGOE_SLASH_RECEIVER`, else the slasher wallet).
3. If the member insists it did not over-spend: check for a client bug re-using a nullifier across
   requests, or a `RGOE_SLOTS` mismatch causing the client to think it had more slots than the
   gateway enforces.
4. Rule out cross-gateway amplification: T-FEAT-12 (unbuilt) means an EXACT-envelope replay to the
   same target does not itself slash (identical `x` is deduped), but confirm no path produced two
   distinct signals illegitimately.

**Recovery.** A legitimate slash is final and correct; no recovery, the rate cap worked. If
investigation shows an illegitimate slash (a bug reconstructing on identical or mishandled shares),
that is a code defect: freeze slashing (`RGOE_SLASH_KEY` unset falls back to dry-run so evidence is
still logged without draining bonds) and fix the spent-set before re-enabling on-chain submission.

**Prevention.** Keep `RGOE_SLOTS` and `RGOE_EPOCH_SECONDS` identical across client and gateway so a
member's own rate accounting matches what the gateway enforces. Run the slasher in dry-run
(`RGOE_SLASH_KEY` unset) while validating a new deployment so a spent-set bug logs instead of slashes.

---

## Not yet tooled (honest gaps)

- **Directory signer rotation** (#2): manual re-pin + out-of-band redistribution, flag day, no
  overlap window. SHIP-PLAN T-HARD-5.
- **Automated bootnode failover** (#1): clients auto-degrade to the LKG cache, but restoring or
  re-pointing to a healthy bootnode is manual.
- **Bootnode persistence across restart** (#1): a restart drops the in-memory fleet until every
  gateway re-announces. SHIP-PLAN T-DEV-4.
- **Cross-gateway replay / amplification defense** (#3, #7): no shared spent-set or per-epoch nonce
  cache across non-colluding gateways yet. SHIP-PLAN T-FEAT-12.
- **Client zero-trust operator re-verification** (#3): in stake mode the client trusts the bootnode's
  `staked` label unless it manually fetches `GET /gateway/<onion>` and re-verifies. SHIP-PLAN T-DEV-5.
</content>
</invoke>
