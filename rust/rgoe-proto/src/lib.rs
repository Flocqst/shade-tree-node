//! # rgoe-proto
//!
//! Trust-critical wire-format primitives for the Reputation-Gated Onion Egress
//! (RGOE) protocol. This crate is a Rust port of the security-critical checks in
//! the JavaScript reference client, and it is the reimplementation target for the
//! conformance harness (T-RUST-1).
//!
//! ## Source of truth
//!
//! The JavaScript client is the reference implementation. Where this crate and the
//! JS source disagree, the JS source wins and the drift is a bug here. Every item
//! below cites the reference `file:symbol` and the section of the wire spec it
//! implements:
//!
//! - Wire spec: `docs/PROTOCOL-API.md`
//! - Golden fixtures (byte-pinned): `testdata/vectors.json`
//!
//! ## Determinism contract (spec 6.5)
//!
//! Everything in this crate is deterministic and MUST be conformance-tested by
//! byte- or value-equality against `testdata/vectors.json`:
//!
//! - onion address, checksum, canonical announce/directory bytes,
//! - ed25519 sign/verify (RFC 8032, deterministic),
//! - `request_signal` and the `calculate_signal_hash` target binding.
//!
//! RLN Groth16 proof BYTES are non-deterministic and are therefore NOT in this
//! crate's byte-pinned surface; they are verified for validity/equivalence in the
//! client (T-RUST-2), not by byte-equality.
//!
//! ## Version tags (spec 0 — do not conflate)
//!
//! - `ANNOUNCE_VERSION` = 1 (announce record `v`)
//! - directory `version` = 1
//! - egress envelope `v` = 3
//! - request-signal prefix = `rgoe:v3`
//! - onion address version byte = `0x03`

use std::collections::HashSet;
use std::fmt;

use data_encoding::Specification;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use num_bigint::BigUint;
use sha3::{Digest, Keccak256, Sha3_256};

// --------------------------------------------------------------------------
// Internal helpers (not part of the public wire surface)
// --------------------------------------------------------------------------

/// Base32, lowercase, NO padding, alphabet `abcdefghijklmnopqrstuvwxyz234567`.
/// Mirrors `lib/directory.mjs:63 B32` exactly (Tor v3 onion alphabet).
fn base32() -> data_encoding::Encoding {
    let mut spec = Specification::new();
    spec.symbols.push_str("abcdefghijklmnopqrstuvwxyz234567");
    // padding stays None => no `=` padding, matching JS base32Encode/Decode.
    spec.encoding().expect("valid base32 spec")
}

/// Two-byte v3 onion checksum: `SHA3-256(".onion checksum" || pubkey || 0x03)[:2]`.
/// Reference: `lib/directory.mjs:105`/`:117`.
fn onion_checksum(pubkey: &[u8; 32]) -> [u8; 2] {
    let mut h = Sha3_256::new();
    h.update(b".onion checksum");
    h.update(pubkey);
    h.update([0x03u8]);
    let digest = h.finalize();
    [digest[0], digest[1]]
}

