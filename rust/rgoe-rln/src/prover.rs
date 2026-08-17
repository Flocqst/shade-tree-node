//! Build a REAL RLN egress envelope in Rust (T-RUST-2d).
//!
//! This is the T-RUST-2b probe's proving core, promoted to a reusable library entry
//! point so `rgoe-client` can mint an envelope behind its `live` feature (no standalone
//! harness). Given an **identity** (its Semaphore-v3 `identitySecret` + the matching
//! `rateCommitment` leaf) and the ordered **member set**, [`build_envelope`]:
//!
//! 1. builds the depth-20 Poseidon membership tree NATIVELY ([`crate::tree`], T-RUST-2c)
//!    and derives this member's `root` + `pathElements`/`identityPathIndex` — no JS fixture;
//! 2. binds the target: `x = calculate_signal_hash(request_signal(target, nonce))` via the
//!    conformance-gated `rgoe-proto` code (the SAME check the JS gateway re-runs, so the
//!    Rust side owns the binding);
//! 3. computes `externalNullifier = poseidon2(epoch, rlnIdentifier)` NATIVELY (matches
//!    `lib/rln.mjs` `externalNullifierFor`);
//! 4. runs the repo's `rln.wasm` witness calculator + `ark-groth16` over the repo's
//!    `rln_final.zkey`, and VERIFIES the proof in-process against `verification_key.json`;
//! 5. returns the proof pieces the wire envelope is assembled from (the caller frames the
//!    `{ v, target, nonce, proof, nullifier, externalNullifier, share }` envelope exactly as
//!    `client/rgoe-client.mjs` `buildEnvelope` does).
//!
//! The heavy native deps (`ark-circom` -> `wasmer`) are why `rgoe-rln` is excluded from
//! `default-members` and `rgoe-client` only pulls it under `--features live`.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_circom::{read_zkey, CircomReduction, WitnessCalculator};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, Proof, VerifyingKey};
use ark_std::UniformRand;
use num_bigint::{BigInt, BigUint, Sign};
use wasmer::{Module, Store};

use crate::tree::{dec_to_fr, external_nullifier, fr_to_dec, MerkleTree, TREE_DEPTH};

// T-RUST-4: the repo's circom-rln artifacts, `include_bytes!`'d into the binary so a
// released `live` client is fully self-contained (no external circuit files). Gated by
// the `embedded-artifacts` feature (OFF by default; `rgoe-client`'s `live` feature turns
// it on) so the standalone probe/tree bins and the everyday rgoe-rln build stay lean.
// Paths are anchored at CARGO_MANIFEST_DIR (rust/rgoe-rln) -> repo root -> circuits/rln.
// TESTNET-ONLY artifacts (untrusted ceremony, docs/SHIP-PLAN.md T-HARD-1): embedding does
// not change their provenance — a production build must re-embed audited artifacts.
#[cfg(feature = "embedded-artifacts")]
mod embedded {
    pub const WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../circuits/rln/rln.wasm"
    ));
    pub const ZKEY: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../circuits/rln/rln_final.zkey"
    ));
    pub const VKEY: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../circuits/rln/verification_key.json"
    ));
}

/// Inputs to build one RLN egress envelope (T-RUST-2d).
pub struct EnvelopeInput {
    /// Semaphore-v3 `identitySecret` (decimal) — the value a slash reveals.
    pub identity_secret: String,
    /// This member's `rateCommitment` leaf (decimal) — must be present in `members`.
    pub member_leaf: String,
    /// The ordered `rateCommitment` leaves of the group (same order the gateway builds).
    pub members: Vec<String>,
    /// Egress target `host:port` bound into the proof's public `x`.
    pub target: String,
    /// Per-request nonce (rides in the envelope so the gateway re-derives + binds `x`).
    pub nonce: String,
    /// The epoch the proof is for (`externalNullifier = poseidon2(epoch, rlnIdentifier)`).
    pub epoch: u64,
    /// RLN identifier / group id (decimal, default "1").
    pub rln_identifier: String,
    /// `userMessageLimit` = K (per-epoch rate cap).
    pub user_message_limit: u64,
    /// `messageId` = slot i (range-checked `0 <= i < K` inside the circuit).
    pub message_id: u64,
    /// Where to load `rln.wasm`, `rln_final.zkey`, `verification_key.json` from:
    /// `Some(dir)` reads them from that directory; `None` uses the artifacts EMBEDDED
    /// into the binary (`include_bytes!`, T-RUST-4) — needs the `embedded-artifacts`
    /// feature (which `rgoe-client`'s `live` feature enables). `None` on a build without
    /// that feature is an honest error rather than a silent fallback.
    pub circuits_dir: Option<String>,
}

