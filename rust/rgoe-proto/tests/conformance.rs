//! Wire-format conformance harness (T-RUST-1).
//!
//! Reads the byte-pinned golden fixtures in `testdata/vectors.json` (the same file
//! the JS reference produced) and asserts the Rust deterministic primitives in
//! `rgoe-proto` reproduce every pinned value exactly. Where a value is byte-pinned
//! the assertion is byte/hex equality; ed25519 verify additionally checks a flipped
//! bit is rejected.
//!
//! Only the functions with a vector in the fixture are exercised here. Functions
//! deferred for lack of a vector (`calculate_signal_hash`, `verify_announce`) are
//! documented stubs in `src/lib.rs` and intentionally NOT called.

use rgoe_proto::{
    canonical_announce_bytes, canonical_directory_bytes, ed25519_public_key, ed25519_sign,
    ed25519_verify, onion_to_pubkey, operator_auth_message, pubkey_to_onion, request_signal,
    verify_directory, Announce, Directory, GatewayEntry,
};
use serde_json::Value;

/// Load `testdata/vectors.json` relative to this crate's manifest dir.
fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/vectors.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&raw).expect("vectors.json is valid JSON")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("vector field {k} missing or not a string"))
}

fn seed32(hexstr: &str) -> [u8; 32] {
    hex::decode(hexstr).unwrap().try_into().unwrap()
}

fn pub32(hexstr: &str) -> [u8; 32] {
    hex::decode(hexstr).unwrap().try_into().unwrap()
}

/// Build the exact directory the fixture's `canonicalDirectoryBytesHex` /
/// `directorySignature` were produced over (spec 9 table): version 1, issued
/// 1000000, one gateway { onion, pubkey: onionPub, weight: 100, health: "up" }.
fn vector_directory(v: &Value) -> Directory {
    Directory {
        version: 1,
        issued: 1_000_000,
        gateways: vec![GatewayEntry {
            onion: s(v, "onion").to_string(),
            pubkey: s(v, "onionPub").to_string(),
            weight: 100,
            health: "up".to_string(),
            operator: None,
            staked: None,
        }],
        signer: Some(s(v, "signerPub").to_string()),
        signature: Some(s(v, "directorySignature").to_string()),
    }
}

/// Build the announce record from the fixture's `announce` object.
fn vector_announce(v: &Value) -> Announce {
    let a = &v["announce"];
    Announce {
        v: a["v"].as_u64().unwrap(),
        onion: a["onion"].as_str().unwrap().to_string(),
        weight: a["weight"].as_u64().unwrap(),
        ts: a["ts"].as_u64().unwrap(),
        nonce: a["nonce"].as_str().unwrap().to_string(),
        onion_sig: Some(s(v, "announceOnionSig").to_string()),
        operator: None,
        operator_sig: None,
    }
}

// -- 1. onion <-> pubkey (spec 2) ------------------------------------------

#[test]
fn onion_to_pubkey_matches_vector() {
    let v = vectors();
    let derived = onion_to_pubkey(s(&v, "onion")).expect("valid v3 onion");
    assert_eq!(hex::encode(derived), s(&v, "onionPub"));
}

#[test]
fn pubkey_to_onion_matches_vector() {
    let v = vectors();
    let onion = pubkey_to_onion(&pub32(s(&v, "onionPub")));
    assert_eq!(onion, s(&v, "onion"));
}

#[test]
fn onion_roundtrip_and_checksum_rejects_tamper() {
    let v = vectors();
    let pk = pub32(s(&v, "onionPub"));
    // round trip pubkey -> onion -> pubkey
    assert_eq!(onion_to_pubkey(&pubkey_to_onion(&pk)).unwrap(), pk);
    // flip one base32 char in the address body => checksum mismatch (or version).
    let onion = s(&v, "onion");
    let mut chars: Vec<char> = onion.strip_suffix(".onion").unwrap().chars().collect();
    chars[0] = if chars[0] == 'a' { 'b' } else { 'a' };
    let tampered: String = chars.into_iter().collect::<String>() + ".onion";
    assert!(onion_to_pubkey(&tampered).is_err(), "tampered onion must fail");
    // wrong length.
    assert!(onion_to_pubkey("abc.onion").is_err());
}

// -- 2. canonical byte encodings (spec 1) ----------------------------------

#[test]
fn canonical_directory_bytes_matches_vector() {
    let v = vectors();
    let bytes = canonical_directory_bytes(&vector_directory(&v));
    assert_eq!(hex::encode(&bytes), s(&v, "canonicalDirectoryBytesHex"));
}

#[test]
fn canonical_announce_bytes_matches_vector() {
    let v = vectors();
    let bytes = canonical_announce_bytes(&vector_announce(&v));
    assert_eq!(hex::encode(&bytes), s(&v, "canonicalAnnounceBytesHex"));
}

// -- 3. ed25519 key derivation + sign/verify (spec 6.5) --------------------

