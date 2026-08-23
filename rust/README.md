# Shade Tree for Rust

The Rust workspace contains the distributable `shade-tree` client and the
trust-critical protocol implementation behind it.

> Research preview. The bundled RLN artifacts are suitable for testing, not a
> production trusted setup. See [`../circuits/rln/ARTIFACTS.md`](../circuits/rln/ARTIFACTS.md).

The JavaScript client in [`../client/shade-tree-client.mjs`](../client/shade-tree-client.mjs)
is the reference implementation. Golden vectors in
[`../testdata/vectors.json`](../testdata/vectors.json) keep both implementations
on the same v4 wire format.

## Workspace

```text
rust/
├── shade-tree-proto/   canonical bytes, signatures, selection, receipts
├── shade-tree-client/  the `shade-tree` binary
└── shade-tree-rln/     RLN proving, verification, and artifact bindings
```

The default binary verifies directories and receipts, selects gateways, and
maintains a last-known-good directory cache. The optional `live` feature adds
RLN proof generation and an embedded Arti Tor client for onion egress.

```sh
cd rust

# Fast deterministic client
cargo build --release -p shade-tree-client

# Live egress client with embedded Tor and RLN artifacts
cargo build --release -p shade-tree-client --features live

# Complete workspace checks
cargo test --workspace --all-features
cargo check --workspace --all-targets --all-features
```

The binary is written to `target/release/shade-tree`. Release binaries and
checksums are attached to tagged GitHub releases; see [`INSTALL.md`](INSTALL.md).

## Trust boundary

`shade-tree-proto` owns deterministic security decisions and deliberately has
no I/O or JSON serializer dependency. The client parses untrusted input into
local data structures, then hands it to that crate for canonicalization and
verification.

The conformance suite covers:

- signed directory and onion/public-key binding verification;
- capability and admission-aware gateway selection;
- explicit protocol-v4 negotiation and v3 rejection;
- request signal and receipt domain separation;
- JavaScript/Rust byte parity for the checked-in vectors.

The `live` path also validates the embedded ZK artifact lock before proving.
It does not make the artifact ceremony more trustworthy: provenance remains a
separate deployment requirement.

## Client commands

```text
shade-tree verify-directory …
shade-tree fetch-directory …
shade-tree select …
shade-tree verify-receipt …
shade-tree egress …            # requires --features live
```

Run `shade-tree --help` for the complete option set. For the local agent proxy
and `shade-tree run -- <agent>` wrapper, use the npm package documented in the
repository [`README`](../README.md).

## Protocol changes

Shade Tree v4 is a clean boundary. Old v3 envelopes and request proofs are not
accepted under the new name. Operators must regenerate operator-authorization,
capability, and receipt signatures; domain-neutral signatures over unchanged
canonical bytes are unaffected. Deployments using the changed exit and
withdrawal domains require new contracts. See
[`../docs/MIGRATING-TO-SHADE-TREE.md`](../docs/MIGRATING-TO-SHADE-TREE.md).