/// Append a JSON string literal to `out` with the exact escaping `JSON.stringify`
/// emits: `"` `\` and the C0 controls (`\b \t \n \f \r`, else `\u00XX`). The onion
/// alphabet and hex fields never need escaping, but this keeps the encoders faithful
/// to `JSON.stringify` for any field value.
fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/// Error type carrying the exact reason strings the JS reference emits, so the
/// Rust checks can reproduce spec reason codes verbatim (spec 2, 3.4, 4.3, 6.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// An `onionToPubkey` failure message from spec section 2, verbatim, e.g.
    /// `"onion checksum mismatch"`.
    Onion(&'static str),
    /// A `verify*` reason code, e.g. `"bad-signature"` or `"replayed-nonce"`.
    Reason(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Onion(m) => write!(f, "{m}"),
            Error::Reason(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Crate result alias.
pub type Result<T> = std::result::Result<T, Error>;

// --------------------------------------------------------------------------
// Record types (spec 3 announce, spec 4.1 directory)
// --------------------------------------------------------------------------

/// One gateway entry inside a signed directory (spec 4.1). Only the first four
/// fields (`onion`, `pubkey`, `weight`, `health`) are covered by the directory
/// signature (spec 1.2); `operator`/`staked` are labels and MUST be excluded from
/// [`canonical_directory_bytes`].
#[derive(Debug, Clone)]
pub struct GatewayEntry {
    /// v3 `.onion` address (with suffix).
    pub onion: String,
    /// lowercase hex ed25519 pubkey; MUST equal `onion_to_pubkey(onion)`.
    pub pubkey: String,
    /// selection weight.
    pub weight: u64,
    /// health label, `"up"` for every entry the bootnode emits.
    pub health: String,
    /// operator address label (NOT signed). Present only when the entry had one.
    pub operator: Option<String>,
    /// stake label (NOT signed). Present only when the entry had an operator.
    pub staked: Option<bool>,
}

/// A signed directory (spec 4.1). `signer`/`signature` are top-level and excluded
/// from the canonical signed bytes (spec 1.2).
#[derive(Debug, Clone)]
pub struct Directory {
    /// directory format version (== 1).
    pub version: u64,
    /// issuance time, unix seconds.
    pub issued: u64,
    /// live gateway entries, order-significant.
    pub gateways: Vec<GatewayEntry>,
    /// hex ed25519 pubkey of the pinned signer (label; not self-signed).
    pub signer: Option<String>,
    /// hex ed25519 signature over `canonical_directory_bytes(dir)`.
    pub signature: Option<String>,
}

/// An announce record (spec 3). Built by `bootnode/announce.mjs:51 buildAnnounce`,
/// verified by `:80 verifyAnnounce`.
#[derive(Debug, Clone)]
pub struct Announce {
    /// `== ANNOUNCE_VERSION` (1).
    pub v: u64,
    /// v3 `.onion` (with suffix).
    pub onion: String,
    /// selection weight (default 100).
    pub weight: u64,
    /// unix seconds; freshness-checked.
    pub ts: u64,
    /// 16 random bytes hex (32 hex chars); replay key.
    pub nonce: String,
    /// ed25519 hex over `canonical_announce_bytes(rec)`, signed by the onion key.
    pub onion_sig: Option<String>,
    /// Ethereum address, lowercased (optional).
    pub operator: Option<String>,
    /// EIP-191 `personal_sign` over `operator_auth_message` (optional).
    pub operator_sig: Option<String>,
}

// --------------------------------------------------------------------------
// 2. v3 onion <-> ed25519 identity key
// --------------------------------------------------------------------------

/// Recover the 32-byte ed25519 public key that a v3 `.onion` address IS.
///
/// Reference: `lib/directory.mjs:96 onionToPubkey` (spec 2).
///
/// The 56-char base32 address (with or without the `.onion` suffix) decodes to 35
/// bytes: `pubkey[32] || checksum[2] || version[1]`, where
/// `checksum = SHA3-256(b".onion checksum" || pubkey || 0x03)[:2]` and
/// `version == 0x03`.
///
/// Returns the verbatim spec-2 message on failure (`Error::Onion`):
/// `bad base32 char in onion`, `not a v3 onion (expected 56 chars)`,
/// `v3 onion decodes to 35 bytes`, `not onion version 3`, `onion checksum mismatch`.
pub fn onion_to_pubkey(onion: &str) -> Result<[u8; 32]> {
    // Strip a trailing ".onion" suffix (case-insensitive) and lowercase, mirroring
    // `addr = onion.replace(/\.onion$/, "").toLowerCase()` (lib/directory.mjs:97).
    let lower = onion.to_lowercase();
    let addr = lower.strip_suffix(".onion").unwrap_or(&lower);
    if addr.len() != 56 {
        return Err(Error::Onion("not a v3 onion (expected 56 chars)"));
    }
    let decoded = base32()
        .decode(addr.as_bytes())
        .map_err(|_| Error::Onion("bad base32 char in onion"))?;
    if decoded.len() != 35 {
        return Err(Error::Onion("v3 onion decodes to 35 bytes"));
    }
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&decoded[0..32]);
    let checksum = &decoded[32..34];
    let version = decoded[34];
    if version != 0x03 {
        return Err(Error::Onion("not onion version 3"));
    }
    if checksum != onion_checksum(&pubkey) {
        return Err(Error::Onion("onion checksum mismatch"));
    }
    Ok(pubkey)
}

/// Encode a 32-byte ed25519 public key as a v3 `.onion` address (with suffix).
///
/// Reference: `lib/directory.mjs:114 pubkeyToOnion` (spec 2). Inverse of
/// [`onion_to_pubkey`]. The address string is 56 base32 no-pad lowercase chars.
pub fn pubkey_to_onion(pubkey: &[u8; 32]) -> String {
    let checksum = onion_checksum(pubkey);
    let mut buf = Vec::with_capacity(35);
    buf.extend_from_slice(pubkey);
    buf.extend_from_slice(&checksum);
    buf.push(0x03);
    format!("{}.onion", base32().encode(&buf))
}

// --------------------------------------------------------------------------
// 1. Canonical byte encodings
// --------------------------------------------------------------------------

/// Canonical signed bytes of an announce record (spec 1.1).
///
/// Reference: `bootnode/announce.mjs:38 canonicalAnnounceBytes`.
///
/// `utf8(JSON.stringify({ v, onion, weight, ts, nonce }))` in exactly that key
/// order, no whitespace. `onionSig`/`operator`/`operatorSig` are EXCLUDED.
///
/// This MUST be produced by hand-building the byte string in fixed key order, NOT
/// by a general JSON serializer (key order and number formatting must match the JS
/// `JSON.stringify` output byte-for-byte; see `testdata/vectors.json`
/// `canonicalAnnounceBytesHex`).
pub fn canonical_announce_bytes(ann: &Announce) -> Vec<u8> {
    // Hand-built in fixed key order { v, onion, weight, ts, nonce }, no whitespace,
    // matching `JSON.stringify` byte-for-byte (bootnode/announce.mjs:38).
    let mut s = String::new();
    s.push_str("{\"v\":");
    s.push_str(&ann.v.to_string());
    s.push_str(",\"onion\":");
    push_json_string(&mut s, &ann.onion);
    s.push_str(",\"weight\":");
    s.push_str(&ann.weight.to_string());
    s.push_str(",\"ts\":");
    s.push_str(&ann.ts.to_string());
    s.push_str(",\"nonce\":");
    push_json_string(&mut s, &ann.nonce);
    s.push('}');
    s.into_bytes()
}

/// Canonical signed bytes of a directory (spec 1.2).
///
/// Reference: `lib/directory.mjs:129 canonicalDirectoryBytes`.
///
/// `utf8(JSON.stringify({ version, issued, gateways: [{ onion, pubkey, weight,
/// health }, ...] }))`. Only those four gateway fields, in that order, are covered;
/// top-level `signer`/`signature` and per-gateway `operator`/`staked` are EXCLUDED.
/// Hand-build the bytes in fixed key order (see [`canonical_announce_bytes`]).
pub fn canonical_directory_bytes(dir: &Directory) -> Vec<u8> {
    // Fixed key order { version, issued, gateways:[{ onion, pubkey, weight, health }] },
    // no whitespace, matching `JSON.stringify` (lib/directory.mjs:129). Top-level
    // signer/signature and per-gateway operator/staked are EXCLUDED.
    let mut s = String::new();
    s.push_str("{\"version\":");
    s.push_str(&dir.version.to_string());
    s.push_str(",\"issued\":");
    s.push_str(&dir.issued.to_string());
    s.push_str(",\"gateways\":[");
    for (i, g) in dir.gateways.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"onion\":");
        push_json_string(&mut s, &g.onion);
        s.push_str(",\"pubkey\":");
        push_json_string(&mut s, &g.pubkey);
        s.push_str(",\"weight\":");
        s.push_str(&g.weight.to_string());
        s.push_str(",\"health\":");
        push_json_string(&mut s, &g.health);
        s.push('}');
    }
    s.push_str("]}");
    s.into_bytes()
}

