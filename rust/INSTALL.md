# Install the Rust client

Tagged releases publish two variants of the `shade-tree` binary:

| Variant | Includes | Published targets |
| --- | --- | --- |
| default | directory and receipt verification, selection, cache | Linux x86_64/aarch64 (GNU and musl), macOS x86_64/aarch64, Windows x86_64 |
| `-live` | default features plus RLN proving and embedded Tor | Linux x86_64, macOS aarch64, Windows x86_64 |

Every asset has a matching `.sha256` file. The `-live` builds embed the
repository's testnet RLN artifacts; review
[`../circuits/rln/ARTIFACTS.md`](../circuits/rln/ARTIFACTS.md) before use.

## Download

Choose an asset from the [latest release](https://github.com/dmarzzz/shade-tree-node/releases/latest).
For example, on Apple Silicon:

```sh
curl -LO https://github.com/dmarzzz/shade-tree-node/releases/download/v0.3.0/shade-tree-0.3.0-aarch64-apple-darwin
curl -LO https://github.com/dmarzzz/shade-tree-node/releases/download/v0.3.0/shade-tree-0.3.0-aarch64-apple-darwin.sha256
shasum -a 256 -c shade-tree-0.3.0-aarch64-apple-darwin.sha256
chmod +x shade-tree-0.3.0-aarch64-apple-darwin
./shade-tree-0.3.0-aarch64-apple-darwin --help
```

The macOS release is not notarized. If Gatekeeper quarantines a binary whose
checksum you have verified:

```sh
xattr -d com.apple.quarantine ./shade-tree-0.3.0-aarch64-apple-darwin
```

On Windows, verify with:

```powershell
Get-FileHash .\shade-tree-0.3.0-x86_64-pc-windows-msvc.exe -Algorithm SHA256
```

## Build from source

Use the repository's pinned Rust toolchain and a C compiler:

```sh
git clone https://github.com/dmarzzz/shade-tree-node.git
cd shade-tree-node/rust

cargo build --release -p shade-tree-client
# or, for RLN proof generation and embedded Tor:
cargo build --release -p shade-tree-client --features live
```

The result is `target/release/shade-tree` (or `shade-tree.exe` on Windows).

## Examples

```sh
shade-tree verify-directory directory.json --signer <ed25519-hex>
shade-tree select directory.json --signer <ed25519-hex> --seed 42
shade-tree fetch-directory --signer <ed25519-hex> \
  --bootnode-tcp 127.0.0.1:8080 --cache lkg.json
shade-tree verify-receipt receipt.json --onion <onion>
```

Live egress requires an identity and the membership set committed by the
gateway. Get the exact enrolled tier from the Grove operator. Generate the
identity with the npm CLI at that tier, then use the live Rust build:

```bash
read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET
read -r SHADE_TREE_LIMIT && export SHADE_TREE_LIMIT
shade-tree identity --limit "$SHADE_TREE_LIMIT" --out identity.json

./target/release/shade-tree egress \
  --directory directory.json \
  --signer <ed25519-hex> \
  --identity identity.json \
  --members members.json \
  --target example.com:443
```

Keep `identity.json` local; it contains secret material. Run
`shade-tree --help` for discovery, cache, capability, and transport options.
Live egress automatically coordinates RLN slots with JS clients under the
public leaf in `SHADE_TREE_SLOT_STATE_DIR` (or the OS user-state directory).
`--slot-cursor <file>` is an exact state-path override, not an opt-in. The
manual `--slot` bypass requires
`--unsafe-allow-slot-reuse-for-slashing-tests` and must never be used with a
live or funded member.
