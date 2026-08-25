//! `shade-tree` — the Shade Tree distributable client (single static binary with embedded Tor).
//!
//! This is the **deterministic client MVP** (T-RUST-2): it parses UNTRUSTED
//! directory / receipt JSON, then runs the trust-critical checks from `shade-tree-proto`
//! (the Rust port of the JS reference, gated by `testdata/vectors.json`). The two
//! non-deterministic LIVE pieces — the RLN Groth16 proof (T-RUST-2b/2c/2d) and the
//! embedded-Tor onion dial (T-RUST-2e, `arti-client`) — compile only under the
//! `live` cargo feature (see the [`live`] module); the default build stays sub-second.
//!
//! serde/serde_json are used HERE (to parse untrusted JSON into local DTOs) and are
//! deliberately kept out of `shade-tree-proto`, whose canonical byte path is serde-free.
//! See docs/adr/0001-client-language.md and docs/SHIP-PLAN.md T-RUST-2.

use std::collections::HashSet;
use std::process::ExitCode;

use serde::Deserialize;
use shade_tree_proto::{pick_gateway, selection_order, verify_directory, verify_receipt, Receipt};

mod capability;
mod dircache;
mod health;
// The crash-safe K-slot coordinator is used by the `live` egress path; its unit
// tests run on the default build under `test`.
#[cfg(any(feature = "live", test))]
mod slotcursor;

use dircache::DirectoryDto;

const VERSION: &str = env!("CARGO_PKG_VERSION");

// --------------------------------------------------------------------------
// Untrusted-JSON DTOs (serde) -> shade-tree-proto structs (trust-critical checks)
// --------------------------------------------------------------------------
//
// The directory DTO now lives in `dircache` (it owns directory loading + the LKG
// cache). The receipt DTO stays here. Both are UNTRUSTED input: we deserialize
// them, map them into the shade-tree-proto types, and let shade-tree-proto do every
// security-critical decision (onion<->pubkey binding, pinned-signer signature,
// receipt onion binding + sig).

#[derive(Deserialize)]
struct ReceiptDto {
    v: u64,
    onion: String,
    // epoch is a canonical decimal STRING on the wire (lib/receipt.mjs normalizes it);
    // a number here would be a malformed receipt and is surfaced as a parse error.
    epoch: String,
    ok: bool,
    #[serde(default)]
    sig: Option<String>,
}

impl ReceiptDto {
    fn into_proto(self) -> Receipt {
        Receipt {
            v: self.v,
            onion: self.onion,
            epoch: self.epoch,
            ok: self.ok,
            sig: self.sig,
        }
    }
}

// --------------------------------------------------------------------------
// LIVE egress
// --------------------------------------------------------------------------
//
// T-RUST-2d wired the RLN prover + native tree into `shade-tree egress` behind the `live`
// cargo feature; T-RUST-2e adds the embedded-Tor transport. WITH the feature
// (`--features live`), `egress` builds a REAL envelope in Rust and sends it to the gateway
// over EMBEDDED TOR (arti dials the selected `.onion`) by default, with a `--plain-tcp`
// escape hatch that preserves the loop-22 plain-socket path (see the `live` module below).
//
// WITHOUT the feature (the default fast build), `egress` returns this honest error — the
// heavy native deps (ark-circom -> wasmer, arti-client) are only compiled under the feature
// so the deterministic client stays sub-second to build.

/// The `egress` path when the `live` feature is OFF (default): the RLN prover + embedded
/// Tor transport are not compiled in. Kept as an honest, non-hanging error.
#[cfg(not(feature = "live"))]
fn live_egress() -> Result<(), String> {
    Err(
        "live egress needs the `live` cargo feature (RLN prover + native tree + arti Tor \
         transport). Rebuild with `cargo build -p shade-tree-client --features live`. \
         See docs/adr/0001-client-language.md"
            .to_string(),
    )
}

// --------------------------------------------------------------------------
// A tiny seedable PRNG (mulberry32) so `select` is reproducible with `--seed`
// --------------------------------------------------------------------------
//
// Zero-dep on purpose (no `rand` runtime dependency). Same algorithm the JS test suite
// uses. Default seed is derived from the wall clock so an unseeded `select` still varies.

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

fn default_seed() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0x1234_5678)
}

/// Current wall clock in milliseconds (for the LKG max-age guard + health-cache
/// decay/last-seen, both of which are ms like the JS `Date.now()`).
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse an optional `--max-age-ms <n>` into the LKG freshness guard. A default
/// 5-minute skew grace (matching selection.mjs `SHADE_TREE_DIRECTORY_MAX_AGE_SKEW_MS`)
/// is added on top of the bound so a lagging client clock doesn't spuriously reject
/// a just-issued directory.
fn parse_max_age(args: &[String]) -> dircache::MaxAge {
    dircache::MaxAge {
        max_age_ms: take_flag(args, "--max-age-ms").and_then(|s| s.parse::<u64>().ok()),
        skew_ms: take_flag(args, "--max-age-skew-ms")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(5 * 60 * 1000),
    }
}

