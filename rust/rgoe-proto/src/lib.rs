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

use std::fmt;

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
pub fn onion_to_pubkey(_onion: &str) -> Result<[u8; 32]> {
    // T-RUST-1: base32 no-pad decode, split 32|2|1, SHA3-256 checksum, version 0x03.
    todo!("T-RUST-1: implement onion_to_pubkey per docs/PROTOCOL-API.md section 2")
}

/// Encode a 32-byte ed25519 public key as a v3 `.onion` address (with suffix).
///
/// Reference: `lib/directory.mjs:114 pubkeyToOnion` (spec 2). Inverse of
/// [`onion_to_pubkey`]. The address string is 56 base32 no-pad lowercase chars.
pub fn pubkey_to_onion(_pubkey: &[u8; 32]) -> String {
    // T-RUST-1: build pubkey||checksum||0x03, base32 no-pad lowercase, append ".onion".
    todo!("T-RUST-1: implement pubkey_to_onion per docs/PROTOCOL-API.md section 2")
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
pub fn canonical_announce_bytes(_ann: &Announce) -> Vec<u8> {
    // T-RUST-1: emit {"v":..,"onion":"..","weight":..,"ts":..,"nonce":".."} as utf8.
    todo!("T-RUST-1: implement canonical_announce_bytes per docs/PROTOCOL-API.md section 1.1")
}

/// Canonical signed bytes of a directory (spec 1.2).
///
/// Reference: `lib/directory.mjs:129 canonicalDirectoryBytes`.
///
/// `utf8(JSON.stringify({ version, issued, gateways: [{ onion, pubkey, weight,
/// health }, ...] }))`. Only those four gateway fields, in that order, are covered;
/// top-level `signer`/`signature` and per-gateway `operator`/`staked` are EXCLUDED.
/// Hand-build the bytes in fixed key order (see [`canonical_announce_bytes`]).
pub fn canonical_directory_bytes(_dir: &Directory) -> Vec<u8> {
    // T-RUST-1: emit {"version":..,"issued":..,"gateways":[{"onion":..,"pubkey":..,
    //           "weight":..,"health":".."}]} as utf8, byte-matching JSON.stringify.
    todo!("T-RUST-1: implement canonical_directory_bytes per docs/PROTOCOL-API.md section 1.2")
}

// --------------------------------------------------------------------------
// 3. ed25519 primitives (RFC 8032, null digest, raw 32-byte seed/pubkey)
// --------------------------------------------------------------------------

/// Derive the raw 32-byte ed25519 public key from a 32-byte seed.
///
/// Reference: `lib/directory.mjs ed25519PublicKey`. Deterministic (RFC 8032).
/// Conformance: `testdata/vectors.json` `signerSeed -> signerPub`,
/// `onionSeed -> onionPub`.
pub fn ed25519_public_key(_seed: &[u8; 32]) -> [u8; 32] {
    // T-RUST-1: ed25519-dalek SigningKey::from_bytes(seed).verifying_key().
    todo!("T-RUST-1: implement ed25519_public_key")
}

/// ed25519 sign `msg` with a raw 32-byte seed (RFC 8032, deterministic).
///
/// Reference: `lib/directory.mjs:46 ed25519Sign` = `crypto.sign(null, msg, key)`.
/// Returns the 64-byte signature. Conformance targets: `directorySignature`,
/// `announceOnionSig` in `testdata/vectors.json`.
pub fn ed25519_sign(_msg: &[u8], _seed: &[u8; 32]) -> [u8; 64] {
    // T-RUST-1: ed25519-dalek SigningKey::from_bytes(seed).sign(msg).
    todo!("T-RUST-1: implement ed25519_sign")
}

/// Verify a 64-byte ed25519 signature over `msg` against a raw 32-byte pubkey.
///
/// Reference: `lib/directory.mjs ed25519Verify`. Used by [`verify_directory`] and
/// the announce onion-control check.
pub fn ed25519_verify(_msg: &[u8], _sig: &[u8; 64], _pubkey: &[u8; 32]) -> bool {
    // T-RUST-1: ed25519-dalek VerifyingKey::from_bytes(pubkey).verify(msg, sig).is_ok().
    todo!("T-RUST-1: implement ed25519_verify")
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
pub fn verify_directory(_dir: &Directory, _pinned_signer_hex: &str) -> Result<()> {
    // T-RUST-2: run checks in the spec-4.3 order; re-derive each pubkey via
    //           onion_to_pubkey; verify signature over canonical_directory_bytes.
    todo!("T-RUST-2: implement verify_directory per docs/PROTOCOL-API.md section 4.3")
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
    // T-RUST-2: onion_to_pubkey -> freshness -> nonce replay -> verify onion_sig
    //           over canonical_announce_bytes. Operator/stake proof: separate.
    todo!("T-RUST-2: implement verify_announce per docs/PROTOCOL-API.md section 3.4")
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
/// Reference: `lib/rln.mjs:122,:253 calculateSignalHash`. Deterministic. Returned
/// as the decimal-string field element `x` matched by [`verify_directory`]'s sibling
/// envelope check (`target-not-bound`, spec 6.4 row 2b).
pub fn calculate_signal_hash(_message: &str) -> String {
    // T-RUST-1: keccak256(message) as big-endian uint, >> 8, formatted decimal.
    todo!("T-RUST-1: implement calculate_signal_hash per docs/PROTOCOL-API.md section 6.2")
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
}
