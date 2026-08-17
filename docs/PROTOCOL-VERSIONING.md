# Protocol / envelope version negotiation (T-FEAT-11)

The wire envelope the client sends to a gateway is **v3-with-nonce** today. This document
describes how client and gateway negotiate an envelope version so the format can evolve to
**v4+ without a flag day**, and how an unknown/garbage version is rejected with a precise reason
instead of a silent mis-parse.

Scope of this task: the **client ↔ gateway handshake only**. Advertising the range in the signed
announce / directory is a deliberate **follow-up** (it belongs with T-FEAT-10 gateway capability
advertisement) and touches `bootnode/*` + `lib/directory.mjs`, which this task does not.

A second, independent negotiation axis — WHICH ZK ARTIFACT SET a proof was made with — is
described at the end (T-HARD-8), so a ceremony's artifact swap runs as a dual-VK window.

## Single source of truth per side

Each side declares the inclusive range of envelope versions it can emit/parse in ONE place:

| Side    | File                      | Constants                                        |
| ------- | ------------------------- | ------------------------------------------------ |
| Gateway | `gateway/gateway.mjs`     | `PROTO_MIN=3`, `PROTO_MAX=3`, `PROTO_RANGE`       |
| Client  | `client/rgoe-client.mjs`  | `CLIENT_PROTO_MIN=3`, `CLIENT_PROTO_MAX=3`, `CLIENT_PROTO_RANGE` |

Today both ranges are exactly `{3}`.

- **Ship a new format:** add a v4 parser and bump `PROTO_MAX` (gateway) / teach `buildEnvelope`
  the new shape and bump `CLIENT_PROTO_MAX` (client).
- **Drop an old format:** raise `PROTO_MIN` / `CLIENT_PROTO_MIN`. A peer stuck on the dropped
  version is then cleanly rejected, never mis-parsed.

## Selection — client picks the highest mutually supported version

`selectProtoVersion(gatewayRange, clientRange = CLIENT_PROTO_RANGE)` in `client/rgoe-client.mjs`:

- **Gateway range unknown (`null`)** — the common case today: `RgoeClient` starts with no
  gateway range unless the caller passes one, so the client optimistically emits **its own
  max**. A genuine mismatch then surfaces as an explicit reject (below) carrying the gateway's
  real range, which the client records on `this.gatewayRange` for the next attempt. A gateway
  that advertises signed capabilities (T-FEAT-10/10b, `bootnode/heartbeat.mjs`) also carries
  its `caps.proto = {min,max}` in the directory entry, and capability-aware selection
  (`client/selection.mjs` `gatewayMeetsRequirement`, `req.proto`) can filter on it before dialing.
- **Ranges overlap:** returns `min(clientMax, gatewayMax)` — the **highest** both sides accept.
- **Ranges disjoint:** returns `{ ok:false, reason:"no-mutual-version:client=<lo>-<hi>,gateway=<lo>-<hi>" }`.
  The client **fails closed** (throws `version negotiation failed: …`) before proving or dialing.

`buildEnvelope({ …, version })` stamps the selected version as the envelope's **first** field
(`{ v, target, nonce, … }`), so the gateway reads `v` without parsing the rest. Default
`version = CLIENT_PROTO_MAX` (3), so today's wire bytes are unchanged.

## Gateway version gate — reject before mis-parse

`acceptEnvelopeVersion(v, range = PROTO_RANGE)` in `gateway/gateway.mjs` runs **first** in the
request handler (step 0, before `verifyEnvelope`), reading only `env.v`:

| Input `v`                         | Result                                                        |
| --------------------------------- | ------------------------------------------------------------- |
| absent (`undefined` / `null`)     | treated as **v3** (legacy wire), then range-checked           |
| integer in `[PROTO_MIN,PROTO_MAX]`| `{ ok:true, version }`                                         |
| integer out of range              | `{ ok:false, reason:"unsupported-version:<v>", proto }`        |
| non-integer / garbage             | `{ ok:false, reason:"bad-version:<repr>", proto }`             |

Both rejections carry `proto` = the gateway's `{min,max}` range, which the handler writes back in
the error reply `{ ok:false, err:<reason>, proto }`. That is how the gateway **advertises** its
range in the handshake (at the moment negotiation actually matters — a mismatch). The client's
`connect()` records `ack.proto` and rethrows a precise error naming the gateway's range and
whether a compatible version exists. The drop metric uses the bounded `label`
(`bad-version` / `unsupported-version`), never the value-bearing `reason`.

## Reason strings

| Reason                              | Meaning                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `unsupported-version:<v>`           | well-formed integer version outside the gateway's range          |
| `bad-version:<repr>`                | `v` is not an integer (string, float, `NaN`, object, …)          |
| `no-mutual-version:client=…,gateway=…` | client-side: the two ranges do not overlap (fail closed)      |
| `version negotiation failed: …`     | client-side throw wrapping `no-mutual-version`                    |

The two gateway reasons are deliberately **distinct** so a garbage encoding is never confused
with a merely-unsupported-but-valid version.

## Backward compatibility (mandatory, proven)

- An envelope with **no `v`** is treated as v3 and accepted while the range includes 3, so an
  older client / the pre-negotiation shim keeps working unchanged.
