# RGOE Protocol API

Wire-format and HTTP-API contract for the bootnode and its record types. This is the
reimplementation target for the Rust conformance client (T-RUST-1). Every claim cites a
`file:symbol`. Where source and this doc disagree, the source wins; report the drift.

Golden fixtures: [`testdata/vectors.json`](../testdata/vectors.json). See [Conformance](#9-conformance).

## 0. Version tags (do not conflate)

| Tag | Value | Meaning | Source |
| --- | --- | --- | --- |
| `ANNOUNCE_VERSION` | `1` | announce record `v` field | `bootnode/announce.mjs:34` |
| directory `version` | `1` | signed-directory `version` field | `bootnode/server.mjs:127` |
| envelope `v` | `3` | egress-envelope `v` field | `client/rgoe-client.mjs:91` |
| signal prefix | `rgoe:v3` | request-signal line 1 | `lib/rln.mjs:125` |
| onion | v3 | Tor onion address version byte `0x03` | `lib/directory.mjs:104` |

"v3" is the protocol generation (RLN v3). The announce/directory internal `version`/`v`
fields are `1`; only the egress envelope carries `v:3`. Keep them distinct.

## 1. Canonical byte encodings

Both canonical encoders build a fresh object with a FIXED key order, then
`Buffer.from(JSON.stringify(obj), "utf8")`. JSON key order therefore follows object insertion
order exactly as written below. Whitespace: none (default `JSON.stringify`). Numbers are plain
JSON numbers. Unsigned / label fields are EXCLUDED from the signed bytes.

ed25519 (RFC 8032, `crypto.sign(null, msg, key)`) is deterministic, so a signature over these
bytes is byte-reproducible across implementations (`lib/directory.mjs:46` `ed25519Sign`).

### 1.1 `canonicalAnnounceBytes` — `bootnode/announce.mjs:38`

```
payload = { v, onion, weight, ts, nonce }      // exactly this order
bytes   = utf8( JSON.stringify(payload) )
```

Excluded from the signed bytes: `onionSig`, `operator`, `operatorSig`.

### 1.2 `canonicalDirectoryBytes` — `lib/directory.mjs:129`

```
payload = {
  version,
  issued,
  gateways: [ { onion, pubkey, weight, health }, ... ]   // per-entry order fixed
}
bytes = utf8( JSON.stringify(payload) )
```

Excluded from the signed bytes: top-level `signer`, `signature`; per-gateway `operator`,
`staked`, and any other field. Only the four listed gateway fields are covered, in that order.

## 2. v3 onion <-> ed25519 identity key

A v3 `.onion` address IS its ed25519 public key. `lib/directory.mjs:96` `onionToPubkey` /
`:114` `pubkeyToOnion`.

```
addr56  = base32_nopad_lower( pubkey[32] || checksum[2] || version[1] )
version = 0x03
checksum = SHA3-256( b".onion checksum" || pubkey || 0x03 )[:2]
```

- base32 alphabet: `abcdefghijklmnopqrstuvwxyz234567`, lowercase, NO padding
  (`lib/directory.mjs:63` `B32`).
- The address string is the 56 base32 chars WITHOUT the `.onion` suffix; decoded it is 35
  bytes (`32 + 2 + 1`).
- Recovery checks: 56 chars, decodes to 35 bytes, `version == 0x03`, checksum matches.
- `pubkey` is reported as lowercase hex.

`onionToPubkey` throw messages (they appear verbatim inside reason codes below):

| Condition | message |
| --- | --- |
| bad base32 char | `bad base32 char in onion` |
| length != 56 | `not a v3 onion (expected 56 chars)` |
| decode length != 35 | `v3 onion decodes to 35 bytes` |
| version byte != 0x03 | `not onion version 3` |
| checksum mismatch | `onion checksum mismatch` |

## 3. Announce record

Built by `bootnode/announce.mjs:51` `buildAnnounce`; verified by `:80` `verifyAnnounce`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `v` | number | yes | `== ANNOUNCE_VERSION` (`1`) |
| `onion` | string | yes | v3 `.onion` (with suffix) |
| `weight` | number | yes | default `100`; selection weight (clamped by bootnode, section 5) |
| `ts` | number | yes | unix seconds; freshness-checked |
| `nonce` | string | yes | 16 random bytes hex (32 hex chars) via `cryptoNonce` (`:67`); replay key |
| `onionSig` | hex string | yes | ed25519 over `canonicalAnnounceBytes(rec)`, signed by the onion identity key (`:59`) |
| `operator` | string | no | Ethereum address, lowercased (`:62`) |
| `operatorSig` | hex string | no | EIP-191 `personal_sign` over `operatorAuthMessage` (`:63`) |

### 3.1 Onion-control signature (proof 1, always required)

`onionSig = ed25519Sign( canonicalAnnounceBytes(rec), onionSeedHex )` where `onionSeedHex` is
the 32-byte ed25519 seed behind the onion. Verified with `verifyOnionControl(onion, bytes,
sig)` (`lib/directory.mjs:179`), which re-derives the key from the address. Never trusts the
bootnode.

### 3.2 Operator authorization (proof 2, optional; enforced when `admission=stake`)

Durable (no timestamp): one signature authorizes the onion for as long as the operator stays
staked. Message string, `bootnode/announce.mjs:45` `operatorAuthMessage`:

```
RGOE gateway operator authorization\nonion=<onion>\noperator=<operator-lowercased>
```

`\n` are literal newline bytes (`0x0a`). `<operator>` is `String(operator).toLowerCase()`.
Verified by recovering the EIP-191 signer with `ethers.verifyMessage` and requiring
`recovered.toLowerCase() === operator.toLowerCase()` (`:131` `verifyOperatorSig`). Stake is
then confirmed via `GatewayRegistry.isStaked(operator)` (`lib/gateway-registry.mjs`).

### 3.3 Freshness + nonce replay

- Freshness (`:94`): reject unless `typeof ts === "number"` and `|now - ts| <= skew`.
  `skew = DEFAULT_ANNOUNCE_SKEW = 120` seconds (`:35`).
- Nonce replay (`:97`,`:124`): the replay key is the string `` `${onion}:${nonce}` ``. If a
  `seenNonce` guard is supplied and already `has` the key, reject; otherwise `add` it only on
  full success. The bootnode's guard is a bounded `Map` swept on the TTL
  (`bootnode/server.mjs:59` `makeNonceGuard`).

### 3.4 `verifyAnnounce` reason codes — `bootnode/announce.mjs:80`

Checks run in this order; the FIRST failure is returned. `<...>` are interpolations.

| # | Reason | Condition |
| --- | --- | --- |
| 1 | `no-announce` | `rec` not an object |
| 2 | `bad-version:<rec.v>` | `rec.v !== 1` |
| 3 | `no-onion` | `typeof rec.onion !== "string"` |
| 4 | `bad-onion:<msg>` | `onionToPubkey` threw (`<msg>` from section 2 table) |
| 5 | `stale-ts:<rec.ts>` | `ts` not a number, or `|now - ts| > skew` |
| 6 | `replayed-nonce` | `seenNonce.has("<onion>:<nonce>")` |
| 7 | `bad-onion-sig` | `onionSig` missing OR `verifyOnionControl` false |
| 8 | `bad-operator-sig` | `operator`+`operatorSig` present but recovery != operator |
| 9 | `stake-check-failed:<msg>` | `isStaked` threw AND `requireStake` |
| 10 | `not-staked` | `requireStake && !staked` |
| — | success | `{ ok:true, onion, pubkey, operator, staked }` |

Notes: proof 2 (rows 8-10) is only entered when `rec.operator && rec.operatorSig` are both
present. If `isStaked` is omitted, stake is not checked and `staked` stays `false` (a valid
`operatorSig` still populates `operator`). `requireStake` is set by the bootnode when
`admission === "stake"`.

## 4. Signed directory

Built by `bootnode/server.mjs:118` `directory()` -> `signDirectory` (`lib/directory.mjs:143`);
verified by `:152` `verifyDirectory`.

### 4.1 Shape

```jsonc
{
  "version": 1,
  "issued": <unix-seconds>,
  "gateways": [
    {
      "onion":  "<v3 .onion>",
      "pubkey": "<hex ed25519, == onionToPubkey(onion)>",
      "weight": <number>,
      "health": "up",
      "operator": "<addr>",   // present only when the entry had an operator
      "staked":   <bool>      // present only when the entry had an operator
    }
  ],
  "signer":    "<hex ed25519 pubkey of the pinned signer>",
  "signature": "<hex ed25519 over canonicalDirectoryBytes(dir)>"
}
```

`operator`/`staked` are labels only; they are NOT covered by the signature (section 1.2).
`health` is `"up"` for every live entry the bootnode emits (`bootnode/server.mjs:123`);
clients still probe and fail over (`lib/directory.mjs:264` `reportHealth`).

### 4.2 Pinned-signer model

The client pins ONE signer pubkey (`RGOE_DIR_SIGNER`, printed at bootnode startup,
`bootnode/server.mjs:197`). `verifyDirectory(dir, pinnedSignerHex)`:

1. `dir.signature` must exist.
2. If `dir.signer` is present, it must equal `pinnedSignerHex` (case-insensitive).
3. The signature must verify against `pinnedSignerHex` over `canonicalDirectoryBytes(dir)`.
4. For every gateway, `onionToPubkey(onion)` must equal `pubkey` (case-insensitive).

A bootnode is a cache, not a trust root: it can omit entries but cannot forge one, because
each `pubkey` is re-derived from the self-authenticating onion address.

### 4.3 `verifyDirectory` reason codes — `lib/directory.mjs:152`

| # | Reason | Condition |
| --- | --- | --- |
| 1 | `no-directory` | `dir` not an object |
| 2 | `unsigned` | no `dir.signature` |
| 3 | `signer-not-pinned` | `dir.signer` present and != pinned (case-insensitive) |
| 4 | `bad-signature` | ed25519 verify over canonical bytes fails |
| 5 | `bad-onion:<onion[:12]>..:<msg>` | `onionToPubkey(g.onion)` threw |
| 6 | `pubkey-onion-mismatch:<onion[:12]>..` | derived key != `g.pubkey` |
| — | success | `{ ok:true }` |

`<onion[:12]>` is the first 12 chars of the onion string.

### 4.4 Threshold (M-of-N) directory — T-FEAT-9 — `lib/directory.mjs`

The single-signer directory trusts ONE bootnode key: compromise it and a client's fleet
*view* can be steered (entries omitted/reordered — a forged onion is still impossible, onion
control is re-checked). A directory MAY instead be signed by an M-of-N set of INDEPENDENT
signers (composes with T-FEAT-1 federation: each federated bootnode is one signer), so no
single key compromise produces an accepted directory.

The extension is **additive**. Three OPTIONAL top-level fields carry it, and they are
**excluded from `canonicalDirectoryBytes` exactly like `signer`/`signature`** (section 1.2) —
so every signer signs the *same* canonical bytes as the single-sig directory over the same
`{version,issued,gateways}`, and the byte encoding is unchanged:

```jsonc
{
  "version": 1, "issued": <unix>, "gateways": [ /* … */ ],
  "signers":    ["<hex ed25519 pubkey>", …],   // index-aligned with signatures
  "signatures": ["<hex ed25519 over canonicalDirectoryBytes(dir)>", …],
  "threshold":  <M>                            // distinct valid pinned sigs required
}
```

A directory carrying NONE of `signers`/`signatures`/`threshold` takes the unchanged
single-`signer` path (`verifyDirectory`, section 4.2). The classic single-signer directory is
the 1-of-1 case and verifies byte-for-byte as before. Produced by
`signDirectoryThreshold(dir, [seedHex…], M)`; verified by `verifyDirectoryThreshold` (which
`verifyDirectory` delegates to when any threshold field is present).

**Verify rule.** Accept iff at least `threshold` **distinct** signers from the client's PINNED
allowlist (`normalizePinnedSigners`, the T-HARD-5 set) each produced a valid signature over
`canonicalDirectoryBytes(dir)`. A signer counted **once** (one key cannot self-satisfy M-of-N
by signing twice); an unpinned signer is **ignored**; a malformed entry is **skipped**. The
per-gateway onion↔pubkey binding (section 4.3, reasons 5–6) is then checked identically.

| # | Reason | Condition |
| --- | --- | --- |
| 1 | `no-directory` | `dir` not an object |
| 2 | `bad-threshold` | `threshold` not an integer ≥ 1 |
| 3 | `bad-signatures` | `signers`/`signatures` not equal-length arrays |
| 4 | `threshold-exceeds-signers` | `threshold` > number of provided signers (unsatisfiable) |
| 5 | `threshold-not-met:<got>/<want>` | fewer than `threshold` distinct valid pinned sigs |
| 6 | `bad-onion:…` / `pubkey-onion-mismatch:…` | as section 4.3 |
| — | success | `{ ok:true, signers:[matched…], threshold }` |

Golden vector: `testdata/vectors.json` `thresholdDirectory` (2-of-3, fixed seeds; its canonical
bytes equal `canonicalDirectoryBytesHex`). Rust parity: `rust/rgoe-proto`
`verify_directory_threshold(dir, pinned_signers)` consumes this shape (T-FEAT-9b);
`verify_directory` remains the single-signer path.

## 5. Bootnode HTTP API

Server: `bootnode/server.mjs:151` `makeServer`. All responses
`content-type: application/json`. Listens on loopback (`127.0.0.1:RGOE_BOOTNODE_PORT`, default
`8877`) behind its own onion service.

### 5.1 Routes

| Method | Path | Success | Source |
| --- | --- | --- | --- |
| GET | `/health` | `200 { ok:true, count, admission, signer }` | `:155` |
| GET | `/directory` | `200 <signed directory>` (section 4.1) | `:158` |
| GET | `/gateway/<onion>` | `200 <stored announce rec>` (section 3) | `:162` |
| POST | `/announce` | `200 { ok:true, onion, staked, ttl }` | `:167` |

- `/health`: `count` = live entry count; `admission` = `"open"|"stake"`; `signer` = pinned
  signer pubkey hex.
- `/gateway/<onion>`: `<onion>` is `decodeURIComponent`-ed; the registry appends `.onion` if
  absent (`:131` `record`). Returns the exact stored announce for zero-trust re-verification.
- `/announce`: request body is the announce record JSON (section 3). `ttl` in the reply is
  `registry.ttlSec` (default `900`).

### 5.2 Error responses

| Status | Body | When | Source |
| --- | --- | --- | --- |
| 400 | `{ ok:false, err:"bad-json:<msg>" }` | `/announce` body not JSON, or body too large | `:169` |
| 400 | `{ ok:false, err:"<reason>" }` | `/announce` verify failed; `<reason>` = a section-3.4 code or a section-5.3 cap reason | `:171` |
| 404 | `{ ok:false, err:"not-found" }` | `/gateway/<onion>` unknown | `:165` |
| 404 | `{ ok:false, err:"no-route" }` | no route matched | `:173` |
| 500 | `{ ok:false, err:"bootnode-error:<msg>" }` | unhandled exception | `:175` |

### 5.3 Admission modes + DoS caps

Registry: `bootnode/server.mjs:76` `makeRegistry`.

| Control | Default | Env | Effect |
| --- | --- | --- | --- |
| `admission` | `open` | `RGOE_BOOTNODE_ADMISSION` | `open` = onion-sig only; `stake` sets `requireStake` (operator sig + live stake enforced) |
| `ttlSec` | `900` | `RGOE_BOOTNODE_TTL` | seconds an entry stays live without re-announce |
| `maxEntries` | `10000` | `RGOE_BOOTNODE_MAX_ENTRIES` | a NEW onion is refused `registry-full` when full (after a sweep); existing onions still refresh |
| `minReannounceSec` | `5` | `RGOE_BOOTNODE_MIN_REANNOUNCE` | a resident onion re-announcing sooner is refused `rate-limited` |
| `MAX_WEIGHT` | `1000` | (const) | stored weight = `max(0, min(1000, weight))`; `weight` non-finite -> `100` (`:97`,`:100`) |
| request body cap | `64 KiB` | (const) | `readBody` max (`:142`); overflow -> `400 bad-json:body too large` |

Registry-level announce reasons (returned as `400 { err:<reason> }`), checked BEFORE the
signature verify (`:87`,`:88`):

| Reason | Condition |
| --- | --- |
| `rate-limited` | resident onion, `now - lastAt < minReannounceSec` |
| `registry-full` | new onion, `live.size >= maxEntries` after a sweep |

The signed `/directory` response is bounded transitively by `maxEntries` (one gateway object
per live entry); there is no separate byte-cap on the response. See ambiguity note in the
report.

## 6. Egress envelope v3

The envelope is NOT part of the bootnode HTTP API. The client sends it to a GATEWAY onion over
a Tor SOCKS tunnel (`client/rgoe-client.mjs:184` `_dial`, destination port `80`) as
`JSON.stringify(envelope) + "\n"` (`:218`). The gateway replies with ONE newline-terminated
JSON line: `{ ok:true }` on admit, else `{ ok:false, err:"gate:<reason>" }` or another
`err` (`gateway/gateway.mjs:205`,`:240`). Documented here because the same wire format the
Rust client emits must satisfy `verifyEnvelope`.

### 6.1 Wire shape — `client/rgoe-client.mjs:82` `buildEnvelope`

```jsonc
{
  "v": 3,
  "target": "<host:port>",
  "nonce":  "<16 random bytes hex, 32 chars>",
  "proof": {                     // wireProof, lib/rln.mjs:227
    "snarkProof": { "proof": {...}, "publicSignals": { "y","root","nullifier","x","externalNullifier" } },
    "epoch": "<decimal string>",
    "rlnIdentifier": "<decimal string>"
  },
  "nullifier": "<decimal string>",
  "externalNullifier": "<decimal string>",
  "share": { "x": "<decimal string>", "y": "<decimal string>" }
}
```

`nullifier`, `externalNullifier`, and `share` are copies of the proof's public signals but are
NON-authoritative: `verifyEnvelope` reads them from `proof.snarkProof.publicSignals` (`ps`), not
from the envelope copies (`lib/rln.mjs:288` header). `publicSignals` field set is
`{ y, root, nullifier, x, externalNullifier }` (`client/rgoe-client.mjs:214`).

### 6.2 Request signal + target binding

`lib/rln.mjs:124` `requestSignal`:

```
requestSignal(target, nonce) = `rgoe:v3\n${target}\n${nonce}`
```

The circuit public `x` is `calculateSignalHash(message)` = `keccak256(utf8(message)) >> 8`
(`lib/rln.mjs:122`,`:253`), deterministic. Target-binding invariant (`:322`):

```
calculateSignalHash( requestSignal(env.target, env.nonce) )  ==  ps.x
```

so a captured proof cannot be redirected to a different target/nonce.

### 6.3 `signalFieldSafe` bounds — `lib/rln.mjs:132`

```
signalFieldSafe(s, maxLen) = (typeof s === "string") && s.length > 0
                             && s.length <= maxLen && !/[\n\r]/.test(s)
```

In `verifyEnvelope`: `signalFieldSafe(target, 256)` and `signalFieldSafe(nonce, 128)`
(`:316`). Enforced BEFORE hashing so no crafted delimiter or oversized field can make two
distinct `(target, nonce)` pairs collide to one signal.

### 6.4 `verifyEnvelope` check order — `lib/rln.mjs:288`

Fail-closed, FIRST failure returned. `ps = proof.snarkProof.publicSignals`;
`share = env.share || { x: ps.x, y: ps.y }`.

| # | Reason on failure | Check |
| --- | --- | --- |
| pre | `no-envelope` | `env` not an object |
| pre | `no-proof` | missing `proof` / `snarkProof` / `publicSignals` |
| 1 | `stale-external-nullifier` | `ps.externalNullifier` not `externalNullifierFor(now)` nor `...(now-1)` (one-epoch skew) |
| 2 | `signal-mismatch` | `String(share.x) !== String(ps.x)` |
| 2b | `unbound-target` | `env.nonce == null` or `env.target == null` |
| 2b | `bad-signal-field` | `!signalFieldSafe(target,256)` or `!signalFieldSafe(nonce,128)` |
| 2b | `target-not-bound` | `calculateSignalHash(requestSignal(target,nonce)) !== ps.x` |
| 3 | `wrong-group-root` | `String(ps.root)` not in `recentRoots` |
| 4 | `verify-threw:<msg>` | Groth16 verify threw |
| 4 | `invalid-proof` | Groth16 verify returned false |
| — | success | `{ ok:true, reason:"ok", nullifier, externalNullifier, share:{x,y} }` from `ps` |

Ordering is load-bearing (`:319` INVARIANT): 2b binds `target -> ps.x` cheaply, but `ps.x` is
only AUTHORITATIVE once check 4 proves the Groth16 membership proof. Both are required; never
trust 2b without 4. Do not reorder 2b apart from 4.

Epoch clock: `epoch = floor(nowMs/1000 / EPOCH_SECONDS)`, `EPOCH_SECONDS` default `120`
(`lib/rln.mjs:78`,`:80`). `externalNullifier(epoch) = Poseidon(epoch, RLN_IDENTIFIER)`,
`RLN_IDENTIFIER` default `1` (`:72`,`:115`).

### 6.5 Determinism

| Value | Deterministic? | Conformance method |
| --- | --- | --- |
| ed25519 signatures (announce, directory) | YES (RFC 8032) | byte-equality |
| onion address, checksum, canonical bytes | YES | byte-equality |
| `calculateSignalHash(message)` = `x` | YES | byte/decimal-equality |
| RLN Groth16 proof bytes (`proof.snarkProof.proof`) | NO (randomized per call, `lib/rln.mjs:238`) | verify for validity/equivalence, NOT byte-equality |
| RLN public signals `x,y,nullifier,externalNullifier,root` | YES given inputs | value-equality |

## 7. Cross-check for a second implementation

1. Reproduce `onionToPubkey` / `pubkeyToOnion` (SHA3-256 checksum, base32 no-pad).
2. Reproduce `canonicalAnnounceBytes` and `canonicalDirectoryBytes` byte-for-byte.
3. ed25519 sign/verify with raw 32-byte seed/pubkey (RFC 8032, null-digest).
4. `verifyAnnounce` / `verifyDirectory` / `verifyEnvelope` reason codes and ordering.
5. EIP-191 `personal_sign` recover for `operatorAuthMessage` (secp256k1).
6. `requestSignal` string, `signalFieldSafe`, and the target-binding hash.

## 8. Ambiguities / notes

- The `readBody` cap (64 KiB) is on the REQUEST body; there is no explicit byte-cap on the
  `/directory` RESPONSE. Response size is bounded only transitively by `maxEntries`.
- `verifyEnvelope` reads `nullifier`/`share` from the proof's public signals, so the
  envelope's own copies are advisory. A Rust client should still send them (the gateway ack
  path and older tooling read them), but they must equal the public signals or the proof is
  self-inconsistent and rejected at check 2 (`signal-mismatch`).