#[test]
fn ed25519_public_key_matches_vectors() {
    let v = vectors();
    assert_eq!(
        hex::encode(ed25519_public_key(&seed32(s(&v, "signerSeed")))),
        s(&v, "signerPub")
    );
    assert_eq!(
        hex::encode(ed25519_public_key(&seed32(s(&v, "onionSeed")))),
        s(&v, "onionPub")
    );
}

#[test]
fn ed25519_sign_matches_pinned_signatures() {
    let v = vectors();
    let dir_bytes = canonical_directory_bytes(&vector_directory(&v));
    assert_eq!(
        hex::encode(ed25519_sign(&dir_bytes, &seed32(s(&v, "signerSeed")))),
        s(&v, "directorySignature")
    );
    let ann_bytes = canonical_announce_bytes(&vector_announce(&v));
    assert_eq!(
        hex::encode(ed25519_sign(&ann_bytes, &seed32(s(&v, "onionSeed")))),
        s(&v, "announceOnionSig")
    );
}

#[test]
fn ed25519_verify_accepts_pinned_and_rejects_flipped_bit() {
    let v = vectors();

    // directory signature verifies under signerPub
    let dir_bytes = canonical_directory_bytes(&vector_directory(&v));
    let dir_sig: [u8; 64] = hex::decode(s(&v, "directorySignature"))
        .unwrap()
        .try_into()
        .unwrap();
    assert!(ed25519_verify(&dir_bytes, &dir_sig, &pub32(s(&v, "signerPub"))));

    // announce onion signature verifies under onionPub
    let ann_bytes = canonical_announce_bytes(&vector_announce(&v));
    let ann_sig: [u8; 64] = hex::decode(s(&v, "announceOnionSig"))
        .unwrap()
        .try_into()
        .unwrap();
    assert!(ed25519_verify(&ann_bytes, &ann_sig, &pub32(s(&v, "onionPub"))));

    // a flipped signature bit must be rejected
    let mut bad_sig = dir_sig;
    bad_sig[0] ^= 0x01;
    assert!(!ed25519_verify(&dir_bytes, &bad_sig, &pub32(s(&v, "signerPub"))));

    // a flipped message bit must be rejected
    let mut bad_msg = dir_bytes.clone();
    bad_msg[0] ^= 0x01;
    assert!(!ed25519_verify(&bad_msg, &dir_sig, &pub32(s(&v, "signerPub"))));
}

// -- 4. verify_directory (spec 4.3) ----------------------------------------

#[test]
fn verify_directory_accepts_pinned_signer() {
    let v = vectors();
    verify_directory(&vector_directory(&v), s(&v, "signerPub"))
        .expect("vector directory must verify under its pinned signer");
}

#[test]
fn verify_directory_rejects_wrong_signer() {
    let v = vectors();
    // Verify under a different valid ed25519 pubkey (the onion key, not the signer).
    let err = verify_directory(&vector_directory(&v), s(&v, "onionPub")).unwrap_err();
    // signer field is signerPub, pinned is onionPub => signer-not-pinned fires first.
    assert_eq!(err.to_string(), "signer-not-pinned");

    // Strip the signer label so the check falls through to the crypto verify.
    let mut dir = vector_directory(&v);
    dir.signer = None;
    let err = verify_directory(&dir, s(&v, "onionPub")).unwrap_err();
    assert_eq!(err.to_string(), "bad-signature");
}

#[test]
fn verify_directory_rejects_grafted_onion() {
    let v = vectors();
    // Graft a different onion under the (still signed) pubkey: the onion<->pubkey
    // binding must reject it. Re-sign so we get PAST bad-signature to the binding check.
    let mut dir = vector_directory(&v);
    // A valid but DIFFERENT onion (derived from the signer key) grafted onto the entry.
    dir.gateways[0].onion = pubkey_to_onion(&pub32(s(&v, "signerPub")));
    let signed_bytes = canonical_directory_bytes(&dir);
    let resig = ed25519_sign(&signed_bytes, &seed32(s(&v, "signerSeed")));
    dir.signature = Some(hex::encode(resig));
    let err = verify_directory(&dir, s(&v, "signerPub")).unwrap_err();
    assert!(
        err.to_string().starts_with("pubkey-onion-mismatch:"),
        "expected pubkey-onion-mismatch, got {err}"
    );

    // Also reject an unsigned directory.
    let mut unsigned = vector_directory(&v);
    unsigned.signature = None;
    assert_eq!(
        verify_directory(&unsigned, s(&v, "signerPub"))
            .unwrap_err()
            .to_string(),
        "unsigned"
    );
}

// -- 5. operator auth message + request signal (deterministic, no crypto) --

#[test]
fn operator_auth_message_matches_vector() {
    let v = vectors();
    let got = operator_auth_message(s(&v, "onion"), s(&v, "operator"));
    assert_eq!(got, s(&v, "operatorAuthMessage"));
}

#[test]
fn request_signal_shape() {
    // No fixture value; assert the documented spec-6.2 shape (literal newlines).
    assert_eq!(request_signal("t", "n"), "rgoe:v3\nt\nn");
}