/// The proof pieces the caller assembles into the wire envelope. `proof` and
/// `public_signals` are snarkjs-shaped JSON (exactly `rlnjs` RLNFullProof's
/// `snarkProof.proof` / `snarkProof.publicSignals`), so the client frames the wire
/// envelope byte-compatibly with `client/rgoe-client.mjs`.
pub struct BuiltEnvelope {
    pub target: String,
    pub nonce: String,
    pub epoch: String,
    pub rln_identifier: String,
    pub proof: serde_json::Value,
    pub public_signals: serde_json::Value,
    pub nullifier: String,
    pub external_nullifier: String,
    pub share_x: String,
    pub share_y: String,
}

// ---- field / json helpers (kept local so src/main.rs stays untouched) ----------

fn dec_to_fq(s: &str) -> Fq {
    Fq::from(BigUint::parse_bytes(s.as_bytes(), 10).expect("decimal Fq"))
}

fn pf_to_dec<F: PrimeField>(f: &F) -> String {
    BigUint::from_bytes_be(&f.into_bigint().to_bytes_be()).to_str_radix(10)
}

fn dec_to_bigint(s: &str) -> BigInt {
    s.parse::<BigInt>().expect("decimal BigInt")
}

fn fr_to_bigint(f: &Fr) -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &f.into_bigint().to_bytes_be())
}

fn g1(v: &serde_json::Value) -> G1Affine {
    G1Affine::new(
        dec_to_fq(v[0].as_str().unwrap()),
        dec_to_fq(v[1].as_str().unwrap()),
    )
}

fn g2(v: &serde_json::Value) -> G2Affine {
    let x = Fq2::new(
        dec_to_fq(v[0][0].as_str().unwrap()),
        dec_to_fq(v[0][1].as_str().unwrap()),
    );
    let y = Fq2::new(
        dec_to_fq(v[1][0].as_str().unwrap()),
        dec_to_fq(v[1][1].as_str().unwrap()),
    );
    G2Affine::new(x, y)
}

fn parse_vk(vk: &serde_json::Value) -> VerifyingKey<Bn254> {
    let gamma_abc_g1 = vk["IC"].as_array().unwrap().iter().map(g1).collect();
    VerifyingKey {
        alpha_g1: g1(&vk["vk_alpha_1"]),
        beta_g2: g2(&vk["vk_beta_2"]),
        gamma_g2: g2(&vk["vk_gamma_2"]),
        delta_g2: g2(&vk["vk_delta_2"]),
        gamma_abc_g1,
    }
}

fn g1_json(p: &G1Affine) -> serde_json::Value {
    serde_json::json!([pf_to_dec(&p.x), pf_to_dec(&p.y), "1"])
}

fn g2_json(p: &G2Affine) -> serde_json::Value {
    serde_json::json!([
        [pf_to_dec(&p.x.c0), pf_to_dec(&p.x.c1)],
        [pf_to_dec(&p.y.c0), pf_to_dec(&p.y.c1)],
        ["1", "0"],
    ])
}