// --------------------------------------------------------------------------
// 3. ed25519 primitives (RFC 8032, null digest, raw 32-byte seed/pubkey)
// --------------------------------------------------------------------------

/// Derive the raw 32-byte ed25519 public key from a 32-byte seed.
///
/// Reference: `lib/directory.mjs ed25519PublicKey`. Deterministic (RFC 8032).
/// Conformance: `testdata/vectors.json` `signerSeed -> signerPub`,
/// `onionSeed -> onionPub`.
pub fn ed25519_public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// ed25519 sign `msg` with a raw 32-byte seed (RFC 8032, deterministic).
///
/// Reference: `lib/directory.mjs:46 ed25519Sign` = `crypto.sign(null, msg, key)`.
/// Returns the 64-byte signature. Conformance targets: `directorySignature`,
/// `announceOnionSig` in `testdata/vectors.json`.
pub fn ed25519_sign(msg: &[u8], seed: &[u8; 32]) -> [u8; 64] {
    SigningKey::from_bytes(seed).sign(msg).to_bytes()
}

/// Verify a 64-byte ed25519 signature over `msg` against a raw 32-byte pubkey.
///
/// Reference: `lib/directory.mjs ed25519Verify`. Used by [`verify_directory`] and
/// the announce onion-control check.
pub fn ed25519_verify(msg: &[u8], sig: &[u8; 64], pubkey: &[u8; 32]) -> bool {
    // `verify` (not `verify_strict`) matches node's `crypto.verify(null, ...)` /
    // RFC 8032 cofactored equation used by the JS reference (lib/directory.mjs:50).
    let vk = match VerifyingKey::from_bytes(pubkey) {
        Ok(vk) => vk,
        Err(_) => return false,
    };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}

// --------------------------------------------------------------------------
// 4.3 verifyDirectory / 3.4 verifyAnnounce
// --------------------------------------------------------------------------

/// Verify a signed directory against a pinned signer pubkey (spec 4.2/4.3).
///
/// Reference: `lib/directory.mjs:152 verifyDirectory`.
///
/// Checks, in order, returning the FIRST failure's reason code:
/// `no-directory`, `unsigned`, `signer-not-pinned`, `bad-signature`,
/// `bad-onion:<onion[:12]>..:<msg>`, `pubkey-onion-mismatch:<onion[:12]>..`.
/// On success returns `Ok(())`.
pub fn verify_directory(dir: &Directory, pinned_signer_hex: &str) -> Result<()> {
    // Order mirrors lib/directory.mjs:152 verifyDirectory. (`no-directory` — dir not
    // an object — is unrepresentable in the typed Rust struct, so it is elided.)
    let signature_hex = match &dir.signature {
        Some(s) => s,
        None => return Err(Error::Reason("unsigned".into())),
    };
    if let Some(signer) = &dir.signer {
        if !pinned_signer_hex.is_empty()
            && signer.to_lowercase() != pinned_signer_hex.to_lowercase()
        {
            return Err(Error::Reason("signer-not-pinned".into()));
        }
    }

    // Decode pinned signer + signature; any malformed input fails as `bad-signature`
    // (the JS ed25519Verify swallows decode/parse errors and returns false).
    let sig_ok = (|| -> Option<bool> {
        let pk_bytes: [u8; 32] = hex::decode(pinned_signer_hex).ok()?.try_into().ok()?;
        let sig_bytes: [u8; 64] = hex::decode(signature_hex).ok()?.try_into().ok()?;
        Some(ed25519_verify(
            &canonical_directory_bytes(dir),
            &sig_bytes,
            &pk_bytes,
        ))
    })()
    .unwrap_or(false);
    if !sig_ok {
        return Err(Error::Reason("bad-signature".into()));
    }

    for g in &dir.gateways {
        let onion12: String = g.onion.chars().take(12).collect();
        let derived = match onion_to_pubkey(&g.onion) {
            Ok(pk) => pk,
            Err(e) => return Err(Error::Reason(format!("bad-onion:{onion12}..:{e}"))),
        };
        if hex::encode(derived) != g.pubkey.to_lowercase() {
            return Err(Error::Reason(format!("pubkey-onion-mismatch:{onion12}..")));
        }
    }
    Ok(())
}

/// Verify an announce record (spec 3.4).
///
/// Reference: `bootnode/announce.mjs:80 verifyAnnounce`.
///
/// Checks run in the spec-3.4 order; the FIRST failure's reason code is returned
/// (`bad-version:<v>`, `no-onion`, `bad-onion:<msg>`, `stale-ts:<ts>`,
/// `replayed-nonce`, `bad-onion-sig`, `bad-operator-sig`, `not-staked`, ...).
///
/// `now` is unix seconds; `skew` is the freshness window (spec 3.3 default 120).
/// Operator/stake proof (spec 3.2) is out of scope for this signature-only entry
/// and is handled by the client with a chain reader.
pub fn verify_announce(_ann: &Announce, _now: u64, _skew: u64) -> Result<()> {
    // DEFERRED: the individual primitives it composes (onion_to_pubkey,
    // canonical_announce_bytes, ed25519_verify) ARE implemented and conformance-tested.
    // The operator-stake branch (proof 2, spec 3.2) recovers an EIP-191 personal_sign
    // signer over `operator_auth_message` — that needs secp256k1 + Ethereum-address
    // derivation in Rust (deps not yet added). testdata/vectors.json now pins the
    // `operatorAnnounce` vector (fixed test key -> operator + operatorSig) for exactly
    // this future task, so the ECDSA path can be conformance-checked when implemented.
    // Freshness `now`/skew and nonce-replay ordering still have no pass/fail vector.
    // Add those before wiring the ordered reason-code checks, so ordering/reason
    // strings are pinned.
    todo!("T-RUST-2: implement verify_announce (operatorAnnounce vector now exists; needs secp256k1/EIP-191 + freshness/nonce vectors)")
}

