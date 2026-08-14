# rgoe (Rust)

The Rust **distributable** client for Reputation-Gated Onion Egress. The
JavaScript client (`client/rgoe-client.mjs` + `lib/`) is the **reference**
implementation and the source of truth for the wire protocol; this workspace
reimplements it as a single static binary with embedded Tor. Rationale and the
JS/Rust boundary: [`../docs/adr/0001-client-language.md`](../docs/adr/0001-client-language.md).

Scaffold status: T-RUST-0 (workspace only). Most of `rgoe-proto` is `todo!()`
stubs marked `T-RUST-1`/`T-RUST-2`; the client is a version/usage stub.

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

Implemented at scaffold time (deterministic, no crypto deps): `request_signal`,
`operator_auth_message`, `signal_field_safe`, plus `#[test]`s that check them.
The rest are `todo!()` with `T-RUST-1`/`T-RUST-2` markers.

### `rgoe-client` (bin `rgoe`)

The distributable. Depends on `rgoe-proto` for every trust-critical check.
Heavy runtime deps (`arti-client`, `zerokit`/`rln`, `alloy`, `tokio`, `hyper`)
are deferred to T-RUST-2 so the scaffold builds fast; they are noted as TODOs in
`rgoe-client/Cargo.toml`.

## Conformance vectors

The language-neutral fixtures live at
[`../testdata/vectors.json`](../testdata/vectors.json) (byte-pinned, test-only
seeds). The JS side already reproduces every value (`test/vectors.selftest.mjs`).
T-RUST-1 adds the Rust runner that asserts the same bytes, gating both
implementations against drift. The byte-pinned keys and the functions that must
reproduce them are the conformance map in
[`../docs/PROTOCOL-API.md`](../docs/PROTOCOL-API.md) section 9.

## Build & test

```sh
cd rust
cargo build          # workspace
cargo test           # runs the rgoe-proto scaffold tests
cargo run -p rgoe-client   # prints the version/usage stub
```

Release profile (`opt-level=z`, `lto`, `strip`, `panic=abort`) targets the small
static binary that is the point of the Rust client; cross-compiled release
binaries are T-RUST-4.
