# rgoe-rln — RLN interop probe (T-RUST-2b, RLN-INTEROP slice)

Proves that the Rust client can produce the RLN Groth16 **egress envelope proof**
byte-compatibly with the JavaScript reference: a Rust-built proof, generated against
the repository's own `circuits/rln/*` artifacts, is **accepted by `lib/rln.mjs`
`verifyEnvelope`**, and the RLN slash primitive works across the JS/Rust boundary.

This crate is a workspace **member but is excluded from `default-members`** (see
`rust/Cargo.toml`): it has a heavy dep tree (`ark-circom` → `wasmer`), so the everyday
`cargo build` / `cargo test` over `rgoe-proto` + `rgoe-client` never compile it. Build
it explicitly with `cargo build -p rgoe-rln`. It is **not** wired into the
`rgoe-client` binary (that is later T-RUST-2b work).

## Result (all green)

`bash rust/rgoe-rln/interop/run.sh` (needs `npm install` at the repo root for `rlnjs`):

1. **Target binding is Rust-owned.** `x = calculate_signal_hash(request_signal(target,
   nonce))` is recomputed with the conformance-gated `rgoe-proto` code and matches.
2. **Public signals match the reference exactly.** The witness's
   `[y, root, nullifier, x, externalNullifier]` equal what `rlnjs` `proveForSlot`
   produces for the same identity/epoch/slot/signal.
3. **The Rust proof verifies against the repo `verification_key.json`** (checked
   in-process with `ark-groth16` + `CircomReduction`).
4. **`verifyEnvelope` ACCEPTS the Rust envelope** (`ok: true`) — including check 2b
   target-binding and the Groth16 verify — with authoritative fields matching.
5. **Cross-impl over-spend.** Two Rust shares for the same (identity, epoch, slot) with
   different `x` share a nullifier, and `lib/rln.mjs` `reconstructSecret` recovers the
   `identitySecret` from the two Rust shares.

## Which approach worked, and the fork that forced it

The task's de-risking step 1 was: can **zerokit** (`rln` crate) consume THIS repo's
`rln_final.zkey`? Static finding on `rln = "3"` (**zerokit rln 3.0.0**, ark 0.5):

- zerokit 3.0.0 ingests circuit resources **only in its own `arkzkey` format**
  (`zkey_from_raw` → `read_arkzkey_from_bytes_uncompressed`, an ark-serialized
  `(ProvingKey, ConstraintMatrices)`), and it **bundles its own trusted-setup**
  resources (`resources/tree_depth_20/{graph.bin, rln_final.arkzkey}`). It has **no
  snarkjs `.zkey` reader**. So a stock-zerokit proof verifies against zerokit's VK, not
  ours; and our snarkjs `rln_final.zkey` cannot be handed to zerokit as-is. **This is
  the hard fork.** (zerokit's public-signal order `[y, root, nullifier, x,
  externalNullifier]`, `CircomReduction`, and Poseidon derivations DO match ours — only
  the key ingestion format blocks it.)

Chosen resolution — the task's **option (b), `ark-circom`** — because it uses the
repo's *own* artifacts end to end and so removes every interop risk at once:

- `ark_circom::read_zkey` loads the repo's snarkjs `rln_final.zkey` into
  `(ProvingKey<Bn254>, ConstraintMatrices<Fr>)` (ark 0.5, same as zerokit's `Zkey`).
- `ark_circom::WitnessCalculator` computes the witness with the repo's **`rln.wasm`**
  — the *same circom compilation* as the zkey, so there is no witness-graph / wire-order
  mismatch (the risk that would attend feeding our zkey to zerokit's bundled `graph.bin`).
- `ark-groth16` (`CircomReduction`) proves; the proof is serialized to snarkjs-shaped
  JSON (`pi_a/pi_b/pi_c`, G2 as `[c0, c1]`) that `rlnjs`'s verifier reads directly.

Net: the interop crux is proven **without** zerokit. A future zerokit-native path is
still open but requires converting the repo's snarkjs zkey → `arkzkey` (e.g. via
`ark-circom` `read_zkey` + re-serialize) and validating zerokit's `graph.bin` against
this exact circuit; not needed for the Gate-2 interop proof.

## Files

- `src/main.rs` — `rgoe-rln-probe <fixture.json> <out.json> <circuits-dir>`: witness →
  prove → in-process verify → emit snarkjs-shaped envelope JSON.
- `interop/fixture-gen.mjs` — emits circuit inputs + the `rlnjs` reference public
  signals for a fixed identity/epoch/slot/target and a CLI-overridable nonce.
- `interop/verify-envelope.mjs` — assembles the wire envelope and asserts
  `verifyEnvelope` accepts it.
- `interop/overspend.mjs` — cross-impl slash: two Rust shares → `reconstructSecret`.
- `interop/run.sh` — builds the probe and runs the whole chain.

## Scope / honesty

Testnet-only artifacts (untrusted circom-rln ceremony; see `circuits/rln/ARTIFACTS.md`).
The `wasmer`-based witness calculator needs a Tokio reactor in context (probe wraps it
in a runtime guard). The merkle path is supplied by the JS fixture generator here; a
native Rust depth-20 Poseidon tree (matching the rlnjs Semaphore-v3 group root) is
T-RUST-3 parity work, not required to prove envelope interop.
