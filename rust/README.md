# rgoe (Rust)

The Rust **distributable** client for Reputation-Gated Onion Egress. The
JavaScript client (`client/rgoe-client.mjs` + `lib/`) is the **reference**
implementation and the source of truth for the wire protocol; this workspace
reimplements it as a single static binary with embedded Tor. Rationale and the
JS/Rust boundary: [`../docs/adr/0001-client-language.md`](../docs/adr/0001-client-language.md).

Status: **T-RUST-2 — deterministic client MVP.** The full deterministic pipeline
is implemented and conformance-checked against `testdata/vectors.json`
byte-for-byte; the two non-deterministic LIVE pieces (RLN Groth16 proving, the Tor
dial) are cleanly stubbed and deferred to **T-RUST-2b** (see [Deferred](#deferred-t-rust-2b)).

## What this MVP does (deterministic, conformance-backed)

Everything a client decides *before* it touches the network, reproduced in Rust and
gated by the golden vectors:

- **Directory verification** — parse an untrusted signed directory, verify the
  pinned-signer ed25519 signature and every entry's onion↔pubkey binding
  (`verify_directory`).
- **Gateway selection** — client-side weight clamping (`clamp_weight`, `MAX_WEIGHT`)
  and weighted-random `pick_gateway` / `selection_order` failover under an injectable
  rng (deterministic in tests).
- **Receipt verification** — parse an egress-success receipt and verify its onion
  binding, epoch canonicality/freshness, and ed25519 signature under the receipt-only
  domain tag (`verify_receipt`, `canonical_receipt_bytes`, `RECEIPT_DOMAIN`).
- **Protocol version negotiation** — `select_proto_version` (highest mutual, fail
  closed on disjoint) and `accept_envelope_version` with the pinned reason labels.
- Plus the T-RUST-1 primitives already present: onion↔pubkey, canonical
  directory/announce bytes, ed25519 sign/verify, `calculate_signal_hash` target binding.

The `rgoe` binary is a real CLI over these: `verify-directory`, `select`,
`verify-receipt`, `--help`/`version` (and an `egress` subcommand that prints the
honest deferred-egress error). See [CLI](#rgoe-client-bin-rgoe).

## Deferred (T-RUST-2b)

The **live egress** path — the non-deterministic, heavy-native-dep half — is a
separate follow-up and is honestly stubbed in `rgoe-client` (`live_egress()` returns
`"live egress is T-RUST-2b, not yet implemented"`):

- **RLN Groth16 proving** via `zerokit` (PSE's canonical Rust RLN) — the envelope
  membership proof. Non-deterministic proof bytes, so not byte-pinnable.
- **Tor dial** via `arti-client` (embedded Tor: no system `tor`, no SOCKS, no
  `torrc`) — dial the gateway onion and carry the CONNECT tunnel.

These are intentionally NOT added in this run to keep the workspace fast to build
(no `arti`, `zerokit`, `alloy`, or `tokio`); the deferred-deps NOTE lives in
`rgoe-client/Cargo.toml`. Real byte-for-byte egress through a live gateway is the
T-RUST-2b acceptance criterion.

## Layout

```
rust/
  Cargo.toml            # workspace: members rgoe-proto, rgoe-client
  rgoe-proto/           # lib: shared, trust-critical checks (no I/O, deterministic)
    src/lib.rs
  rgoe-client/          # bin `rgoe`: distributable; depends on rgoe-proto
    src/main.rs
```

### `rgoe-proto` (lib)

The trust-critical, deterministic checks, isolated from all I/O so they can be
conformance-tested in pure Rust. Everything here maps to a JS reference
`file:symbol` and a section of [`../docs/PROTOCOL-API.md`](../docs/PROTOCOL-API.md):

| rgoe-proto item | JS reference | Spec |
| --- | --- | --- |
| `onion_to_pubkey` / `pubkey_to_onion` | `lib/directory.mjs:96/:114` | 2 |
| `canonical_announce_bytes` | `bootnode/announce.mjs:38` | 1.1 |
| `canonical_directory_bytes` | `lib/directory.mjs:129` | 1.2 |
| `ed25519_public_key` / `ed25519_sign` / `ed25519_verify` | `lib/directory.mjs:46` | 3 |
| `verify_directory` | `lib/directory.mjs:152` | 4.3 |
| `verify_announce` | `bootnode/announce.mjs:80` | 3.4 |
| `operator_auth_message` | `bootnode/announce.mjs:45` | 3.2 |
| `request_signal` | `lib/rln.mjs:124` | 6.2 |
| `calculate_signal_hash` | `lib/rln.mjs:122,:253` | 6.2 |
| `signal_field_safe` | `lib/rln.mjs:132` | 6.3 |
| `canonical_receipt_bytes` / `verify_receipt` / `RECEIPT_DOMAIN` | `lib/receipt.mjs:61/:88/:55` | T-FEAT-13 |
| `accept_envelope_version` | `gateway/gateway.mjs:278` | T-FEAT-11 |
| `select_proto_version` | `client/rgoe-client.mjs:95` | T-FEAT-11 |
| `clamp_weight` / `pick_gateway` / `selection_order` | `lib/directory.mjs:274/:279/:296` | 4 |

All rows above are implemented and tested. `verify_announce` remains a documented
stub (its operator-ECDSA / EIP-191 path needs secp256k1 in Rust; the
`operatorAnnounce` vector already exists for that future task). The canonical byte
functions are hand-built in fixed key order (never via a serializer), so
`rgoe-proto` has no serde dependency.

### `rgoe-client` (bin `rgoe`)

The distributable, a real CLI over the `rgoe-proto` checks. It adds `serde`/`serde_json`
(ONLY here — proto's canonical path stays serde-free) to parse untrusted directory /
receipt JSON into local DTOs, maps them to the proto structs, and runs the
trust-critical checks. Subcommands:

| command | what it does |
| --- | --- |
| `verify-directory <file> --signer <hex>` | verify a signed directory (signature + onion↔pubkey binding); prints `ok` / `not-ok: <reason>` |
| `select <dir-file> --signer <hex> [--seed <n>]` | verify, then print the weighted chosen onion + failover order (`--seed` = reproducible) |
| `verify-receipt <receipt-file> --onion <onion>` | verify an egress receipt bound to `--onion`; prints the recovered pubkey/epoch |
| `egress <host:port>` | LIVE egress — prints the honest T-RUST-2b "not yet implemented" error |
| `--help` / `--version` | usage / version |

The live-egress heavy deps (`arti-client`, `zerokit`/`rln`, `alloy`, `tokio`,
`hyper`) are deferred to **T-RUST-2b** so the workspace builds fast; they are noted
in `rgoe-client/Cargo.toml`, and `live_egress()` in `src/main.rs` is the stub that
points at them.

## Conformance vectors

The language-neutral fixtures live at
[`../testdata/vectors.json`](../testdata/vectors.json) (byte-pinned, test-only
seeds). The JS side already reproduces every value (`test/vectors.selftest.mjs`).
`rgoe-proto/tests/conformance.rs` is the Rust runner that asserts the same bytes,
gating both implementations against drift — including the new `receipt` block
(`receiptDomain`, `canonicalReceiptBytesHex`, `receiptOnionSig`) and the
`protoReasons` version-negotiation reason labels. The byte-pinned keys and the
functions that must reproduce them are the conformance map in
[`../docs/PROTOCOL-API.md`](../docs/PROTOCOL-API.md) section 9.

## Build & test

```sh
cd rust
cargo build --workspace    # both crates
cargo test  --workspace    # 9 rgoe-proto unit tests + 20 conformance tests
cargo run -p rgoe-client -- --help          # CLI usage
cargo run -p rgoe-client -- verify-directory <dir.json> --signer <hex>
```

Release profile (`opt-level=z`, `lto`, `strip`, `panic=abort`) targets the small
static binary that is the point of the Rust client; cross-compiled release
binaries are T-RUST-4.
