# Install the Rust client

Tagged releases publish two variants of the `shade-tree` binary:

| Variant | Includes | Published targets |
| --- | --- | --- |
| default | directory and receipt verification, selection, cache | Linux x86_64/aarch64 (GNU and musl), macOS x86_64/aarch64, Windows x86_64 |
| `-live` | default features plus RLN proving and embedded Tor | Linux x86_64 (GNU), macOS aarch64, Windows x86_64 |

Every asset has a matching `.sha256` file. The `-live` builds embed the
repository's testnet RLN artifacts; review
[`../circuits/rln/ARTIFACTS.md`](../circuits/rln/ARTIFACTS.md) before use.

## One-line install

`scripts/install.sh` detects your OS and CPU, downloads the matching asset and
its `.sha256` from the latest release, verifies the checksum, and only then
places the binary in `~/.local/bin/shade-tree`. It needs `curl` and
`sha256sum`, `shasum`, or `openssl`. It never uses sudo and never runs a byte
it has not verified. It is configured through environment variables, so it
behaves the same whether piped or saved and read first.

```sh
curl -fsSL https://raw.githubusercontent.com/dmarzzz/shade-tree-node/main/scripts/install.sh | sh
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHADE_TREE_VERSION` | latest release | Pin a tag, `v0.3.0` or `0.3.0` |
| `SHADE_TREE_LIVE` | `0` | `1` installs the `-live` variant where the table above lists one; other targets are refused. Only `0` or `1` is accepted |
| `SHADE_TREE_INSTALL_DIR` | `$HOME/.local/bin` | Destination directory, created if missing |
| `SHADE_TREE_FORCE` | `0` | `1` replaces a symlink at the destination, which is how npm installs its own `shade-tree`. A regular file there is replaced without it, with a note |
| `SHADE_TREE_TARGET` | detected | Skip detection, for example `x86_64-unknown-linux-musl` |
| `SHADE_TREE_LIBC` | detected | `gnu` or `musl`; required when neither `ldd` nor the dynamic loader identifies the libc |
| `SHADE_TREE_RELEASE_BASE` | GitHub Releases | `https://` only; `file://` and loopback `http://` are accepted for the selftest and local mirrors |

Notes:

- The npm CLI (`npm install --global git+...`) is also called `shade-tree`; it
  keeps that name for the Proxy, `shade-tree run`, and the operator commands.
  If both are on `PATH` the earlier directory wins; the installer lists every
  other `shade-tree` it finds and says which one your shell will run. In the
  examples below, the `identity` command belongs to the npm CLI; every other
  `shade-tree` command is the Rust binary (`./target/release/shade-tree` from
  source, `~/.local/bin/shade-tree` after this installer).
- Live egress still needs the npm CLI once, to export `identity.json` at your
  enrolled tier. Each Rust `egress` run picks its own slot, so until
  [issue #75](https://github.com/dmarzzz/shade-tree-node/issues/75) is fixed
  make at most one `egress` invocation per member secret per protocol epoch
  (120 seconds by default), counting any attempt that may have reached a node.
  `--slot-cursor` is best-effort and wraps at K; do not rely on it.
- On Windows the installer runs from Git Bash or MSYS2 (x86_64) and installs
  `shade-tree.exe`. PowerShell users download the asset and its `.sha256` by
  hand and compare the digest with `Get-FileHash` as shown below.

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
identity with the npm CLI at that tier, then run the live Rust build by its
path: the one-line install puts it in `~/.local/bin`, a source build in
`./target/release`:

```bash
read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET
read -r SHADE_TREE_LIMIT && export SHADE_TREE_LIMIT
# The identity command belongs to the npm CLI. If the Rust client shadows it on PATH,
# call the npm CLI by path: node "$(npm root -g)/shade-tree-node/bin/shade-tree.mjs" ...
shade-tree identity --limit "$SHADE_TREE_LIMIT" --out identity.json

"${SHADE_TREE_INSTALL_DIR:-$HOME/.local/bin}/shade-tree" egress \
  --directory directory.json \
  --signer <ed25519-hex> \
  --identity identity.json \
  --members members.json \
  --target example.com:443
```

Keep `identity.json` local; it contains secret material. Run
`shade-tree --help` for discovery, cache, capability, and transport options.