// --------------------------------------------------------------------------
// 3.2 operator authorization message (EIP-191 personal_sign target)
// --------------------------------------------------------------------------

/// Build the operator-authorization message string (spec 3.2).
///
/// Reference: `bootnode/announce.mjs:45 operatorAuthMessage`. Durable (no
/// timestamp). `\n` are literal newline bytes; `operator` is lowercased.
///
/// ```text
/// RGOE gateway operator authorization\nonion=<onion>\noperator=<operator-lowercased>
/// ```
///
/// This IS implemented (deterministic, no crypto deps) and is conformance-checked
/// against `testdata/vectors.json` `operatorAuthMessage` in [`tests`].
pub fn operator_auth_message(onion: &str, operator: &str) -> String {
    format!(
        "RGOE gateway operator authorization\nonion={onion}\noperator={}",
        operator.to_lowercase()
    )
}

// --------------------------------------------------------------------------
// 6.2 request signal + target binding
// --------------------------------------------------------------------------

/// Build the RLN request signal that binds a proof to `(target, nonce)` (spec 6.2).
///
/// Reference: `lib/rln.mjs:124 requestSignal`.
///
/// ```text
/// request_signal(target, nonce) = "rgoe:v3\n{target}\n{nonce}"
/// ```
///
/// The circuit public `x` is `calculate_signal_hash(request_signal(target, nonce))`,
/// so a captured proof cannot be redirected to a different target/nonce. This IS
/// implemented (deterministic, no crypto deps) and is conformance-checked in
/// [`tests`].
pub fn request_signal(target: &str, nonce: &str) -> String {
    format!("rgoe:v3\n{target}\n{nonce}")
}

/// `keccak256(utf8(message)) >> 8`, the circuit signal hash (spec 6.2).
///
/// Reference: `lib/rln.mjs:122,:253 calculateSignalHash` (rlnjs `calculateSignalHash`,
/// `BigInt(keccak256(utf8(signal))) >> 8n`). Deterministic. Returned as the decimal-string
/// field element `x`, the value `verifyEnvelope`'s target-binding check compares against
/// `ps.x` (`target-not-bound`, spec 6.4 row 2b).
///
/// Semantics (verified against `testdata/vectors.json` `signalHash.signalHashDecimal`):
/// take the 32-byte Keccak-256 digest of the UTF-8 message as a BIG-ENDIAN unsigned
/// integer, shift right by 8 bits (drop the least-significant byte), render decimal.
/// `Keccak256` here is Ethereum/rlnjs keccak (the original padding), NOT NIST `Sha3_256`.
pub fn calculate_signal_hash(message: &str) -> String {
    let digest = Keccak256::digest(message.as_bytes()); // 32 bytes, big-endian
    let x = BigUint::from_bytes_be(&digest) >> 8u32; // drop least-significant byte
    x.to_str_radix(10)
}

/// Bounds check for a signal field before hashing (spec 6.3).
///
/// Reference: `lib/rln.mjs:132 signalFieldSafe`. True iff `s` is non-empty, at most
/// `max_len` chars, and contains no `\n` or `\r`. In `verifyEnvelope` the client
/// calls this with `max_len = 256` for `target` and `128` for `nonce` BEFORE
/// hashing, so no crafted delimiter or oversized field can collide two distinct
/// `(target, nonce)` pairs to one signal.
pub fn signal_field_safe(s: &str, max_len: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max_len && !s.contains(['\n', '\r'])
}

// --------------------------------------------------------------------------
// Signed egress success receipt (T-FEAT-13)
// --------------------------------------------------------------------------
//
// Reference: `lib/receipt.mjs`. After a gateway SUCCESSFULLY proxies a request it
// returns a small receipt signed by its onion-control key attesting "I (this onion)
// served a request at epoch E". A client holding the gateway's directory pubkey can
// verify it offline (the onion IS the ed25519 pubkey, so it is self-authenticating).
// The signed bytes are prefixed with a receipt-only domain tag so a receipt signature
// can never be confused with an announce/directory signature by the same onion key.
// Conformance targets (byte-pinned): `testdata/vectors.json` `receipt` block —
// `receiptDomain`, `canonicalReceiptBytesHex`, `receiptOnionSig`.

/// Receipt schema version (`lib/receipt.mjs:50 RECEIPT_VERSION`).
pub const RECEIPT_VERSION: u64 = 1;

/// Receipt-only domain tag prepended to the signed bytes
/// (`lib/receipt.mjs:55 RECEIPT_DOMAIN`). The trailing `\n` is a literal newline byte.
pub const RECEIPT_DOMAIN: &str = "RGOE egress success receipt v1\n";

/// A signed egress-success receipt (`lib/receipt.mjs`).
///
/// `epoch` is a canonical non-negative decimal string (the coarse RLN epoch bucket,
/// normalized via `String(epoch)` in the JS reference); `sig` is the lowercase-hex
/// 64-byte ed25519 signature by the onion key over [`canonical_receipt_bytes`].
#[derive(Debug, Clone)]
pub struct Receipt {
    /// `== RECEIPT_VERSION` (1).
    pub v: u64,
    /// the GATEWAY's own v3 `.onion` address (with suffix); self-authenticating.
    pub onion: String,
    /// coarse epoch bucket, canonical decimal string (e.g. `"8333"`).
    pub epoch: String,
    /// success flag; a valid receipt has `ok == true`.
    pub ok: bool,
    /// lowercase-hex 64-byte ed25519 signature by the onion key. `None` == unsigned.
    pub sig: Option<String>,
}