/// `fetch-directory`: obtain a FRESH directory (from `--file`, or `--bootnode-tcp`
/// over plain HTTP), verify it against the pinned signer, apply the rollback +
/// optional max-age guards against the last-known-good cache, write the cache, and
/// print a summary. This is the default-build, no-Tor path that proves the
/// discovery -> verify -> LKG-cache chain; the `live` egress `--bootnode-onion`
/// reuses the same dircache machinery over embedded Tor.
fn cmd_fetch_directory(args: &[String]) -> ExitCode {
    let Some(signer) = take_flag(args, "--signer") else {
        eprintln!("fetch-directory: missing --signer <hex>");
        return ExitCode::from(2);
    };
    let cache = take_flag(args, "--cache").map(std::path::PathBuf::from);
    let max_age = parse_max_age(args);

    // Fresh source: exactly one of --file (offline) or --bootnode-tcp (plain HTTP).
    let fresh: Result<String, String> = if let Some(f) = take_flag(args, "--file") {
        read_file(&f)
    } else if let Some(hp) = take_flag(args, "--bootnode-tcp") {
        let path = take_flag(args, "--path").unwrap_or_else(|| "/directory".to_string());
        let host = hp.split(':').next().unwrap_or("127.0.0.1").to_string();
        dircache::fetch_http_plain(&hp, &host, &path)
    } else {
        eprintln!(
            "fetch-directory: need a source: --file <f> (offline) or --bootnode-tcp <host:port> \
             (plain HTTP). Live embedded-Tor discovery is `egress --bootnode-onion` (--features live)."
        );
        return ExitCode::from(2);
    };

    match dircache::resolve_directory(fresh, cache.as_deref(), &signer, max_age, now_ms()) {
        Ok(out) => {
            println!("ok");
            println!(
                "source: {}",
                match out.source {
                    dircache::Source::Fresh => "fresh",
                    dircache::Source::Cache => "cache",
                }
            );
            if let Some(fe) = out.fresh_error {
                println!("fresh-error: {fe}");
            }
            println!("issued: {}", out.dir.issued);
            println!("gateways: {}", out.dir.gateways.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("not-ok: {e}");
            ExitCode::from(1)
        }
    }
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const HELP: &str = "\
shade-tree — local egress client (research preview)

USAGE:
    shade-tree <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    verify-directory <file> --signer <hex>
        Parse a signed directory JSON file and verify it against the pinned
        ed25519 signer (onion<->pubkey binding + signature). Prints ok / reason.

    fetch-directory --signer <hex> [--cache <f>] [--max-age-ms <n>]
                    (--file <f> | --bootnode-tcp <host:port> [--path </directory>])
        Obtain a FRESH directory (offline --file, or --bootnode-tcp plain HTTP),
        verify it, apply the rollback + optional max-age guards against the
        last-known-good --cache, write the cache, and print source/issued/gateways.
        On a failed or refused fresh fetch, falls back to the verified LKG cache
        (never serves an unverified directory). Embedded-Tor bootnode discovery is
        `egress --bootnode-onion` in a --features live build.

    select <dir-file> --signer <hex> [--seed <n>] [--health-cache <f>]
                      [--port <n>] [--proto <n>] [--region <bucket>]
                      [--leaf-source invited|staked|paid] [--max-anon]
        Verify the directory, then print the weighted-random chosen gateway onion
        and the full failover order. --seed makes the choice reproducible.
        --health-cache seeds each gateway's health from persisted egress failover
        feedback, so a gateway that failed last session starts deprioritized.
        --port/--proto/--region (T-FEAT-10) form an OPT-IN capability requirement:
        only gateways whose SIGNED caps meet it are selected (a no-caps gateway meets
        only the conservative 443/v4 floor; region is never implicit). If no gateway
        qualifies, select fails closed (not-ok) rather than dialing an incapable one.
        --leaf-source / --max-anon (T-FEAT-9, docs/adr/0008): admission-aware selection.
        A gateway advertises WHICH admission paths it honours as signed caps.admits
        (invited > staked > paid, the anonymity order). --leaf-source names the set
        YOUR leaf is in (SHADE_TREE_LEAF_SOURCE): only gateways that admit it are selected
        (a gateway advertising no policy is kept, rollout compat). --max-anon
        (SHADE_TREE_MAX_ANON=1) keeps ONLY invited-only gateways (admits=[invited]) and
        refuses a staked/paid leaf source. Neither given = byte-identical selection.
        The same two flags apply to `egress --directory` / `--bootnode-onion`.

    verify-receipt <receipt-file> --onion <onion>
        Parse an egress-success receipt JSON file and verify it (onion<->pubkey
        binding + ed25519 signature), bound to --onion. Prints ok / reason.

    egress <TRANSPORT> --identity <f> --members <f> --target <host:port>
           [--circuits <dir>] [--epoch <n>] [--slot-cursor <f>]
           [--rln-identifier <n>] [--k <n>] [--nonce <hex>]
        LIVE egress (requires a `--features live` build). Builds a REAL RLN envelope
        in Rust (native depth-20 Poseidon tree + Groth16 proof over the repo's
        circuits) binding <target>, opens a connection to the gateway, sends the
        envelope exactly as client/shade-tree-client.mjs does, and reports accept/reject.
        FAILOVER: the transport yields an ORDERED candidate list; the ONE envelope is
        built once and REUSED across candidates (deterministic-retry parity). On a
        dial failure the client rotates to the next candidate until one accepts; a
        gate REFUSAL is terminal (matches client/shade-tree-client.mjs connect()).
        Choose exactly one TRANSPORT:
          --directory <f> --signer <hex>  Verify the signed directory (LKG-cached via
                                          --cache), pick the weighted failover ORDER,
                                          and dial each .onion over EMBEDDED TOR (arti;
                                          no system tor daemon, no SOCKS). [default path]
                                          Optional: --cache <f> (LKG), --health-cache <f>
                                          (seed + record cross-session liveness),
                                          --max-age-ms <n>.
          --bootnode-onion <onion> --signer <hex>
                                          Fetch /directory from the bootnode onion over
                                          EMBEDDED TOR, verify + LKG-cache it, then select
                                          + failover exactly as --directory. Same optional
                                          --cache/--health-cache/--max-age-ms.
          --onion <a[:p]>[,<a[:p]>...]    Dial these specific .onion(s) over embedded Tor,
                                          in order (default port 80). Comma = failover list.
          --plain-tcp <h:p>[,<h:p>...]    Escape hatch: dial plain TCP, no Tor, in order
                                          (comma = failover list; used by the CI harness).
        Envelope options:
          --identity  JSON { identitySecret, leaf[, limit] } (the member's derived secret + leaf;
                      export it from your SHADE_TREE_SECRET with the JS CLI: `shade-tree identity --out identity.json`;
                      `limit` = the leaf's reputation-tier userMessageLimit, T-FEAT-8, default 8)
          --members   JSON { members: [leaf,...] }  (the ordered group, same as the gateway;
                      for a staked/paid ON-CHAIN set export it: `shade-tree leaves --contract <addr> --out members.json`)
          --target    host:port bound into the proof (the egress destination)
          --circuits  OPTIONAL dir with rln.wasm + rln_final.zkey + verification_key.json;
                      omit it to use the artifacts EMBEDDED in this binary (self-contained,
                      no external circuit files — T-RUST-4). Embedded artifacts are hash-
                      checked at startup against the embedded zk-artifacts lock (T-HARD-8):
                      any drift is a hard, named error. The set's content-derived artifact
                      id (rln-<sha256(vkey)[0:16]>) is stamped into the envelope's `artifact`
                      field; if the selected gateway advertises accepted artifact ids
                      (signed caps.artifacts) that exclude ours, egress fails closed with
                      `no-mutual-artifact:...` BEFORE proving.
          --epoch     epoch to prove for (default: floor(now/SHADE_TREE_EPOCH_SECONDS), K=120s)
          --k         userMessageLimit / tier (default: the identity file's `limit`, else 8;
                      must be the leaf's enrolled limit)
          --slot-cursor  exact state-file override (or SHADE_TREE_SLOT_CURSOR). Persistence is
                      default-on under SHADE_TREE_SLOT_STATE_DIR / XDG_STATE_HOME / ~/.local/state,
                      namespaced by the public member leaf. JS and Rust processes atomically
                      share it, stop at K, and reset only when the epoch advances.
          --unsafe-allow-slot-reuse-for-slashing-tests --slot <i>
                      bypass persistent allocation ONLY for an isolated slashing test; never
                      use with a funded/live member secret
          --rln-identifier  group id (default 1)     --nonce  32-hex per-request nonce
        Without the feature: prints an honest not-built error.

    help, --help, -h        Show this help.
    version, --version, -V  Show the version.

NOTES:
    The trust-critical checks come from the shade-tree-proto crate (a Rust port of the
    JS reference, gated byte-for-byte by testdata/vectors.json). This binary parses
    untrusted JSON and calls those checks. Live network I/O (the RLN prover and the
    embedded-Tor onion dial) is compiled only under `--features live`.
    See docs/adr/0001-client-language.md.";

/// T-FEAT-9: `--leaf-source invited|staked|paid` + `--max-anon` (or SHADE_TREE_LEAF_SOURCE /
/// SHADE_TREE_MAX_ANON=1). `--max-anon` with a staked/paid leaf source is refused up front (an
/// invited-only gateway would reject that proof with wrong-group-root) — see the JS client.
fn admission_from_args(args: &[String]) -> capability::Admission {
    let env_src = std::env::var("SHADE_TREE_LEAF_SOURCE")
        .ok()
        .filter(|s| !s.trim().is_empty() && s.trim() != "auto");
    let leaf_source = take_flag(args, "--leaf-source")
        .or(env_src)
        .map(|s| s.trim().to_ascii_lowercase());
    let env_max = matches!(
        std::env::var("SHADE_TREE_MAX_ANON")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1") | Some("true") | Some("yes") | Some("on")
    );
    let max_anon = args.iter().any(|a| a == "--max-anon") || env_max;
    capability::Admission {
        leaf_source,
        max_anon,
    }
}

fn admission_refusal(
    adm: &capability::Admission,
    before: &[shade_tree_proto::GatewayEntry],
) -> String {
    if adm.max_anon {
        return format!(
            "--max-anon: no invited-only gateway in the directory (a gateway qualifies only when its signed caps say admits=[invited]); fleet: {}",
            capability::describe_fleet_admits(before)
        );
    }
    format!(
        "no gateway admits a {} leaf (your leaf source); fleet: {} -- pick a gateway that admits it, or obtain a leaf in a set the fleet admits (docs/CLIENTS.md \"Leaf source\")",
        adm.leaf_source.as_deref().unwrap_or("?"),
        capability::describe_fleet_admits(before)
    )
}

/// Validate the admission inputs before any dial (a bad name or max-anon over a staked/paid
/// leaf is a precise refusal, never a wasted proof).
fn check_admission(adm: &capability::Admission) -> Result<(), String> {
    if let Some(src) = &adm.leaf_source {
        if !shade_tree_proto::ADMIT_PATHS.contains(&src.as_str()) {
            return Err(format!(
                "--leaf-source: expected invited, staked or paid (got {src})"
            ));
        }
        if adm.max_anon && src != "invited" {
            return Err(format!("--max-anon: your leaf is in the {src} set; an invited-only gateway would reject it (wrong-group-root). Max-anon requires an invited (members.json) leaf -- drop --max-anon to use gateways that admit {src}."));
        }
    }
    Ok(())
}

/// Extract `--flag <value>` from args, returning the value and the remaining args.
fn take_flag(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))
}

fn cmd_verify_directory(args: &[String]) -> ExitCode {
    let Some(file) = args.first() else {
        eprintln!("verify-directory: missing <file>\n\n{HELP}");
        return ExitCode::from(2);
    };
    let Some(signer) = take_flag(args, "--signer") else {
        eprintln!("verify-directory: missing --signer <hex>");
        return ExitCode::from(2);
    };
    let raw = match read_file(file) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let dto: DirectoryDto = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            println!("not-ok: parse: {e}");
            return ExitCode::from(1);
        }
    };
    match verify_directory(&dto.into_proto(), &signer) {
        Ok(()) => {
            println!("ok");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("not-ok: {e}");
            ExitCode::from(1)
        }
    }
}