## 9. Conformance

Fixture file: [`testdata/vectors.json`](../testdata/vectors.json). Test-only fixed seeds. The
Rust client MUST reproduce every BYTE-PINNED value below exactly.

| Key | Byte-pinned | Produced by |
| --- | --- | --- |
| `signerSeed` | input | 32-byte ed25519 signer seed (hex) |
| `signerPub` | YES | `ed25519PublicKey(signerSeed)` raw pubkey hex |
| `onionSeed` | input | 32-byte onion identity seed (hex) |
| `onionPub` | YES | onion identity pubkey hex |
| `onion` | YES | `pubkeyToOnion(onionPub)` |
| `canonicalDirectoryBytesHex` | YES | hex of `canonicalDirectoryBytes(dir)` for `version:1, issued:1000000, gateways:[{onion,pubkey:onionPub,weight:100,health:"up"}]` |
| `directorySignature` | YES | `ed25519Sign(canonicalDirectoryBytes, signerSeed)` |
| `announce` | YES | the record `{v:1, onion, weight:100, ts:1000000, nonce:"abcdef0123456789abcdef0123456789"}` |
| `canonicalAnnounceBytesHex` | YES | hex of `canonicalAnnounceBytes(announce)` |
| `announceOnionSig` | YES | `ed25519Sign(canonicalAnnounceBytes, onionSeed)` |
| `operator` | input | `0x000000000000000000000000000000000000dEaD` (note mixed-case input) |
| `operatorAuthMessage` | YES | `operatorAuthMessage(onion, operator)` (operator lowercased in the string) |

NOT pinned (verify by equivalence, never byte-equality):

- RLN Groth16 proofs (`proof.snarkProof.proof`) — non-deterministic; see 6.5.
- `operatorSig` — not in the fixture; validated by EIP-191 recovery, not byte-match.
</content>
</invoke>