/// A verified receipt: the gateway onion, its recovered ed25519 pubkey, and the epoch.
#[derive(Debug, Clone)]
pub struct VerifiedReceipt {
    /// the receipt's `.onion` (as presented).
    pub onion: String,
    /// the ed25519 pubkey recovered from `onion` (the key that signed it).
    pub pubkey: [u8; 32],
    /// the receipt's epoch decimal string.
    pub epoch: String,
}

/// Canonical signed bytes of a receipt (`lib/receipt.mjs:61 canonicalReceiptBytes`).
///
/// `utf8(RECEIPT_DOMAIN) || utf8(JSON.stringify({ v, onion, epoch, ok }))` in exactly
/// that fixed key order, no whitespace. `epoch` is a decimal string; `ok` is the literal
/// boolean. Hand-built in fixed key order (NOT via a serializer), matching
/// `JSON.stringify` byte-for-byte — see `testdata/vectors.json` `canonicalReceiptBytesHex`.
pub fn canonical_receipt_bytes(v: u64, onion: &str, epoch: &str, ok: bool) -> Vec<u8> {
    let mut s = String::from(RECEIPT_DOMAIN);
    s.push_str("{\"v\":");
    s.push_str(&v.to_string());
    s.push_str(",\"onion\":");
    push_json_string(&mut s, onion);
    s.push_str(",\"epoch\":");
    push_json_string(&mut s, epoch);
    s.push_str(",\"ok\":");
    s.push_str(if ok { "true" } else { "false" });
    s.push('}');
    s.into_bytes()
}

/// True iff `s` is a canonical non-negative decimal (`^(0|[1-9][0-9]*)$`), matching the
/// epoch guard in `lib/receipt.mjs:109` (no float / hex / leading-zero ambiguity).
fn is_canonical_decimal(s: &str) -> bool {
    match s.as_bytes() {
        [] => false,
        [b'0'] => true,
        [first, rest @ ..] => {
            first.is_ascii_digit() && *first != b'0' && rest.iter().all(u8::is_ascii_digit)
        }
    }
}

/// Strip a trailing lowercase `.onion` then lowercase — matches the JS
/// `String(o).replace(/\.onion$/, "").toLowerCase()` used for the onion-match compare
/// (`lib/receipt.mjs:94`; the suffix strip is case-sensitive, the lowercasing follows).
fn strip_onion(o: &str) -> String {
    o.strip_suffix(".onion").unwrap_or(o).to_lowercase()
}

/// Verify a receipt (`lib/receipt.mjs:88 verifyReceipt`).
///
/// Checks run in the JS order, returning the FIRST failure's reason code verbatim:
/// `bad-version:<v>`, `not-success`, `onion-mismatch`, `bad-onion:<msg>`, `bad-epoch`,
/// `stale-epoch:<epoch>`, `bad-sig`. On success returns the recovered pubkey/onion/epoch.
///
/// - `onion`: if `Some`, the receipt's onion MUST equal it (bind the receipt to the
///   gateway the client dialed) — compared after suffix-strip + lowercase.
/// - `epoch`: if `Some`, the receipt's epoch must be within `epoch_skew` of it, so a
///   stale receipt is not counted as fresh liveness. `None` skips the freshness check.
/// - `epoch_skew`: max `|epoch - rec.epoch|` accepted (JS default 1).
///
/// (The JS `no-receipt` / `no-onion` type guards are unrepresentable in the typed Rust
/// struct — `rec` is always a `Receipt` with a `String` onion — and are elided, exactly
/// as [`verify_directory`] elides `no-directory`.)
pub fn verify_receipt(
    rec: &Receipt,
    onion: Option<&str>,
    epoch: Option<&str>,
    epoch_skew: u64,
) -> Result<VerifiedReceipt> {
    if rec.v != RECEIPT_VERSION {
        return Err(Error::Reason(format!("bad-version:{}", rec.v)));
    }
    if !rec.ok {
        return Err(Error::Reason("not-success".into()));
    }
    if let Some(want) = onion {
        if strip_onion(&rec.onion) != strip_onion(want) {
            return Err(Error::Reason("onion-mismatch".into()));
        }
    }
    // Recover the ed25519 key the (checksummed) v3 address commits to; malformed => bad-onion.
    let pubkey = match onion_to_pubkey(&rec.onion) {
        Ok(pk) => pk,
        Err(e) => return Err(Error::Reason(format!("bad-onion:{e}"))),
    };
    // epoch must be a canonical non-negative decimal string (signed-bytes stability).
    if !is_canonical_decimal(&rec.epoch) {
        return Err(Error::Reason("bad-epoch".into()));
    }
    if let Some(cur) = epoch {
        match (
            BigUint::parse_bytes(rec.epoch.as_bytes(), 10),
            BigUint::parse_bytes(cur.as_bytes(), 10),
        ) {
            (Some(rec_ep), Some(cur_ep)) => {
                let diff = if rec_ep > cur_ep {
                    &rec_ep - &cur_ep
                } else {
                    &cur_ep - &rec_ep
                };
                if diff > BigUint::from(epoch_skew) {
                    return Err(Error::Reason(format!("stale-epoch:{}", rec.epoch)));
                }
            }
            // JS BigInt(String(epoch)) throw path => bad-epoch (e.g. a non-numeric `epoch` arg).
            _ => return Err(Error::Reason("bad-epoch".into())),
        }
    }
    // The signature must verify under the key the onion address commits to.
    let sig_hex = match &rec.sig {
        Some(s) => s,
        None => return Err(Error::Reason("bad-sig".into())),
    };
    let sig_ok = (|| -> Option<bool> {
        let sig: [u8; 64] = hex::decode(sig_hex).ok()?.try_into().ok()?;
        Some(ed25519_verify(
            &canonical_receipt_bytes(rec.v, &rec.onion, &rec.epoch, rec.ok),
            &sig,
            &pubkey,
        ))
    })()
    .unwrap_or(false);
    if !sig_ok {
        return Err(Error::Reason("bad-sig".into()));
    }
    Ok(VerifiedReceipt {
        onion: rec.onion.clone(),
        pubkey,
        epoch: rec.epoch.clone(),
    })
}