fn cmd_select(args: &[String]) -> ExitCode {
    let Some(file) = args.first() else {
        eprintln!("select: missing <dir-file>\n\n{HELP}");
        return ExitCode::from(2);
    };
    let Some(signer) = take_flag(args, "--signer") else {
        eprintln!("select: missing --signer <hex>");
        return ExitCode::from(2);
    };
    let seed = take_flag(args, "--seed")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or_else(default_seed);

    let raw = match read_file(file) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let dto: DirectoryDto = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            println!("not-ok: parse: {e}");
            return ExitCode::from(1);
        }
    };
    let mut dir = dto.into_proto();
    // Zero-trust: never select from an unverified directory.
    if let Err(e) = verify_directory(&dir, &signer) {
        println!("not-ok: {e}");
        return ExitCode::from(1);
    }

    // Cross-session gateway deprioritization (T-RUST-3, reportResult parity): when a
    // --health-cache is given, seed each gateway's health from the persisted liveness
    // written by past `egress` failover feedback, so a gateway that failed enough last
    // session starts `health:"down"` and is deprioritized (decay-pruned if long-idle).
    // Absent the flag, selection is byte-identical to before.
    if let Some(hc) = take_flag(args, "--health-cache") {
        let path = std::path::PathBuf::from(hc);
        let mut cache = health::load(Some(&path));
        health::seed(&mut dir, &mut cache, now_ms());
    }

    // Opt-in capability-aware filter (T-FEAT-10c). --port/--proto/--region form a
    // capability requirement; only gateways whose SIGNED caps meet it survive (a no-caps
    // gateway meets only the conservative 443/v4 floor). Absent all three => INACTIVE =>
    // byte-identical selection. Active but no gateway qualifies => FAIL CLOSED (never
    // dial an incapable gateway). Mirrors selectCandidates(req) in client/selection.mjs.
    let req = capability::Requirement {
        port: take_flag(args, "--port").and_then(|s| s.parse::<u64>().ok()),
        proto: take_flag(args, "--proto").and_then(|s| s.parse::<u64>().ok()),
        region: take_flag(args, "--region"),
    };
    if req.is_active() {
        capability::filter_by_capability(&mut dir.gateways, &req);
        if dir.gateways.is_empty() {
            println!(
                "not-ok: no gateway meets capability requirement: {}",
                req.describe()
            );
            return ExitCode::from(1);
        }
    }
    // Admission-aware filter (T-FEAT-9). --leaf-source names the set the member's leaf is in;
    // only gateways whose SIGNED caps.admits include it survive (no policy advertised = kept,
    // rollout compat). --max-anon keeps ONLY invited-only gateways. Absent both => byte-identical.
    let adm = admission_from_args(args);
    if let Err(e) = check_admission(&adm) {
        println!("not-ok: {e}");
        return ExitCode::from(1);
    }
    if adm.is_active() {
        let before = dir.gateways.clone();
        capability::filter_by_admission(&mut dir.gateways, &adm);
        if dir.gateways.is_empty() {
            println!("not-ok: {}", admission_refusal(&adm, &before));
            return ExitCode::from(1);
        }
    }

    let mut rng = mulberry32(seed);
    let empty = HashSet::new();
    let Some(chosen) = pick_gateway(&dir, &empty, &mut rng) else {
        println!("not-ok: no-gateways");
        return ExitCode::from(1);
    };
    println!("ok");
    println!("chosen: {}", chosen.onion);
    // Fresh rng from the same seed so the printed order starts with the same weighted pick.
    let mut rng2 = mulberry32(seed);
    let order = selection_order(&dir, &mut rng2);
    println!("failover-order:");
    for (i, g) in order.iter().enumerate() {
        println!("  {}. {}", i + 1, g.onion);
    }
    ExitCode::SUCCESS
}

fn cmd_verify_receipt(args: &[String]) -> ExitCode {
    let Some(file) = args.first() else {
        eprintln!("verify-receipt: missing <receipt-file>\n\n{HELP}");
        return ExitCode::from(2);
    };
    let Some(onion) = take_flag(args, "--onion") else {
        eprintln!("verify-receipt: missing --onion <onion>");
        return ExitCode::from(2);
    };
    let raw = match read_file(file) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let dto: ReceiptDto = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            println!("not-ok: parse: {e}");
            return ExitCode::from(1);
        }
    };
    // Bind to the dialed onion; skip the epoch-freshness check (a CLI has no live epoch —
    // it verifies the onion<->pubkey binding + signature, matching a client verifying an
    // offline/archived receipt).
    match verify_receipt(&dto.into_proto(), Some(&onion), None, 1) {
        Ok(v) => {
            println!("ok");
            println!("onion: {}", v.onion);
            println!("pubkey: {}", hex::encode(v.pubkey));
            println!("epoch: {}", v.epoch);
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("not-ok: {e}");
            ExitCode::from(1)
        }
    }
}