- `buildEnvelope`'s default still emits `v:3` — byte-shape identical to the previous wire
  (`gateway/shim.selftest.mjs` still asserts `envelope.v === 3`).
- Proven in `gateway/version-negotiation.selftest.mjs`: `acceptEnvelopeVersion(undefined) → v3`,
  the default `buildEnvelope` envelope is accepted, and today's `{3}/{3}` selection returns 3.

## Downgrade cannot strip target binding

The version gate decides the version **only** — its result exposes no target/binding fields. An
accepted version still flows through `verifyEnvelope`'s independent target-binding checks
(`lib/rln.mjs`, checks 2b + 4: the committed `x` must equal `calculateSignalHash(requestSignal(
target, nonce))`, and the proof must verify). `verifyEnvelope` never inspects `v`, so **no**
version value — including a downgrade to an accepted one — can bypass binding. The selftest
proves both halves: `verifyEnvelope` returns an unrelated reason for any `v`, and an envelope
with a valid accepted `v` but a missing nonce is still rejected `unbound-target`.

## Tests

`node gateway/version-negotiation.selftest.mjs` — drives `acceptEnvelopeVersion`,
`selectProtoVersion`, `buildEnvelope`, and the real `verifyEnvelope` with injected inputs (no
sockets/Tor/proof): range constants, accept/reject branches, distinct reasons, backward-compat,
gate-is-sole-authority, downgrade-safety, highest-mutual selection, disjoint fail-closed, and a
round-trip grid where every selected version is one the gateway then accepts.

## Artifact-version negotiation (T-HARD-8) — the SECOND axis

Envelope version (above) says how the envelope is SHAPED. Independently, the proof inside it was
made with one ZK **artifact set** (wasm + zkey + vkey from one phase-2 output), and the gateway can
only verify it under the matching vkey. Swapping the set (a real ceremony, `docs/CEREMONY.md`)
used to be a flag day: one `VKEY`, no field on the wire, `invalid-proof` for whichever side
upgraded first. Now (`lib/zk-artifacts.mjs`):

| Piece | Where | What |
| --- | --- | --- |
| Artifact id | `artifactIdOf(circuit, vkeyBytes)` | `<circuit>-<sha256(verification_key.json bytes)[0:16]>`, i.e. the vkey's `testdata/zk-artifacts.lock.json` hash prefix (`circuits.rln.artifactId`). Content-derived: no registry, and a mislabeled id fails closed at load. Rust: `rgoe_proto::artifact_id_of`. |
| Gateway accepted set | `RGOE_ZK_ARTIFACTS=<id>=<vkey>[,<id>=<vkey>]` → `loadArtifactSet` | `{artifactId → vkey}`; unset = the built-in vkey under its own id (byte-equivalent to the single-VK code). Advertised as SIGNED `caps.artifacts` when set (`bootnode/heartbeat.mjs`). |
| Legacy id | `RGOE_ZK_ARTIFACT_LEGACY=<id>` (default: lock `previousArtifactId`, else built-in id) | What an envelope WITHOUT `artifact` means — the pre-T-HARD-8 wire / an un-upgraded client. |
| Envelope field | `artifact` (after `nonce`) | The set the proof was made with; `buildEnvelope` stamps the prover's echoed id. |
| Gateway gate | `verifyEnvelope` step 3b (`resolveArtifact`) | Cheap map lookup BEFORE the SNARK; then Groth16 verify under THAT vkey. |
| Client pick | `selectArtifact(gatewayIds, clientIds)` | The NEWEST of the client's own sets (`RGOE_ZK_PROVER_ARTIFACTS`, newest first) that the gateway advertises; no ad ⇒ optimistically its newest. Rust: `rgoe_proto::select_artifact`. |

Reason strings (bounded labels pinned in `testdata/vectors.json` `artifacts.reasons`):

| Reason | Meaning |
| --- | --- |
| `artifact-retired:<id>` | the (legacy) id is known but no longer accepted — window closed; carries `artifacts:[accepted]` |
| `artifact-unknown:<id>` | an id this gateway holds no vkey for (incl. spoofing to an unheld key); carries `artifacts` |
| `bad-artifact:<repr>` | field present but not an id (repr bounded) |
| `invalid-proof` | (unchanged) incl. a proof CLAIMING an accepted id it was not made with — spoofing buys nothing |
| `no-mutual-artifact:client=…,gateway=…` | client-side: disjoint sets ⇒ fail closed BEFORE proving/dialing |
| `artifact negotiation failed: …` | client-side throw wrapping `no-mutual-artifact` |

Backward compatibility (proven in `lib/zk-artifacts.selftest.mjs` + `test/zk-artifact-window.
selftest.mjs`): no field ⇒ legacy id (accepted while it is in the set); a gateway that predates the
field ignores it; nothing configured on either side ⇒ prove/verify round-trip exactly as before.
The dual-VK WINDOW procedure with concrete env is `docs/CEREMONY.md` §6.

## Follow-ups

- **Directory/announce advertisement of the range** (with T-FEAT-10 capability advertisement):
  carry `{min,max}` in the signed announce so a client selects a compatible gateway *before*
  dialing, instead of learning the range from a reject. Requires `bootnode/*` + `lib/directory.mjs`.