/// Sign a receipt with the onion seed (`lib/receipt.mjs:72 buildReceipt`). Convenience for
/// tests / a gateway port: returns the 64-byte ed25519 signature over the canonical bytes.
pub fn sign_receipt(v: u64, onion: &str, epoch: &str, ok: bool, onion_seed: &[u8; 32]) -> [u8; 64] {
    ed25519_sign(&canonical_receipt_bytes(v, onion, epoch, ok), onion_seed)
}

// --------------------------------------------------------------------------
// Protocol / envelope version negotiation (T-FEAT-11)
// --------------------------------------------------------------------------
//
// Reference: `gateway/gateway.mjs` (`PROTO_MIN`/`PROTO_MAX`/`acceptEnvelopeVersion`/
// `versionRepr`) + `client/rgoe-client.mjs` (`CLIENT_PROTO_*`/`selectProtoVersion`).
// See docs/PROTOCOL-VERSIONING.md. The bounded reason LABELS are byte-pinned in
// `testdata/vectors.json` `protoReasons`; the full runtime reason strings additionally
// carry the offending version/ranges, which are context-dependent and NOT pinned.

/// Lowest envelope version this build can emit/parse (`PROTO_MIN`/`CLIENT_PROTO_MIN` = 3).
pub const PROTO_MIN: u64 = 3;
/// Highest envelope version this build can emit/parse (`PROTO_MAX`/`CLIENT_PROTO_MAX` = 3).
pub const PROTO_MAX: u64 = 3;

/// The pre-negotiation wire version an envelope with NO `v` field is treated as
/// (`gateway/gateway.mjs:269 LEGACY_ENVELOPE_VERSION` = 3).
pub const LEGACY_ENVELOPE_VERSION: u64 = 3;

/// Bounded reason label for a non-integer / garbage version (`protoReasons.badVersion`).
pub const REASON_BAD_VERSION: &str = "bad-version";
/// Bounded reason label for a well-formed integer version out of range
/// (`protoReasons.unsupportedVersion`).
pub const REASON_UNSUPPORTED_VERSION: &str = "unsupported-version";
/// Bounded reason prefix for disjoint client/gateway ranges (`protoReasons.noMutualVersion`).
pub const REASON_NO_MUTUAL_VERSION: &str = "no-mutual-version";

/// The `v` field of an envelope, classified WITHOUT reading any other field, mirroring
/// how JS treats a dynamically-typed value in `acceptEnvelopeVersion` (`gateway/gateway.mjs:278`).
///
/// A serde-free enum so `rgoe-proto` stays off serde: the untrusted-JSON → enum mapping
/// (and the `versionRepr` string) lives in the client, which owns serde.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeVersion {
    /// no `v` field (or JSON `null`): the pre-negotiation v3 wire.
    Absent,
    /// a well-formed integer version.
    Int(i64),
    /// a non-integer `v` (string, float, bool, object): garbage. Carries a short, safe
    /// repr for the reason string (the JS `versionRepr` output).
    Garbage(String),
}

/// Decide whether an envelope of version `v` can be parsed, reading only `v`
/// (`gateway/gateway.mjs:278 acceptEnvelopeVersion`). Returns the accepted version, or the
/// FIRST failure's reason code: `unsupported-version:<v>` (integer out of range) or
/// `bad-version:<repr>` (non-integer). `range` is the gateway's `(min, max)`; the reason
/// LABEL for metrics is [`REASON_UNSUPPORTED_VERSION`] / [`REASON_BAD_VERSION`].
pub fn accept_envelope_version(v: &EnvelopeVersion, range: (u64, u64)) -> Result<u64> {
    let (min, max) = range;
    match v {
        // Absent == legacy v3, then range-checked like any other (backward compat).
        EnvelopeVersion::Absent => {
            if LEGACY_ENVELOPE_VERSION < min || LEGACY_ENVELOPE_VERSION > max {
                return Err(Error::Reason(format!(
                    "{REASON_UNSUPPORTED_VERSION}:{LEGACY_ENVELOPE_VERSION}"
                )));
            }
            Ok(LEGACY_ENVELOPE_VERSION)
        }
        EnvelopeVersion::Int(n) => {
            if *n < min as i64 || *n > max as i64 {
                return Err(Error::Reason(format!("{REASON_UNSUPPORTED_VERSION}:{n}")));
            }
            Ok(*n as u64)
        }
        EnvelopeVersion::Garbage(repr) => {
            Err(Error::Reason(format!("{REASON_BAD_VERSION}:{repr}")))
        }
    }
}

/// Pick the HIGHEST version both sides support (`client/rgoe-client.mjs:95
/// selectProtoVersion`). `gateway_range` is `Some((min,max))` once learned (from a
/// version-reject advertisement), else `None`.
///
/// - gateway range unknown (`None`): optimistically emit the client's own max.
/// - ranges overlap: `min(client_max, gateway_max)` — the highest both accept.
/// - ranges disjoint: `Err("no-mutual-version:client=<lo>-<hi>,gateway=<lo>-<hi>")`
///   (the caller fails closed BEFORE proving or dialing).
pub fn select_proto_version(
    gateway_range: Option<(u64, u64)>,
    client_range: (u64, u64),
) -> Result<u64> {
    let (c_min, c_max) = client_range;
    let (g_min, g_max) = match gateway_range {
        None => return Ok(c_max), // no advertisement yet: emit our best supported version
        Some(r) => r,
    };
    let hi = c_max.min(g_max); // highest either side will go
    let lo = c_min.max(g_min); // lowest both sides still accept
    if hi < lo {
        return Err(Error::Reason(format!(
            "{REASON_NO_MUTUAL_VERSION}:client={c_min}-{c_max},gateway={g_min}-{g_max}"
        )));
    }
    Ok(hi) // highest mutually supported
}