fn cmd_egress(args: &[String]) -> ExitCode {
    #[cfg(feature = "live")]
    {
        live::run_egress(args)
    }
    #[cfg(not(feature = "live"))]
    {
        let _ = args;
        match live_egress() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("not-implemented: {e}");
                ExitCode::from(3)
            }
        }
    }
}

// --------------------------------------------------------------------------
// LIVE egress implementation (feature = "live"): RLN prover + native tree +
// transport (embedded Tor via arti, or plain-TCP escape hatch). T-RUST-2d/2e.
// --------------------------------------------------------------------------
//
// The wire framing here is byte-matched to the JS reference so the real JS gateway
// (gateway/gateway.mjs) accepts the Rust envelope, IDENTICALLY over both transports:
//   - SEND: `JSON.stringify(envelope) + "\n"` — client/shade-tree-client.mjs:313,341.
//     envelope = { v, target, nonce, proof, nullifier, externalNullifier, share }
//     (buildEnvelope, client/shade-tree-client.mjs:123); the nested `proof` is the wire-safe
//     RLNFullProof { snarkProof:{proof,publicSignals}, epoch, rlnIdentifier } assembled
//     exactly as rust/shade-tree-rln/interop/verify-envelope.mjs:13-25.
//   - RECV: the gateway replies `JSON.stringify(ack) + "\n"` (gateway.mjs reply(),
//     :333-335; successAck `{ ok: true }` at :594) once verifyEnvelope passes, the target
//     policy admits, the spent-set admits, and the upstream :target connects. So `ok:true`
//     is a full end-to-end ACCEPT (version gate + Groth16 verify + proxy established).
//
// TRANSPORT (T-RUST-2e): `--directory/--signer` (or `--onion`) dials the gateway's `.onion`
// over EMBEDDED TOR — arti bootstraps its own Tor client (no system tor daemon, no SOCKS)
// and `TorClient::connect((onion, 80))` opens an anonymous stream to the gateway HS virtual
// port 80 (bootstrap.sh: `HiddenServicePort 80 127.0.0.1:8443`), matching the JS client's
// `destination: { host: onion+".onion", port: 80 }` (client/shade-tree-client.mjs:271). The
// `--plain-tcp <host:port>` escape hatch keeps the loop-22 plain-socket path (the CI
// harness egress-run.sh uses it) so the always-green Layer-3 accept is unaffected.
#[cfg(feature = "live")]
mod live {
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::process::ExitCode;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde::Deserialize;

    use super::{
        admission_from_args, admission_refusal, capability, check_admission, default_seed,
        dircache, health, mulberry32, now_ms, parse_max_age, read_file, slotcursor, take_flag,
    };

    /// One dial target in the failover order. Plain-TCP is the loop-22 escape hatch;
    /// Onion is the default T-RUST-2e path (dialed over embedded Tor).
    enum Transport {
        /// `--plain-tcp <host:port>` — dial plain TCP, no Tor (the CI-harness / socket path).
        PlainTcp(String),
        /// `--onion <addr>`, a directory selection, or bootnode discovery — dial
        /// `<onion>.onion:<port>` over embedded Tor. `artifacts` is the gateway's SIGNED
        /// accepted-ZK-artifact ad (`caps.artifacts`, T-HARD-8) when it came from a verified
        /// directory entry that advertises one; `None` = unknown (no ad / explicit --onion).
        Onion {
            onion: String,
            port: u16,
            artifacts: Option<Vec<String>>,
        },
    }

    impl Transport {
        /// Human-readable dial label (printed on success + used as the health-cache key
        /// for onion transports).
        fn label(&self) -> String {
            match self {
                Transport::PlainTcp(hp) => hp.clone(),
                Transport::Onion { onion, port, .. } => format!("{onion}.onion:{port}"),
            }
        }
        /// The onion (with suffix) this transport reports liveness for, or `None` for a
        /// plain-TCP dial (which is never a signed-directory gateway).
        fn health_onion(&self) -> Option<String> {
            match self {
                Transport::Onion { onion, .. } => Some(format!("{onion}.onion")),
                Transport::PlainTcp(_) => None,
            }
        }
    }

    /// Cross-session liveness feedback context (only set for the directory / bootnode
    /// paths, where the candidate onions come from a SIGNED directory). Mirrors
    /// `selection.mjs` reportResult: after each dial we fold the outcome into the local
    /// health cache so a failing gateway starts deprioritized next session.
    struct HealthCtx {
        cache_path: PathBuf,
        known: HashSet<String>,
        cache: health::HealthCache,
    }

    /// The full egress plan: the ordered candidates + optional health feedback.
    struct EgressPlan {
        transports: Vec<Transport>,
        health: Option<HealthCtx>,
    }

    #[derive(Deserialize)]
    struct IdentityFile {
        #[serde(rename = "identitySecret")]
        identity_secret: String,
        leaf: String,
        /// Optional tier limit (T-FEAT-8): the `userMessageLimit` this leaf was enrolled
        /// with. `shade-tree identity` writes it only for a non-default tier; absent => K_SLOTS.
        #[serde(default)]
        limit: Option<u64>,
    }

    #[derive(Deserialize)]
    struct MembersFile {
        members: Vec<String>,
    }

    // lib/rln.mjs EPOCH_SECONDS default is 120s; SHADE_TREE_EPOCH_SECONDS overrides to match a
    // gateway configured otherwise. verifyEnvelope accepts this-or-previous epoch, so a
    // wall-clock-derived epoch has a full window of slack against the gateway's own clock.
    fn epoch_seconds() -> u64 {
        std::env::var("SHADE_TREE_EPOCH_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n: &u64| n > 0)
            .unwrap_or(120)
    }

    fn current_epoch() -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now / epoch_seconds()
    }

    // Exact override first; otherwise use the JS-compatible default under the public leaf.
    // Empty/off is rejected: only the explicit slashing-test flag below can bypass safety.
    fn slot_cursor_path(rest: &[String], leaf: &str) -> Result<PathBuf, slotcursor::Error> {
        if let Some(f) = take_flag(rest, "--slot-cursor") {
            let f = f.trim();
            if f.is_empty() || f == "0" || f.eq_ignore_ascii_case("off") {
                return Err(slotcursor::Error::Unavailable(
                    "--slot-cursor cannot disable safety".into(),
                ));
            }
            return Ok(PathBuf::from(f));
        }
        if let Ok(v) = std::env::var("SHADE_TREE_SLOT_CURSOR") {
            let v = v.trim();
            if v.is_empty() || v == "0" || v.eq_ignore_ascii_case("off") {
                return Err(slotcursor::Error::Unavailable(
                    "SHADE_TREE_SLOT_CURSOR cannot disable safety".into(),
                ));
            }
            return Ok(PathBuf::from(v));
        }
        slotcursor::default_path(leaf)
    }

