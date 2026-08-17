# Installing `rgoe`

`rgoe` is the distributable client for Reputation-Gated Onion Egress: a single
binary that runs on a clean box with **no Node, no Tor daemon, and no runtime**.
Cross-compiled release binaries are attached to each [GitHub Release](../../releases)
(built by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
T-RUST-4).

There are two flavors, published honestly:

| Flavor | Subcommands | Native deps | How it's built |
| --- | --- | --- | --- |
| **default `rgoe`** | `verify-directory`, `select`, `verify-receipt`, `fetch-directory` | none (pure Rust) | cross-compiled to every target below |
| **`rgoe …-live`** | all of the above **plus** `egress` (real RLN Groth16 proof + embedded Tor) | ark-circom → wasmer, arti | built natively, one per runner OS |

The default binary is the everyday client: it verifies signed directories, selects
and orders gateways, verifies egress receipts, and caches a last-known-good
directory — everything a client decides **before** it touches the network. The
`-live` binary adds the actual onion egress: it mints a real RLN envelope in Rust
and dials the gateway over **embedded Tor** (arti — no system `tor`, no SOCKS).

## Which binary for which platform

**Default `rgoe`** (cross-compiled, all seven):

| OS | Arch | Asset |
| --- | --- | --- |
| Linux | x86_64 | `rgoe-<version>-x86_64-unknown-linux-gnu` (also `-musl`) |
| Linux | aarch64 | `rgoe-<version>-aarch64-unknown-linux-gnu` (also `-musl`) |
| macOS | Apple Silicon | `rgoe-<version>-aarch64-apple-darwin` |
| macOS | Intel | `rgoe-<version>-x86_64-apple-darwin` |
| Windows | x86_64 | `rgoe-<version>-x86_64-pc-windows-msvc.exe` |

**`-live` `rgoe`** (native per runner — a smaller published set):

| OS | Arch | Asset |
| --- | --- | --- |
| Linux | x86_64 | `rgoe-<version>-x86_64-unknown-linux-gnu-live` |
| macOS | Apple Silicon | `rgoe-<version>-aarch64-apple-darwin-live` |
| Windows | x86_64 | `rgoe-<version>-x86_64-pc-windows-msvc-live.exe` |

The `-live` binary is **not** published for every target: its native deps
(`wasmer`, `arti`) are not worth static cross-linking, so it is compiled on the
runner whose OS matches. If you need `egress` on a platform without a published
`-live` asset (e.g. Linux arm64), build it from source (below) on that platform.
The default binary works everywhere.

The musl builds are fully static (no glibc dependency) — use them on
Alpine/distroless or any box where the glibc build complains about the loader.

## Install (Linux / macOS)

Download the asset for your platform from the Release, then:

```sh
# example: macOS Apple Silicon, default client
curl -L -o rgoe https://github.com/<owner>/<repo>/releases/download/v<version>/rgoe-<version>-aarch64-apple-darwin
chmod +x rgoe

# verify the checksum (each asset ships a .sha256)
curl -L -O https://github.com/<owner>/<repo>/releases/download/v<version>/rgoe-<version>-aarch64-apple-darwin.sha256
shasum -a 256 -c rgoe-<version>-aarch64-apple-darwin.sha256   # or: sha256sum -c

# run it — no Node, no Tor, no install
./rgoe --version
./rgoe --help
```

On macOS the binary is unsigned; if Gatekeeper blocks it, clear the quarantine
attribute: `xattr -d com.apple.quarantine ./rgoe`.

## Install (Windows)

Download `rgoe-<version>-x86_64-pc-windows-msvc.exe`, then from PowerShell:

```powershell
Get-FileHash .\rgoe-<version>-x86_64-pc-windows-msvc.exe -Algorithm SHA256
.\rgoe-<version>-x86_64-pc-windows-msvc.exe --version
```

## Using it

Default client (works on any of the seven targets):

```sh
# verify a signed directory against the pinned bootnode signer
rgoe verify-directory directory.json --signer <ed25519-hex>

# verify, then print the weighted gateway pick + failover order
rgoe select directory.json --signer <ed25519-hex> --seed 42

# fetch a fresh directory, verify it, cache the last-known-good copy
rgoe fetch-directory --signer <ed25519-hex> --bootnode-tcp 127.0.0.1:8080 --cache lkg.json

# verify an egress-success receipt bound to a gateway onion
rgoe verify-receipt receipt.json --onion <onion>
```

Live egress (`-live` binary only) — the circuit artifacts are **embedded**, so no
`--circuits` directory is needed:

```sh
# 1. export your member identity for the Rust client from your RGOE_SECRET (JS CLI, once;
#    writes {identitySecret, leaf} mode 0600 — secret material, keep it local).
#    `rgoe identity` here is the JS bin/rgoe.mjs (npm link), not this binary.
RGOE_SECRET=0x… rgoe identity --out identity.json        # or --secret-file ./.secret

# 2. dial the selected gateway .onion over embedded Tor, minting a real RLN envelope
rgoe egress --directory directory.json --signer <hex> \
  --identity identity.json --members members.json --target example.com:443
```

`--members` is the fleet's committed `group/members.json` (`{version, members[]}`); the
`leaf` in `identity.json` must be one of its entries (`rgoe identity` echoes the leaf on
stderr so you can check). Derive with the same `RGOE_SLOTS` (K, default 8) the fleet runs.

Pass `--circuits <dir>` only if you want to prove against circuit files on disk
instead of the ones baked into the binary. Use `--plain-tcp <host:port>` to dial
without Tor (test/CI).

## Testnet-only artifacts (important)

The `-live` binary embeds the repository's RLN ZK artifacts (`rln.wasm`,
`rln_final.zkey`, `verification_key.json`). **These are from an untrusted testnet
setup** (docs/SHIP-PLAN.md **T-HARD-1**, `circuits/rln/ARTIFACTS.md`). They are fine
for testing and interop but are **not** production trusted-setup output. A
production release must re-embed audited artifacts from a real ceremony. Embedding
does not change their provenance — it only makes the binary self-contained.

## Building from source

Needs a Rust toolchain (stable). From the repo root:

```sh
cd rust
cargo build --release -p rgoe-client                  # default client -> target/release/rgoe
cargo build --release -p rgoe-client --features live  # live client (embeds artifacts + arti + prover)
```

The release profile (`opt-level="z"`, `lto`, `codegen-units=1`, `strip`,
`panic="abort"`, in [`rust/Cargo.toml`](Cargo.toml)) is what keeps the binary small
and symbol-stripped. The `live` build is heavier (native `wasmer` + `arti`) and
takes several minutes; the default build is sub-second incremental.

See [`README.md`](README.md) for the crate layout and the JS↔Rust conformance story,
and [`../docs/adr/0001-client-language.md`](../docs/adr/0001-client-language.md) for
why the client is a single static Rust binary.