// --------------------------------------------------------------------------
// Gateway selection (weighted, deterministic under an injected rng)
// --------------------------------------------------------------------------
//
// Reference: `lib/directory.mjs:273 MAX_WEIGHT` / `:274 clampWeight` / `:279 pickGateway`
// / `:296 selectionOrder`. The client bounds gateway-attested weight itself (not just the
// bootnode) so no directory source — including a static or compromised-signer one — can
// concentrate a member's traffic on one gateway (a deanonymization lever).

/// Max selection weight the client will honor (`lib/directory.mjs:273 MAX_WEIGHT`).
pub const MAX_WEIGHT: f64 = 1000.0;

/// Clamp a gateway's attested weight (`lib/directory.mjs:274 clampWeight`).
///
/// `weight = Number(g.weight)`: absent/`NaN`/non-finite => `1`; negative => floored at `0`;
/// anything huge => capped at [`MAX_WEIGHT`]. `None` models the JS `undefined` (absent field).
pub fn clamp_weight(weight: Option<f64>) -> f64 {
    match weight {
        // w is guarded finite and 0.0 < MAX_WEIGHT, so clamp is total here (mirrors the JS
        // `Math.max(0, Math.min(MAX_WEIGHT, w))`).
        Some(w) if w.is_finite() => w.clamp(0.0, MAX_WEIGHT),
        _ => 1.0,
    }
}

/// The (clamped) weights of the pool `pick_gateway`/`selection_order` draw from, in the
/// same order and with the same healthy/down fallback. Shared by both so the two never drift.
fn selection_pool<'a>(dir: &'a Directory, exclude: &HashSet<String>) -> Vec<&'a GatewayEntry> {
    let all: Vec<&GatewayEntry> = dir
        .gateways
        .iter()
        .filter(|g| !exclude.contains(&g.onion))
        .collect();
    if all.is_empty() {
        return all;
    }
    let healthy: Vec<&GatewayEntry> = all.iter().copied().filter(|g| g.health != "down").collect();
    // last resort: if every remaining gateway is "down", still try one.
    if healthy.is_empty() {
        all
    } else {
        healthy
    }
}

/// Weighted-random pick of one gateway (`lib/directory.mjs:279 pickGateway`).
///
/// `exclude` is a set of already-tried onions; `rng` yields a value in `[0, 1)` (injectable
/// so selection is deterministic in tests, mirroring the JS `{ rng }` option). Returns `None`
/// only when every gateway is excluded. When the total clamped weight is `0`, falls back to a
/// uniform pick over the pool (matching the JS `total <= 0` branch).
pub fn pick_gateway<'a>(
    dir: &'a Directory,
    exclude: &HashSet<String>,
    rng: &mut dyn FnMut() -> f64,
) -> Option<&'a GatewayEntry> {
    let pool = selection_pool(dir, exclude);
    if pool.is_empty() {
        return None;
    }
    let total: f64 = pool
        .iter()
        .map(|g| clamp_weight(Some(g.weight as f64)))
        .sum();
    if total <= 0.0 {
        let idx = (rng() * pool.len() as f64).floor() as usize;
        return Some(pool[idx.min(pool.len() - 1)]);
    }
    let mut r = rng() * total;
    for g in &pool {
        r -= clamp_weight(Some(g.weight as f64));
        if r < 0.0 {
            return Some(g);
        }
    }
    Some(pool[pool.len() - 1])
}