    // Per-step embedded-Tor timeout (bootstrap + connect each), SHADE_TREE_TOR_TIMEOUT_SECS.
    fn tor_timeout_secs() -> u64 {
        std::env::var("SHADE_TREE_TOR_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n: &u64| n > 0)
            .unwrap_or(180)
    }

    // A 16-byte random nonce -> 32 hex chars, matching client/shade-tree-client.mjs
    // `randomBytes(16).toString("hex")`. No `rand` runtime dep: splitmix64 over a
    // clock+pid seed is ample for a per-request nonce (uniqueness, not secrecy). A
    // `--nonce` flag overrides it for reproducible runs.
    fn gen_nonce() -> String {
        let mut seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
            ^ (u64::from(std::process::id())).rotate_left(32);
        let mut out = [0u8; 16];
        for chunk in out.chunks_mut(8) {
            seed = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = seed;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            chunk.copy_from_slice(&z.to_le_bytes());
        }
        hex::encode(out)
    }

    fn load_json<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
        let raw = read_file(path)?;
        serde_json::from_str(&raw).map_err(|e| format!("parse {path}: {e}"))
    }

    // Turn a FRESH directory (a file read, or a bootnode fetch over Tor) into the ordered
    // onion candidate list for failover — the SAME LKG-cache + guards + weighted
    // selection_order the JS client runs (selection.mjs ensureLoaded -> selectCandidates):
    //   1. dircache::resolve_directory verifies the fresh directory against the pinned
    //      signer, applies the rollback + optional max-age guards vs the LKG --cache, and
    //      writes the cache — or falls back to the verified LKG cache when fresh fails
    //      (never an unverified list).
    //   2. When a --health-cache is given, seed each gateway's health from persisted
    //      cross-session liveness so a gateway that failed last session starts deprioritized.
    //   3. selection_order yields the weighted pick first, then the rest as failover targets.
    // Returns the candidate transports + the health feedback context (recorded after each
    // dial so this session's failures deprioritize the gateway next session).
    fn directory_candidates(
        fresh: Result<String, String>,
        rest: &[String],
        signer: &str,
    ) -> Result<(Vec<Transport>, Option<HealthCtx>), String> {
        use shade_tree_proto::selection_order;

        let cache_path = take_flag(rest, "--cache").map(PathBuf::from);
        let max_age = parse_max_age(rest);
        let out =
            dircache::resolve_directory(fresh, cache_path.as_deref(), signer, max_age, now_ms())?;
        if out.source == dircache::Source::Cache {
            eprintln!(
                "egress: using last-known-good directory cache ({})",
                out.fresh_error.as_deref().unwrap_or("fresh unavailable")
            );
        }
        let mut dir = out.dir;

        // Cross-session deprioritization (reportResult parity): seed health, keep the cache
        // + known-onion set for post-dial feedback.
        let health_ctx = if let Some(hc) = take_flag(rest, "--health-cache") {
            let path = PathBuf::from(hc);
            let mut cache = health::load(Some(&path));
            health::seed(&mut dir, &mut cache, now_ms());
            let known: HashSet<String> = dir.gateways.iter().map(|g| g.onion.clone()).collect();
            Some(HealthCtx {
                cache_path: path,
                known,
                cache,
            })
        } else {
            None
        };

        // Admission-aware filter (T-FEAT-9): route only to gateways whose signed policy admits
        // this member's leaf source (--leaf-source / SHADE_TREE_LEAF_SOURCE), --max-anon = invited-only.
        let adm = admission_from_args(rest);
        check_admission(&adm)?;
        if adm.is_active() {
            let before = dir.gateways.clone();
            capability::filter_by_admission(&mut dir.gateways, &adm);
            if dir.gateways.is_empty() {
                return Err(admission_refusal(&adm, &before));
            }
            eprintln!(
                "egress: admission filter ({}) kept {} of {} gateway(s)",
                adm.describe(),
                dir.gateways.len(),
                before.len()
            );
        }
        let mut rng = mulberry32(default_seed());
        let order = selection_order(&dir, &mut rng);
        if order.is_empty() {
            return Err("no gateways in directory".into());
        }
        let mut transports = Vec::with_capacity(order.len());
        for g in &order {
            let (onion, _) = parse_onion_addr(&g.onion, 80)?;
            // Carry the gateway's signed accepted-artifact ad (already capsSig-verified by
            // verify_directory) so the artifact pick happens BEFORE proving (T-HARD-8).
            let artifacts = g
                .caps
                .as_ref()
                .and_then(|c| shade_tree_proto::canonical_caps(c).artifacts);
            transports.push(Transport::Onion {
                onion,
                port: 80,
                artifacts,
            });
        }
        eprintln!(
            "egress: {} candidate gateway(s) from verified directory; first = {}",
            transports.len(),
            transports[0].label()
        );
        Ok((transports, health_ctx))
    }

