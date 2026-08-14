//! `rgoe` — the RGOE distributable client (single static binary; embedded Tor is
//! T-RUST-2b, see [`live_egress`]).
//!
//! This is the **deterministic client MVP** (T-RUST-2): it parses UNTRUSTED
//! directory / receipt JSON, then runs the trust-critical checks from `rgoe-proto`
//! (the Rust port of the JS reference, gated by `testdata/vectors.json`). The two
//! non-deterministic LIVE pieces — the RLN Groth16 proof and the Tor dial for an
//! actual egress — are cleanly stubbed behind [`live_egress`] with an honest
//! "not yet implemented" path (their heavy native deps land in T-RUST-2b).
//!
//! serde/serde_json are used HERE (to parse untrusted JSON into local DTOs) and are
//! deliberately kept out of `rgoe-proto`, whose canonical byte path is serde-free.
//! See docs/adr/0001-client-language.md and docs/SHIP-PLAN.md T-RUST-2.

use std::collections::HashSet;
use std::process::ExitCode;

use rgoe_proto::{
    pick_gateway, selection_order, verify_directory, verify_receipt, Directory, GatewayEntry,
    Receipt,
};
use serde::Deserialize;

const VERSION: &str = env!("CARGO_PKG_VERSION");

// --------------------------------------------------------------------------
// Untrusted-JSON DTOs (serde) -> rgoe-proto structs (trust-critical checks)
// --------------------------------------------------------------------------
//
// These mirror the on-the-wire JSON shape (lib/directory.mjs signed directory,
// lib/receipt.mjs receipt). They are UNTRUSTED input: we deserialize them, map them
// into the rgoe-proto types, and let rgoe-proto do every security-critical decision
// (onion<->pubkey binding, pinned-signer signature, receipt onion binding + sig).

#[derive(Deserialize)]
struct DirEntryDto {
    onion: String,
    pubkey: String,
    weight: u64,
    health: String,
    #[serde(default)]
    operator: Option<String>,
    #[serde(default)]
    staked: Option<bool>,
}

#[derive(Deserialize)]
struct DirectoryDto {
    version: u64,
    issued: u64,
    #[serde(default)]
    gateways: Vec<DirEntryDto>,
    #[serde(default)]
    signer: Option<String>,
    #[serde(default)]
    signature: Option<String>,
}

impl DirectoryDto {
    fn into_proto(self) -> Directory {
        Directory {
            version: self.version,
            issued: self.issued,
            gateways: self
                .gateways
                .into_iter()
                .map(|g| GatewayEntry {
                    onion: g.onion,
                    pubkey: g.pubkey,
                    weight: g.weight,
                    health: g.health,
                    operator: g.operator,
                    staked: g.staked,
                })
                .collect(),
            signer: self.signer,
            signature: self.signature,
        }
    }
}

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
// Deferred: LIVE egress (T-RUST-2b) — RLN proof + Tor dial, honestly stubbed
// --------------------------------------------------------------------------

/// Perform a LIVE egress through a gateway: build the RLN Groth16 membership proof,
/// dial the gateway's v3 onion over embedded Tor, send the envelope, and stream the
/// tunnel. **Not implemented in this run (T-RUST-2).**
///
/// The two pieces this needs are the non-deterministic, heavy-native-dep half that
/// this MVP deliberately defers to **T-RUST-2b**:
///
/// - **RLN proving** via `zerokit` (PSE's canonical Rust RLN) — produces the envelope's
///   Groth16 proof committing to `x = calculate_signal_hash(request_signal(target, nonce))`.
/// - **Tor dial** via `arti-client` (embedded Tor: no system `tor` daemon, no SOCKS,
///   no `torrc`) — connects to the gateway onion and carries the CONNECT tunnel.
///
/// See docs/adr/0001-client-language.md (stack) and rgoe-client/Cargo.toml (the deferred
/// deps NOTE). The deterministic pieces an egress also needs — directory verify, gateway
/// selection, envelope/target binding, receipt verify — ARE implemented in `rgoe-proto`
/// and exercised by the subcommands below.
fn live_egress(_target: &str) -> Result<(), String> {
    Err("live egress is T-RUST-2b, not yet implemented \
         (needs zerokit RLN proving + arti Tor dial; see docs/adr/0001-client-language.md)"
        .to_string())
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

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const HELP: &str = "\
rgoe — Reputation-Gated Onion Egress client (deterministic MVP, T-RUST-2)

USAGE:
    rgoe <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    verify-directory <file> --signer <hex>
        Parse a signed directory JSON file and verify it against the pinned
        ed25519 signer (onion<->pubkey binding + signature). Prints ok / reason.

    select <dir-file> --signer <hex> [--seed <n>]
        Verify the directory, then print the weighted-random chosen gateway onion
        and the full failover order. --seed makes the choice reproducible.

    verify-receipt <receipt-file> --onion <onion>
        Parse an egress-success receipt JSON file and verify it (onion<->pubkey
        binding + ed25519 signature), bound to --onion. Prints ok / reason.

    egress <host:port>
        LIVE egress through the fleet. NOT IMPLEMENTED in this build — the RLN
        proof + Tor dial are deferred to T-RUST-2b. Prints the honest error.

    help, --help, -h        Show this help.
    version, --version, -V  Show the version.

NOTES:
    The trust-critical checks come from the rgoe-proto crate (a Rust port of the
    JS reference, gated byte-for-byte by testdata/vectors.json). This binary parses
    untrusted JSON and calls those checks; it performs no live network I/O yet.
    See docs/adr/0001-client-language.md.";

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
    let dir = dto.into_proto();
    // Zero-trust: never select from an unverified directory.
    if let Err(e) = verify_directory(&dir, &signer) {
        println!("not-ok: {e}");
        return ExitCode::from(1);
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
    let Some(target) = args.first() else {
        eprintln!("egress: missing <host:port>");
        return ExitCode::from(2);
    };
    match live_egress(target) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("not-implemented: {e}");
            ExitCode::from(3)
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
        "select" => cmd_select(rest),
        "verify-receipt" => cmd_verify_receipt(rest),
        "egress" => cmd_egress(rest),
        "help" | "--help" | "-h" => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        "version" | "--version" | "-V" => {
            println!("rgoe {VERSION}");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown subcommand: {other}\n\n{HELP}");
            ExitCode::from(2)
        }
    }
}