/// Full weighted failover order (`lib/directory.mjs:296 selectionOrder`): the weighted pick
/// first, then the rest of the fleet in weighted order, so the client can walk the list on
/// dial timeout. `rng` is injected (deterministic in tests).
pub fn selection_order<'a>(
    dir: &'a Directory,
    rng: &mut dyn FnMut() -> f64,
) -> Vec<&'a GatewayEntry> {
    let mut order = Vec::new();
    let mut exclude: HashSet<String> = HashSet::new();
    while let Some(g) = pick_gateway(dir, &exclude, rng) {
        order.push(g);
        exclude.insert(g.onion.clone());
    }
    order
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Conformance: `request_signal` must match spec 6.2 exactly.
    /// (Full fixture-file conformance runner lands in T-RUST-1.)
    #[test]
    fn request_signal_matches_spec() {
        let target = "example.com:443";
        let nonce = "abcdef0123456789abcdef0123456789";
        assert_eq!(
            request_signal(target, nonce),
            "rgoe:v3\nexample.com:443\nabcdef0123456789abcdef0123456789"
        );
        // Delimiters are literal newlines (0x0a), not escaped.
        assert_eq!(request_signal("t", "n"), "rgoe:v3\nt\nn");
    }

    /// Conformance: `operator_auth_message` against testdata/vectors.json.
    #[test]
    fn operator_auth_message_lowercases_operator() {
        // From testdata/vectors.json (mixed-case operator input -> lowercased).
        let onion = "ucnkl5d2m5myal7zkx4nyljkcss4thjdx2l7qzasp74tqncvutypp3ad.onion";
        let got = operator_auth_message(onion, "0x000000000000000000000000000000000000dEaD");
        let want = "RGOE gateway operator authorization\n\
                    onion=ucnkl5d2m5myal7zkx4nyljkcss4thjdx2l7qzasp74tqncvutypp3ad.onion\n\
                    operator=0x000000000000000000000000000000000000dead";
        assert_eq!(got, want);
    }

    /// `signal_field_safe` bounds (spec 6.3).
    #[test]
    fn signal_field_safe_bounds() {
        assert!(signal_field_safe("ok", 256));
        assert!(!signal_field_safe("", 256)); // empty
        assert!(!signal_field_safe("abc", 2)); // too long
        assert!(!signal_field_safe("a\nb", 256)); // newline
        assert!(!signal_field_safe("a\rb", 256)); // carriage return
    }

    // -- clamp_weight (lib/directory.mjs:274) ------------------------------

    #[test]
    fn clamp_weight_matches_js_semantics() {
        assert_eq!(clamp_weight(Some(100.0)), 100.0); // in range unchanged
        assert_eq!(clamp_weight(None), 1.0); // absent/undefined -> 1
        assert_eq!(clamp_weight(Some(f64::NAN)), 1.0); // NaN -> 1
        assert_eq!(clamp_weight(Some(f64::INFINITY)), 1.0); // non-finite -> 1
        assert_eq!(clamp_weight(Some(-5.0)), 0.0); // negative floors at 0
        assert_eq!(clamp_weight(Some(50_000.0)), MAX_WEIGHT); // huge caps at MAX_WEIGHT
        assert_eq!(clamp_weight(Some(MAX_WEIGHT)), MAX_WEIGHT); // exactly the cap
    }

    // -- weighted selection distribution (seeded rng) ----------------------

    /// mulberry32 — the same tiny seedable PRNG the JS test suite uses, so selection is
    /// deterministic here with zero extra dependency (no `rand`). Yields `f64` in `[0,1)`.
    fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
        let mut a = seed;
        move || {
            a = a.wrapping_add(0x6D2B_79F5);
            let mut t = a;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            (((t ^ (t >> 14)) as f64) / 4_294_967_296.0).fract()
        }
    }

    fn gw(onion: &str, weight: u64, health: &str) -> GatewayEntry {
        GatewayEntry {
            onion: onion.to_string(),
            pubkey: String::new(),
            weight,
            health: health.to_string(),
            operator: None,
            staked: None,
        }
    }

    #[test]
    fn pick_gateway_long_run_matches_weight_ratios() {
        // Weights 100 / 200 / 700 (sum 1000) => expected selection shares 0.1 / 0.2 / 0.7.
        let dir = Directory {
            version: 1,
            issued: 0,
            gateways: vec![gw("a", 100, "up"), gw("b", 200, "up"), gw("c", 700, "up")],
            signer: None,
            signature: None,
        };
        let mut rng = mulberry32(12345);
        let empty = HashSet::new();
        let n = 60_000;
        let mut counts = [0usize; 3];
        for _ in 0..n {
            let g = pick_gateway(&dir, &empty, &mut rng).unwrap();
            let i = match g.onion.as_str() {
                "a" => 0,
                "b" => 1,
                _ => 2,
            };
            counts[i] += 1;
        }
        let share = |c: usize| c as f64 / n as f64;
        // Long-run frequencies match the weight ratios within a loose tolerance.
        assert!(
            (share(counts[0]) - 0.1).abs() < 0.02,
            "a share {}",
            share(counts[0])
        );
        assert!(
            (share(counts[1]) - 0.2).abs() < 0.02,
            "b share {}",
            share(counts[1])
        );
        assert!(
            (share(counts[2]) - 0.7).abs() < 0.02,
            "c share {}",
            share(counts[2])
        );
    }

    #[test]
    fn pick_gateway_clamps_runaway_weight() {
        // A directory that tries to concentrate all traffic on `b` with weight 1e9 is
        // clamped to MAX_WEIGHT, so `a` (weight 1000) still gets ~half the picks.
        let dir = Directory {
            version: 1,
            issued: 0,
            gateways: vec![gw("a", 1000, "up"), gw("b", 1_000_000_000, "up")],
            signer: None,
            signature: None,
        };
        let mut rng = mulberry32(999);
        let empty = HashSet::new();
        let mut a = 0usize;
        let n = 40_000;
        for _ in 0..n {
            if pick_gateway(&dir, &empty, &mut rng).unwrap().onion == "a" {
                a += 1;
            }
        }
        let share = a as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.03, "clamped share {share}");
    }

    #[test]
    fn selection_order_prefers_healthy_and_covers_all() {
        let dir = Directory {
            version: 1,
            issued: 0,
            gateways: vec![
                gw("up1", 100, "up"),
                gw("down1", 100, "down"),
                gw("up2", 100, "up"),
            ],
            signer: None,
            signature: None,
        };
        let mut rng = mulberry32(7);
        let order = selection_order(&dir, &mut rng);
        // every gateway appears exactly once.
        assert_eq!(order.len(), 3);
        // the two healthy gateways are ordered before the "down" one (down is last resort).
        assert_eq!(order[2].onion, "down1");
        assert!(order[0].onion.starts_with("up"));
        assert!(order[1].onion.starts_with("up"));
    }

    // -- version negotiation (gateway.mjs / rgoe-client.mjs) ---------------

    #[test]
    fn accept_envelope_version_branches() {
        let range = (PROTO_MIN, PROTO_MAX); // {3}
                                            // absent -> legacy v3, accepted while range includes 3.
        assert_eq!(
            accept_envelope_version(&EnvelopeVersion::Absent, range).unwrap(),
            3
        );
        // in-range integer accepted.
        assert_eq!(
            accept_envelope_version(&EnvelopeVersion::Int(3), range).unwrap(),
            3
        );
        // out-of-range integer -> unsupported-version:<v>.
        assert_eq!(
            accept_envelope_version(&EnvelopeVersion::Int(4), range)
                .unwrap_err()
                .to_string(),
            "unsupported-version:4"
        );
        // non-integer -> bad-version:<repr>.
        assert_eq!(
            accept_envelope_version(&EnvelopeVersion::Garbage("\"3\"".into()), range)
                .unwrap_err()
                .to_string(),
            "bad-version:\"3\""
        );
    }

    #[test]
    fn select_proto_version_branches() {
        let client = (PROTO_MIN, PROTO_MAX); // {3}
                                             // unknown gateway range -> client max.
        assert_eq!(select_proto_version(None, client).unwrap(), 3);
        // overlap -> highest mutual.
        assert_eq!(select_proto_version(Some((1, 3)), (1, 3)).unwrap(), 3);
        assert_eq!(select_proto_version(Some((2, 5)), (1, 3)).unwrap(), 3);
        // disjoint -> fail closed.
        let err = select_proto_version(Some((5, 6)), (1, 2))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "no-mutual-version:client=1-2,gateway=5-6");
    }
}