    // Fetch GET /directory from the bootnode onion over EMBEDDED TOR (arti), returning the
    // raw JSON body — the dynamic-fleet source (loadFromBootnode, selection.mjs). The body is
    // then handed to directory_candidates, which VERIFIES it against the pinned signer before
    // anything is used, so a lying/MITM'd bootnode cannot forge an entry. Speaks minimal
    // HTTP/1.1 over the Tor stream (dircache::http_get_request / parse_http_body), exactly
    // like bootnode/fetch.mjs does over its SOCKS tunnel.
    fn fetch_directory_over_tor(bootnode_onion: &str) -> Result<String, String> {
        use arti_client::{TorClient, TorClientConfig};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (onion, port) = parse_onion_addr(bootnode_onion, 80)?;
        let host = format!("{onion}.onion");
        let timeout_secs = tor_timeout_secs();
        let timeout = Duration::from_secs(timeout_secs);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("tokio runtime: {e}"))?;
        rt.block_on(async move {
            eprintln!("egress: bootstrapping embedded Tor (arti) for bootnode discovery ...");
            let tor = tokio::time::timeout(
                timeout,
                TorClient::create_bootstrapped(TorClientConfig::default()),
            )
            .await
            .map_err(|_| format!("arti bootstrap timed out after {timeout_secs}s"))?
            .map_err(|e| format!("arti bootstrap: {e}"))?;

            eprintln!("egress: fetching /directory from {host}:{port} over Tor ...");
            let mut stream = tokio::time::timeout(timeout, tor.connect((host.as_str(), port)))
                .await
                .map_err(|_| format!("bootnode connect timed out after {timeout_secs}s"))?
                .map_err(|e| format!("connect bootnode {host}:{port}: {e}"))?;

            let req = dircache::http_get_request(&host, "/directory");
            stream
                .write_all(req.as_bytes())
                .await
                .map_err(|e| format!("write request: {e}"))?;
            stream.flush().await.map_err(|e| format!("flush: {e}"))?;

            let mut buf: Vec<u8> = Vec::with_capacity(4096);
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|e| format!("read response: {e}"))?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > dircache::MAX_HTTP_RESP {
                    return Err(format!(
                        "bootnode response exceeded {} bytes",
                        dircache::MAX_HTTP_RESP
                    ));
                }
            }
            dircache::parse_http_body(&buf)
        })
    }

    // Parse `<addr[:port]>` into (onion-without-suffix, port). Default port 80 = the gateway
    // HS virtual port. The `.onion` suffix is normalized off here and re-added at dial time,
    // exactly like the JS client (client/shade-tree-client.mjs:221,271).
    fn parse_onion_addr(addr: &str, default_port: u16) -> Result<(String, u16), String> {
        let (host, port) = match addr.rsplit_once(':') {
            // Only treat a trailing `:NNN` as a port if it parses as one; otherwise the whole
            // string is the host (an .onion never contains a colon).
            Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse::<u16>().unwrap()),
            _ => (addr, default_port),
        };
        let onion = host.trim_end_matches(".onion").to_string();
        if onion.is_empty() {
            return Err(format!("empty onion address in {addr:?}"));
        }
        Ok((onion, port))
    }

    // One bootstrapped embedded-Tor client (arti) + its Tokio runtime, REUSED across the
    // whole failover candidate loop (T-RUST-3b). Bootstrap is the slow part of a Tor dial;
    // the previous code re-bootstrapped a fresh `TorClient` (and a fresh runtime) for EVERY
    // candidate, which was purely wasteful — every onion candidate shares the same Tor
    // network view, so one bootstrap serves them all. We bootstrap ONCE (lazily, only if a
    // candidate is actually an onion) and call `connect()` per candidate on the same client.
    //
    // The RLN envelope is built BEFORE this is created (build_envelope spins up and drops its
    // own Tokio runtime for the wasm witness), so creating this runtime never nests one
    // runtime inside another. Bootstrap + each connect are bounded by SHADE_TREE_TOR_TIMEOUT_SECS.
    struct TorSession {
        rt: tokio::runtime::Runtime,
        // `create_bootstrapped` hands back an `Arc<TorClient>` (the client is not itself
        // Clone); the Arc is the cheap-to-clone reuse handle shared across the loop.
        client: std::sync::Arc<arti_client::TorClient<tor_rtcompat::PreferredRuntime>>,
        timeout: Duration,
        timeout_secs: u64,
    }

    impl TorSession {
        // Bootstrap arti ONCE. Called lazily on the first onion candidate so a run whose
        // failover order is all plain-TCP never pays for a bootstrap.
        fn bootstrap() -> Result<Self, String> {
            use arti_client::{TorClient, TorClientConfig};

            let timeout_secs = tor_timeout_secs();
            let timeout = Duration::from_secs(timeout_secs);
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("tokio runtime: {e}"))?;
            eprintln!("egress: bootstrapping embedded Tor (arti) once for the failover loop ...");
            let client = rt.block_on(async {
                tokio::time::timeout(
                    timeout,
                    TorClient::create_bootstrapped(TorClientConfig::default()),
                )
                .await
                .map_err(|_| format!("arti bootstrap timed out after {timeout_secs}s"))?
                .map_err(|e| format!("arti bootstrap: {e}"))
            })?;
            Ok(Self {
                rt,
                client,
                timeout,
                timeout_secs,
            })
        }

        // Dial the gateway `.onion` over the ALREADY-bootstrapped client and send the framed
        // envelope, reading one newline-terminated ack — the read/frame contract is IDENTICAL
        // to the plain-TCP `send_envelope`, so the gateway cannot tell the transports apart.
        fn dial_and_send(
            &self,
            onion: &str,
            port: u16,
            wire: &str,
        ) -> Result<serde_json::Value, String> {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let timeout = self.timeout;
            let timeout_secs = self.timeout_secs;
            let client = std::sync::Arc::clone(&self.client);
            self.rt.block_on(async move {
                let host = format!("{onion}.onion");
                eprintln!("egress: dialing {host}:{port} over Tor ...");
                let mut stream =
                    tokio::time::timeout(timeout, client.connect((host.as_str(), port)))
                        .await
                        .map_err(|_| format!("onion connect timed out after {timeout_secs}s"))?
                        .map_err(|e| format!("connect onion {host}:{port}: {e}"))?;

                stream
                    .write_all(wire.as_bytes())
                    .await
                    .map_err(|e| format!("write envelope: {e}"))?;
                stream
                    .flush()
                    .await
                    .map_err(|e| format!("flush envelope: {e}"))?;

                let mut buf: Vec<u8> = Vec::with_capacity(256);
                let mut chunk = [0u8; 512];
                loop {
                    let n = stream
                        .read(&mut chunk)
                        .await
                        .map_err(|e| format!("read ack: {e}"))?;
                    if n == 0 {
                        return Err("gateway closed the connection before an ack".to_string());
                    }
                    if let Some(nl) = chunk[..n].iter().position(|&b| b == b'\n') {
                        buf.extend_from_slice(&chunk[..nl]);
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > 64 * 1024 {
                        return Err("ack exceeded 64KiB without a newline".to_string());
                    }
                }
                let line = String::from_utf8_lossy(&buf);
                serde_json::from_str::<serde_json::Value>(&line).map_err(|e| {
                    format!(
                        "bad ack json ({e}): {}",
                        line.chars().take(160).collect::<String>()
                    )
                })
            })
        }
    }

    // Dial plain TCP, send the framed envelope, read one newline-terminated ack, parse it.
    fn send_envelope(dial: &str, wire: &str) -> Result<serde_json::Value, String> {
        let mut stream = TcpStream::connect(dial).map_err(|e| format!("connect {dial}: {e}"))?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
        stream
            .write_all(wire.as_bytes())
            .map_err(|e| format!("write envelope: {e}"))?;
        let mut buf: Vec<u8> = Vec::with_capacity(256);
        let mut chunk = [0u8; 512];
        loop {
            let n = stream
                .read(&mut chunk)
                .map_err(|e| format!("read ack: {e}"))?;
            if n == 0 {
                return Err("gateway closed the connection before an ack".into());
            }
            if let Some(nl) = chunk[..n].iter().position(|&b| b == b'\n') {
                buf.extend_from_slice(&chunk[..nl]);
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 64 * 1024 {
                return Err("ack exceeded 64KiB without a newline".into());
            }
        }
        let line = String::from_utf8_lossy(&buf);
        serde_json::from_str::<serde_json::Value>(&line).map_err(|e| {
            format!(
                "bad ack json ({e}): {}",
                line.chars().take(160).collect::<String>()
            )
        })
    }

    // Resolve the ordered FAILOVER plan from the CLI flags. Order of precedence:
    //   --plain-tcp (escape hatch) > --onion > --bootnode-onion > --directory.
    // A comma-separated --plain-tcp/--onion is an explicit failover LIST (dead first,
    // live second, ...); --directory/--bootnode-onion derive the ordered list from the
    // signed directory's weighted selection_order (with LKG caching + health).
    fn resolve_plan(rest: &[String]) -> Result<EgressPlan, String> {
        if let Some(list) = take_flag(rest, "--plain-tcp") {
            let transports: Vec<Transport> = list
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| Transport::PlainTcp(s.to_string()))
                .collect();
            if transports.is_empty() {
                return Err("--plain-tcp: no targets".into());
            }
            return Ok(EgressPlan {
                transports,
                health: None,
            });
        }
        if let Some(list) = take_flag(rest, "--onion") {
            let mut transports = Vec::new();
            for addr in list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let (onion, port) = parse_onion_addr(addr, 80)?;
                transports.push(Transport::Onion {
                    onion,
                    port,
                    artifacts: None,
                });
            }
            if transports.is_empty() {
                return Err("--onion: no targets".into());
            }
            return Ok(EgressPlan {
                transports,
                health: None,
            });
        }
        if let Some(bootnode) = take_flag(rest, "--bootnode-onion") {
            let Some(signer) = take_flag(rest, "--signer") else {
                return Err("--bootnode-onion needs --signer <hex>".into());
            };
            // Discovery over Tor is the FRESH source; a fetch failure still degrades to the
            // verified LKG cache inside directory_candidates (never nothing / never unverified).
            let fresh = fetch_directory_over_tor(&bootnode);
            let (transports, health) = directory_candidates(fresh, rest, &signer)?;
            return Ok(EgressPlan { transports, health });
        }
        if let Some(dirf) = take_flag(rest, "--directory") {
            let Some(signer) = take_flag(rest, "--signer") else {
                return Err("--directory needs --signer <hex>".into());
            };
            let fresh = read_file(&dirf); // a read failure -> LKG cache fallback
            let (transports, health) = directory_candidates(fresh, rest, &signer)?;
            return Ok(EgressPlan { transports, health });
        }
        Err(
            "no transport: pass --directory <f> --signer <hex> or --bootnode-onion <onion> \
             --signer <hex> (dial the selected onion(s) over Tor), --onion <addr[,addr...]> \
             (dial specific onion(s) over Tor), or --plain-tcp <host:port[,host:port...]> (no Tor)"
                .to_string(),
        )
    }

    // Dial one candidate + send the framed envelope. Ok(ack) means the gateway replied
    // (accept OR refuse — terminal); Err means a dial/IO failure the failover loop rotates on.
    // `tor` holds the shared bootstrapped session (T-RUST-3b): the first onion candidate
    // bootstraps it, every later onion candidate reuses it. A bootstrap failure leaves `tor`
    // as `None`, so a later onion candidate may retry — the reuse only caches SUCCESS.
    fn dial_send(
        t: &Transport,
        wire: &str,
        tor: &mut Option<TorSession>,
    ) -> Result<serde_json::Value, String> {
        match t {
            Transport::PlainTcp(hp) => {
                eprintln!("egress: dialing {hp} (plain TCP, no Tor) ...");
                send_envelope(hp, wire)
            }
            Transport::Onion { onion, port, .. } => {
                if tor.is_none() {
                    *tor = Some(TorSession::bootstrap()?);
                }
                // Just populated (or already present): reuse the one bootstrapped client.
                tor.as_ref().unwrap().dial_and_send(onion, *port, wire)
            }
        }
    }

    // Fold one dial outcome into the health cache (reportResult parity). No-op unless a
    // health context is present (directory/bootnode paths) and the transport is a
    // signed-directory onion.
    fn report(health: &mut Option<HealthCtx>, t: &Transport, ok: bool) {
        let (Some(ctx), Some(onion)) = (health.as_mut(), t.health_onion()) else {
            return;
        };
        health::update(&mut ctx.cache, &ctx.known, &onion, ok, None, now_ms());
    }

    pub fn run_egress(rest: &[String]) -> ExitCode {
        let (identity_path, members_path, target) = match (
            take_flag(rest, "--identity"),
            take_flag(rest, "--members"),
            take_flag(rest, "--target"),
        ) {
            (Some(i), Some(m), Some(t)) => (i, m, t),
            _ => {
                eprintln!(
                    "egress (live): need --identity <f> --members <f> --target <host:port>\n\n{}",
                    super::HELP
                );
                return ExitCode::from(2);
            }
        };
        // --circuits is OPTIONAL (T-RUST-4): omit it to use the RLN artifacts EMBEDDED in
        // this `live` binary (no external circuit files), or pass a dir to load them from disk.
        let circuits = take_flag(rest, "--circuits");

        // Resolve the ordered failover plan up front so a missing/ambiguous transport (or an
        // unusable directory with no LKG fallback) fails BEFORE the expensive proof build.
        let mut plan = match resolve_plan(rest) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("egress (live): {e}");
                return ExitCode::from(2);
            }
        };
        let epoch = take_flag(rest, "--epoch")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(current_epoch);
        let identity: IdentityFile = match load_json(&identity_path) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::from(2);
            }
        };
        let members: MembersFile = match load_json(&members_path) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::from(2);
            }
        };
        // K = this member's tier limit (T-FEAT-8): `--k` wins, else the identity file's `limit`
        // (written by `shade-tree identity --limit N` for a non-default tier), else the app default 8.
        // It MUST be the limit the member's leaf was enrolled with — the prover looks the leaf
        // up in `members`, so a wrong K fails there ("member_leaf not present"), never on the wire.
        let k = match take_flag(rest, "--k") {
            Some(s) => match s.parse::<u64>() {
                Ok(n) => n,
                Err(_) => {
                    eprintln!("egress (live): --k must be an integer (got {s:?})");
                    return ExitCode::from(2);
                }
            },
            None => identity.limit.unwrap_or(slotcursor::K_SLOTS),
        };
        if k < 1 || k > slotcursor::MAX_LIMIT {
            eprintln!(
                "egress (live): K={k} out of range 1..{} (RLN(20,16) range check is 16-bit)",
                slotcursor::MAX_LIMIT
            );
            return ExitCode::from(2);
        }
        // Default-on persistent allocation is durably committed BEFORE proof construction.
        // This intentionally burns a slot on a crash/local failure rather than allowing a
        // restarted process to reuse a nullifier. Manual slots are test-only and gated by an
        // unmistakable flag so production callers cannot casually disable the coordinator.
        let unsafe_reuse = rest
            .iter()
            .any(|s| s == "--unsafe-allow-slot-reuse-for-slashing-tests");
        let explicit_slot = take_flag(rest, "--slot");
        if explicit_slot.is_some() && !unsafe_reuse {
            eprintln!("egress (live): --slot bypasses crash-safe allocation; it requires --unsafe-allow-slot-reuse-for-slashing-tests and is only for isolated slashing tests");
            return ExitCode::from(2);
        }
        let slot = if unsafe_reuse {
            match explicit_slot {
                Some(s) => match s.parse::<u64>() {
                    Ok(slot) => slot,
                    Err(_) => {
                        eprintln!("egress (live): --slot must be an integer (got {s:?})");
                        return ExitCode::from(2);
                    }
                },
                None => 0,
            }
        } else {
            let path = match slot_cursor_path(rest, &identity.leaf) {
                Ok(path) => path,
                Err(e) => {
                    eprintln!("egress (live): REFUSING to prove — {e}");
                    return ExitCode::from(3);
                }
            };
            match slotcursor::allocate(&path, epoch, k) {
                Ok(allocation) if !allocation.exhausted() => {
                    allocation.slot.expect("checked non-exhausted")
                }
                Ok(_) => {
                    eprintln!("egress (live): epoch budget exhausted: used {k}/{k} slots in epoch {epoch}; wait for the protocol epoch to advance");
                    return ExitCode::from(4);
                }
                Err(e) => {
                    eprintln!("egress (live): REFUSING to prove — {e}");
                    return ExitCode::from(3);
                }
            }
        };
        if slot >= k {
            eprintln!("egress (live): --slot {slot} >= K {k} (out of this member's tier; the circuit would reject it)");
            return ExitCode::from(2);
        }
        let rln_identifier = take_flag(rest, "--rln-identifier").unwrap_or_else(|| "1".to_string());
        let nonce = take_flag(rest, "--nonce").unwrap_or_else(gen_nonce);

        // ZK artifact set (T-HARD-8). Embedded: hash-check the binary's own artifacts against
        // the lock it embeds, FAIL CLOSED on any drift, and take the set's content-derived id.
        // External --circuits dir: derive the id from that dir's verification_key.json.
        let client_artifact = match circuits.as_deref() {
            None => match shade_tree_rln::artifacts::verify_embedded() {
                Ok(c) => {
                    eprintln!(
                        "egress: embedded artifacts verified against zk-artifacts lock (artifact={}, trust={}, provenance={})",
                        c.artifact_id, c.trust, c.provenance
                    );
                    c.artifact_id
                }
                Err(e) => {
                    eprintln!("egress: REFUSING to prove — {e}");
                    return ExitCode::from(3);
                }
            },
            Some(dir) => {
                let vkey_path = format!("{dir}/verification_key.json");
                match std::fs::read(&vkey_path) {
                    Ok(bytes) => shade_tree_proto::artifact_id_of("rln", &bytes),
                    Err(e) => {
                        eprintln!("egress: cannot read {vkey_path} to derive the artifact id: {e}");
                        return ExitCode::from(2);
                    }
                }
            }
        };
        // Pick the artifact id against the first candidate that ADVERTISES an accepted set
        // (parity with client/shade-tree-client.mjs _pickArtifact): this binary holds ONE set, so
        // the pick is "ours if listed, else fail closed"; with no ad anywhere, optimistically ours.
        let gateway_ad: Option<&[String]> = plan.transports.iter().find_map(|t| match t {
            Transport::Onion {
                artifacts: Some(a), ..
            } if !a.is_empty() => Some(a.as_slice()),
            _ => None,
        });
        let artifact = match shade_tree_proto::select_artifact(
            gateway_ad,
            std::slice::from_ref(&client_artifact),
        ) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("egress: artifact negotiation failed: {e}");
                return ExitCode::from(2);
            }
        };

        // Build the REAL envelope in Rust (native tree + Groth16 prover).
        eprintln!(
            "egress: building RLN envelope (epoch={epoch}, slot={slot}, target={target}, artifact={artifact}, {}) ...",
            match circuits.as_deref() {
                Some(d) => format!("circuits={d}"),
                None => "circuits=embedded".to_string(),
            }
        );
        let input = shade_tree_rln::prover::EnvelopeInput {
            identity_secret: identity.identity_secret,
            member_leaf: identity.leaf,
            members: members.members,
            target: target.clone(),
            nonce,
            epoch,
            rln_identifier,
            user_message_limit: k,
            message_id: slot,
            circuits_dir: circuits,
        };
        let built = match shade_tree_rln::prover::build_envelope(&input) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("egress: build envelope failed: {e}");
                return ExitCode::from(3);
            }
        };

        // Frame the wire envelope byte-for-byte like client/shade-tree-client.mjs buildEnvelope.
        // `artifact` (T-HARD-8) names the ZK artifact set the proof was made with, so a gateway
        // in a dual-VK window verifies under the matching vkey (older gateways ignore the field).
        let envelope = serde_json::json!({
            "v": shade_tree_proto::PROTO_MAX,
            "target": built.target,
            "nonce": built.nonce,
            "artifact": artifact,
            "proof": {
                "snarkProof": { "proof": built.proof, "publicSignals": built.public_signals },
                "epoch": built.epoch,
                "rlnIdentifier": built.rln_identifier,
            },
            "nullifier": built.nullifier,
            "externalNullifier": built.external_nullifier,
            "share": { "x": built.share_x, "y": built.share_y },
        });
        let wire = serde_json::to_string(&envelope).expect("serialize envelope") + "\n";

        // FAILOVER LOOP (client/shade-tree-client.mjs connect()). The ONE envelope built above is
        // REUSED across every candidate (deterministic-retry: a retry reproduces the SAME
        // share). Rotate to the next candidate on a DIAL failure; a gateway that replied
        // (accept OR gate-refuse) is TERMINAL, matching the JS client. Each dial outcome is
        // fed back into the health cache (reportResult) so a failing gateway is deprioritized
        // next session.
        let n = plan.transports.len();
        let mut last_err: Option<String> = None;
        let mut outcome: Option<(String, serde_json::Value)> = None;
        // One bootstrapped Tor client shared across the whole loop (T-RUST-3b): lazily
        // created by the first onion candidate, reused by every later one.
        let mut tor: Option<TorSession> = None;
        // Move the transports out so `report` can borrow `plan.health` mutably in the loop.
        let transports = std::mem::take(&mut plan.transports);
        for (i, t) in transports.iter().enumerate() {
            eprintln!("egress: candidate {}/{}: {}", i + 1, n, t.label());
            match dial_send(t, &wire, &mut tor) {
                Ok(ack) => {
                    report(&mut plan.health, t, true); // dial succeeded (accept or refuse)
                    outcome = Some((t.label(), ack));
                    break;
                }
                Err(e) => {
                    report(&mut plan.health, t, false); // dial failed -> rotate
                    eprintln!("egress: candidate {} failed ({e}); rotating", t.label());
                    last_err = Some(e);
                }
            }
        }

        // Persist the session's liveness feedback once (best-effort; no-op if no health ctx).
        if let Some(ctx) = plan.health.as_mut() {
            health::save(Some(&ctx.cache_path), &mut ctx.cache);
        }

        let Some((gateway_label, ack)) = outcome else {
            eprintln!(
                "egress: all {n} candidate(s) failed; last error: {}",
                last_err.as_deref().unwrap_or("(none)")
            );
            return ExitCode::from(3);
        };

        let ok = ack
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if ok {
            println!("ok");
            println!("gateway: {gateway_label}");
            println!("target: {}", built.target);
            println!("nullifier: {}", built.nullifier);
            if let Some(r) = ack.get("receipt") {
                println!("receipt: {r}");
            }
            ExitCode::SUCCESS
        } else {
            let err = ack
                .get("err")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("(no err field)");
            println!("not-ok: gate-refused: {err}");
            // An artifact reject (T-HARD-8) advertises the gateway's accepted ids back; surface
            // them + whether ours is among them (parity with client/shade-tree-client.mjs connect()).
            if let Some(list) = ack.get("artifacts").and_then(serde_json::Value::as_array) {
                let ids: Vec<String> = list
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                let hint = match shade_tree_proto::select_artifact(
                    Some(&ids),
                    std::slice::from_ref(&client_artifact),
                ) {
                    Ok(id) => format!("retry with {id}"),
                    Err(e) => e.to_string(),
                };
                println!("gateway accepts artifacts: {} ({hint})", ids.join(","));
            }
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(sub) = args.first() else {
        println!("{HELP}");
        return ExitCode::from(2);
    };
    let rest = &args[1..];
    match sub.as_str() {
        "verify-directory" => cmd_verify_directory(rest),
        "fetch-directory" => cmd_fetch_directory(rest),
        "select" => cmd_select(rest),
        "verify-receipt" => cmd_verify_receipt(rest),
        "egress" => cmd_egress(rest),
        "help" | "--help" | "-h" => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        "version" | "--version" | "-V" => {
            println!("shade-tree {VERSION}");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown subcommand: {other}\n\n{HELP}");
            ExitCode::from(2)
        }
    }
}