/// Build one RLN egress envelope (native tree + Groth16 prover). Errors are returned as
/// `String` so the CLI can surface an honest failure; internal invariant breaks (a proof
/// that does not verify against the repo VK, or public signals that disagree with the
/// natively-computed root/x/externalNullifier) fail loud rather than shipping a bad envelope.
pub fn build_envelope(input: &EnvelopeInput) -> Result<BuiltEnvelope, String> {
    // Artifact source: `Some(dir)` = external files under that dir; `None` = the artifacts
    // EMBEDDED into this binary via `include_bytes!` (T-RUST-4, `embedded-artifacts` feature),
    // so a released `live` client proves with no external circuit files.
    let circuits = input.circuits_dir.as_deref();

    // (1) NATIVE membership tree (T-RUST-2c): root + path from the member set.
    let rid_big = BigUint::parse_bytes(input.rln_identifier.as_bytes(), 10)
        .ok_or("rln_identifier must be a decimal integer")?;
    if input.members.is_empty() {
        return Err("members is empty".into());
    }
    let leaves: Vec<Fr> = input.members.iter().map(|s| dec_to_fr(s)).collect();
    let tree = MerkleTree::new(&rid_big, TREE_DEPTH, &leaves);
    let leaf_fr = dec_to_fr(&input.member_leaf);
    let index = tree
        .index_of(&leaf_fr)
        .ok_or("member_leaf not present in members (identity is not in the group)")?;
    let (siblings, path_indices) = tree.create_proof(index);
    let native_root = fr_to_dec(&tree.root());

    // (2) target binding: x = calculate_signal_hash(request_signal(target, nonce)).
    let signal = rgoe_proto::request_signal(&input.target, &input.nonce);
    let x = rgoe_proto::calculate_signal_hash(&signal);

    // (3) externalNullifier = poseidon2(epoch, rlnIdentifier) — native, matches JS.
    let ext_null = fr_to_dec(&external_nullifier(input.epoch, &rid_big));

    // (4) witness via the repo's rln.wasm (same circom compile as the zkey).
    let mut inputs: HashMap<String, Vec<BigInt>> = HashMap::new();
    inputs.insert(
        "identitySecret".into(),
        vec![dec_to_bigint(&input.identity_secret)],
    );
    inputs.insert(
        "userMessageLimit".into(),
        vec![BigInt::from(input.user_message_limit)],
    );
    inputs.insert("messageId".into(), vec![BigInt::from(input.message_id)]);
    inputs.insert(
        "pathElements".into(),
        siblings.iter().map(fr_to_bigint).collect(),
    );
    inputs.insert(
        "identityPathIndex".into(),
        path_indices.iter().map(|&i| BigInt::from(i)).collect(),
    );
    inputs.insert("x".into(), vec![dec_to_bigint(&x)]);
    inputs.insert("externalNullifier".into(), vec![dec_to_bigint(&ext_null)]);

    // wasmer-wasix's virtual-fs needs a Tokio reactor in context to open the wasm.
    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
    let full_assignment: Vec<Fr> = {
        let _guard = rt.enter();
        let mut store = Store::default();
        // Compile the circuit wasm from the external file, or from the EMBEDDED bytes.
        let module = match circuits {
            Some(dir) => {
                let wasm_path = format!("{dir}/rln.wasm");
                Module::from_file(&store, &wasm_path)
                    .map_err(|e| format!("load {wasm_path}: {e}"))?
            }
            None => {
                #[cfg(feature = "embedded-artifacts")]
                {
                    Module::from_binary(&store, embedded::WASM)
                        .map_err(|e| format!("compile embedded rln.wasm: {e}"))?
                }
                #[cfg(not(feature = "embedded-artifacts"))]
                {
                    return Err(
                        "no --circuits dir and this build has no embedded artifacts \
                                (build rgoe-client with --features live)"
                            .into(),
                    );
                }
            }
        };
        let mut wtns = WitnessCalculator::from_module(&mut store, module)
            .map_err(|e| format!("witness calculator: {e}"))?;
        wtns.calculate_witness_element::<Fr, _>(&mut store, inputs, false)
            .map_err(|e| format!("calculate witness: {e}"))?
    };

    // circom witness layout: [1, y, root, nullifier, x, externalNullifier, ...private].
    let y = full_assignment[1];
    let root = full_assignment[2];
    let nullifier = full_assignment[3];
    let x_sig = full_assignment[4];
    let ext_null_sig = full_assignment[5];
    let public_inputs = &full_assignment[1..6];

    // (5) invariants: the proof's public signals must agree with what we computed natively.
    if pf_to_dec(&root) != native_root {
        return Err(format!(
            "witness root {} != native tree root {native_root}",
            pf_to_dec(&root)
        ));
    }
    if pf_to_dec(&x_sig) != x {
        return Err(format!("witness x {} != bound x {x}", pf_to_dec(&x_sig)));
    }
    if pf_to_dec(&ext_null_sig) != ext_null {
        return Err(format!(
            "witness externalNullifier {} != native {ext_null}",
            pf_to_dec(&ext_null_sig)
        ));
    }

    // (6) prove with the repo's rln_final.zkey (external file, or the embedded bytes).
    let (pk, matrices) = match circuits {
        Some(dir) => {
            let zkey_path = format!("{dir}/rln_final.zkey");
            let mut zkey_reader = BufReader::new(
                File::open(&zkey_path).map_err(|e| format!("open {zkey_path}: {e}"))?,
            );
            read_zkey(&mut zkey_reader).map_err(|e| format!("read zkey: {e}"))?
        }
        None => {
            #[cfg(feature = "embedded-artifacts")]
            {
                let mut zkey_reader = std::io::Cursor::new(embedded::ZKEY);
                read_zkey(&mut zkey_reader).map_err(|e| format!("read embedded zkey: {e}"))?
            }
            #[cfg(not(feature = "embedded-artifacts"))]
            {
                return Err("no embedded rln_final.zkey (build --features live)".into());
            }
        }
    };
    let mut rng = ark_std::rand::thread_rng();
    let r = Fr::rand(&mut rng);
    let s = Fr::rand(&mut rng);
    let proof: Proof<Bn254> =
        Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
            &pk,
            r,
            s,
            &matrices,
            matrices.num_instance_variables,
            matrices.num_constraints,
            &full_assignment,
        )
        .map_err(|e| format!("create proof: {e}"))?;

    // (7) DECISIVE self-check: verify the Rust proof against the repo verification_key.json
    // (external file, or the embedded bytes).
    let vk_json: serde_json::Value = match circuits {
        Some(dir) => {
            let vkey_path = format!("{dir}/verification_key.json");
            serde_json::from_reader(BufReader::new(
                File::open(&vkey_path).map_err(|e| format!("open {vkey_path}: {e}"))?,
            ))
            .map_err(|e| format!("parse vkey: {e}"))?
        }
        None => {
            #[cfg(feature = "embedded-artifacts")]
            {
                serde_json::from_slice(embedded::VKEY)
                    .map_err(|e| format!("parse embedded vkey: {e}"))?
            }
            #[cfg(not(feature = "embedded-artifacts"))]
            {
                return Err("no embedded verification_key.json (build --features live)".into());
            }
        }
    };
    let vk = parse_vk(&vk_json);
    let pvk = prepare_verifying_key(&vk);
    let ok = Groth16::<Bn254, CircomReduction>::verify_proof(&pvk, &proof, public_inputs)
        .map_err(|e| format!("verify: {e}"))?;
    if !ok {
        return Err("Rust proof did NOT verify against verification_key.json".into());
    }

    Ok(BuiltEnvelope {
        target: input.target.clone(),
        nonce: input.nonce.clone(),
        epoch: input.epoch.to_string(),
        rln_identifier: input.rln_identifier.clone(),
        proof: serde_json::json!({
            "pi_a": g1_json(&proof.a),
            "pi_b": g2_json(&proof.b),
            "pi_c": g1_json(&proof.c),
            "protocol": "groth16",
            "curve": "bn128",
        }),
        public_signals: serde_json::json!({
            "x": pf_to_dec(&x_sig),
            "externalNullifier": pf_to_dec(&ext_null_sig),
            "y": pf_to_dec(&y),
            "root": pf_to_dec(&root),
            "nullifier": pf_to_dec(&nullifier),
        }),
        nullifier: pf_to_dec(&nullifier),
        external_nullifier: pf_to_dec(&ext_null_sig),
        share_x: pf_to_dec(&x_sig),
        share_y: pf_to_dec(&y),
    })
}
