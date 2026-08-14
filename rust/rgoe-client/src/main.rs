//! `rgoe` — the RGOE distributable client (single static binary with embedded Tor).
//!
//! This is the **deterministic client MVP** (T-RUST-2): it parses UNTRUSTED
//! directory / receipt JSON, then runs the trust-critical checks from `rgoe-proto`
//! (the Rust port of the JS reference, gated by `testdata/vectors.json`). The two
//! non-deterministic LIVE pieces — the RLN Groth16 proof (T-RUST-2b/2c/2d) and the
//! embedded-Tor onion dial (T-RUST-2e, `arti-client`) — compile only under the
//! `live` cargo feature (see the [`live`] module); the default build stays sub-second.
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
// LIVE egress
// --------------------------------------------------------------------------
//
// T-RUST-2d wired the RLN prover + native tree into `rgoe egress` behind the `live`
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
         transport). Rebuild with `cargo build -p rgoe-client --features live`. \
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

    egress <TRANSPORT> --identity <f> --members <f> --target <host:port>
           --circuits <dir> [--epoch <n>] [--slot <i>] [--rln-identifier <n>]
           [--k <n>] [--nonce <hex>]
        LIVE egress (requires a `--features live` build). Builds a REAL RLN envelope
        in Rust (native depth-20 Poseidon tree + Groth16 proof over the repo's
        circuits) binding <target>, opens a connection to the gateway, sends the
        envelope exactly as client/rgoe-client.mjs does, and reports accept/reject.
        Choose exactly one TRANSPORT:
          --directory <f> --signer <hex>  Verify the signed directory, pick a gateway,
                                          and dial its .onion over EMBEDDED TOR (arti;
                                          no system tor daemon, no SOCKS). [default path]
          --onion <addr[:port]>           Dial this specific .onion over embedded Tor
                                          (default port 80, the gateway HS virtual port).
          --plain-tcp <host:port>         Escape hatch: dial plain TCP, no Tor (the
                                          loop-22 socket path; used by the CI harness).
        Envelope options:
          --identity  JSON { identitySecret, leaf } (the member's derived secret + leaf)
          --members   JSON { members: [leaf,...] }  (the ordered group, same as the gateway)
          --target    host:port bound into the proof (the egress destination)
          --circuits  dir with rln.wasm + rln_final.zkey + verification_key.json
          --epoch     epoch to prove for (default: floor(now/RGOE_EPOCH_SECONDS), K=120s)
          --slot      messageId 0<=i<K (default 0)   --k  userMessageLimit (default 8)
          --rln-identifier  group id (default 1)     --nonce  32-hex per-request nonce
        Without the feature: prints an honest not-built error.

    help, --help, -h        Show this help.
    version, --version, -V  Show the version.

NOTES:
    The trust-critical checks come from the rgoe-proto crate (a Rust port of the
    JS reference, gated byte-for-byte by testdata/vectors.json). This binary parses
    untrusted JSON and calls those checks. Live network I/O (the RLN prover and the
    embedded-Tor onion dial) is compiled only under `--features live`.
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
//   - SEND: `JSON.stringify(envelope) + "\n"` — client/rgoe-client.mjs:313,341.
//     envelope = { v, target, nonce, proof, nullifier, externalNullifier, share }
//     (buildEnvelope, client/rgoe-client.mjs:123); the nested `proof` is the wire-safe
//     RLNFullProof { snarkProof:{proof,publicSignals}, epoch, rlnIdentifier } assembled
//     exactly as rust/rgoe-rln/interop/verify-envelope.mjs:13-25.
//   - RECV: the gateway replies `JSON.stringify(ack) + "\n"` (gateway.mjs reply(),
//     :333-335; successAck `{ ok: true }` at :594) once verifyEnvelope passes, the target
//     policy admits, the spent-set admits, and the upstream :target connects. So `ok:true`
//     is a full end-to-end ACCEPT (version gate + Groth16 verify + proxy established).
//
// TRANSPORT (T-RUST-2e): `--directory/--signer` (or `--onion`) dials the gateway's `.onion`
// over EMBEDDED TOR — arti bootstraps its own Tor client (no system tor daemon, no SOCKS)
// and `TorClient::connect((onion, 80))` opens an anonymous stream to the gateway HS virtual
// port 80 (bootstrap.sh: `HiddenServicePort 80 127.0.0.1:8443`), matching the JS client's
// `destination: { host: onion+".onion", port: 80 }` (client/rgoe-client.mjs:271). The
// `--plain-tcp <host:port>` escape hatch keeps the loop-22 plain-socket path (the CI
// harness egress-run.sh uses it) so the always-green Layer-3 accept is unaffected.
#[cfg(feature = "live")]
mod live {
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::process::ExitCode;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde::Deserialize;

    use super::{default_seed, mulberry32, read_file, take_flag, DirectoryDto};

    /// The resolved transport for one egress: exactly one of these is selected from the
    /// CLI flags. Plain-TCP is the loop-22 escape hatch; Onion is the default T-RUST-2e path.
    enum Transport {
        /// `--plain-tcp <host:port>` — dial plain TCP, no Tor (the CI-harness / socket path).
        PlainTcp(String),
        /// `--onion <addr>` or a directory selection — dial `<onion>.onion:<port>` over Tor.
        Onion { onion: String, port: u16 },
    }

    #[derive(Deserialize)]
    struct IdentityFile {
        #[serde(rename = "identitySecret")]
        identity_secret: String,
        leaf: String,
    }

    #[derive(Deserialize)]
    struct MembersFile {
        members: Vec<String>,
    }

    // lib/rln.mjs EPOCH_SECONDS default is 120s; RGOE_EPOCH_SECONDS overrides to match a
    // gateway configured otherwise. verifyEnvelope accepts this-or-previous epoch, so a
    // wall-clock-derived epoch has a full window of slack against the gateway's own clock.
    fn epoch_seconds() -> u64 {
        std::env::var("RGOE_EPOCH_SECONDS")
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

    // A 16-byte random nonce -> 32 hex chars, matching client/rgoe-client.mjs
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

    // Reuse the deterministic select path: verify the signed directory against the pinned
    // signer, then weighted-pick a gateway and return its `.onion` (the SAME select code the
    // deterministic `select` subcommand runs). The returned onion is what arti then dials
    // over Tor — so the transport target comes from a signature-verified directory, never a
    // raw host the caller typed.
    fn select_onion(dir_file: &str, signer: &str) -> Result<String, String> {
        use rgoe_proto::{pick_gateway, verify_directory};
        let dto: DirectoryDto = load_json(dir_file)?;
        let dir = dto.into_proto();
        verify_directory(&dir, signer).map_err(|e| format!("directory rejected: {e}"))?;
        let mut rng = mulberry32(default_seed());
        let empty: HashSet<String> = HashSet::new();
        match pick_gateway(&dir, &empty, &mut rng) {
            Some(g) => Ok(g.onion.clone()),
            None => Err("no gateways in directory".into()),
        }
    }

    // Parse `<addr[:port]>` into (onion-without-suffix, port). Default port 80 = the gateway
    // HS virtual port. The `.onion` suffix is normalized off here and re-added at dial time,
    // exactly like the JS client (client/rgoe-client.mjs:221,271).
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

    // Dial the gateway `.onion` over EMBEDDED TOR (arti) and send the framed envelope,
    // reading one newline-terminated ack — the read/frame contract is IDENTICAL to the
    // plain-TCP `send_envelope`, so the gateway cannot tell the transports apart.
    //
    // The RLN envelope is built BEFORE this runs (build_envelope spins up and drops its own
    // Tokio runtime for the wasm witness), so creating the arti runtime here never nests one
    // runtime inside another. Bootstrap + connect are each bounded by RGOE_TOR_TIMEOUT_SECS.
    fn tor_dial_and_send(onion: &str, port: u16, wire: &str) -> Result<serde_json::Value, String> {
        use arti_client::{TorClient, TorClientConfig};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let timeout_secs: u64 = std::env::var("RGOE_TOR_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n: &u64| n > 0)
            .unwrap_or(180);
        let timeout = Duration::from_secs(timeout_secs);

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("tokio runtime: {e}"))?;

        rt.block_on(async move {
            eprintln!("egress: bootstrapping embedded Tor (arti) ...");
            let config = TorClientConfig::default();
            let tor = tokio::time::timeout(timeout, TorClient::create_bootstrapped(config))
                .await
                .map_err(|_| format!("arti bootstrap timed out after {timeout_secs}s"))?
                .map_err(|e| format!("arti bootstrap: {e}"))?;

            let host = format!("{onion}.onion");
            eprintln!("egress: dialing {host}:{port} over Tor ...");
            let mut stream = tokio::time::timeout(timeout, tor.connect((host.as_str(), port)))
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

    // Resolve exactly one transport from the CLI flags. Order of precedence:
    //   --plain-tcp  (explicit escape hatch, no Tor)  >  --onion  >  --directory/--signer.
    // A directory selection is the default T-RUST-2e path (verified directory -> onion).
    fn resolve_transport(rest: &[String]) -> Result<Transport, String> {
        if let Some(hp) = take_flag(rest, "--plain-tcp") {
            return Ok(Transport::PlainTcp(hp));
        }
        if let Some(addr) = take_flag(rest, "--onion") {
            let (onion, port) = parse_onion_addr(&addr, 80)?;
            return Ok(Transport::Onion { onion, port });
        }
        if let (Some(dirf), Some(signer)) =
            (take_flag(rest, "--directory"), take_flag(rest, "--signer"))
        {
            let onion = select_onion(&dirf, &signer)?;
            let (onion, _) = parse_onion_addr(&onion, 80)?;
            eprintln!("egress: selected gateway {onion}.onion from verified directory");
            return Ok(Transport::Onion { onion, port: 80 });
        }
        Err(
            "no transport: pass --directory <f> --signer <hex> (dial the selected onion over \
             Tor), --onion <addr> (dial a specific onion over Tor), or --plain-tcp <host:port> \
             (no Tor)"
                .to_string(),
        )
    }

    pub fn run_egress(rest: &[String]) -> ExitCode {
        let (identity_path, members_path, target, circuits) = match (
            take_flag(rest, "--identity"),
            take_flag(rest, "--members"),
            take_flag(rest, "--target"),
            take_flag(rest, "--circuits"),
        ) {
            (Some(i), Some(m), Some(t), Some(c)) => (i, m, t, c),
            _ => {
                eprintln!("egress (live): need --identity <f> --members <f> --target <host:port> --circuits <dir>\n\n{}", super::HELP);
                return ExitCode::from(2);
            }
        };

        // Resolve the transport up front so a missing/ambiguous transport fails BEFORE the
        // (expensive) proof build.
        let transport = match resolve_transport(rest) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("egress (live): {e}");
                return ExitCode::from(2);
            }
        };
        let epoch = take_flag(rest, "--epoch")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(current_epoch);
        let slot = take_flag(rest, "--slot")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let k = take_flag(rest, "--k")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(8);
        let rln_identifier = take_flag(rest, "--rln-identifier").unwrap_or_else(|| "1".to_string());
        let nonce = take_flag(rest, "--nonce").unwrap_or_else(gen_nonce);

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

        // Build the REAL envelope in Rust (native tree + Groth16 prover).
        eprintln!(
            "egress: building RLN envelope (epoch={epoch}, slot={slot}, target={target}) ..."
        );
        let input = rgoe_rln::prover::EnvelopeInput {
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
        let built = match rgoe_rln::prover::build_envelope(&input) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("egress: build envelope failed: {e}");
                return ExitCode::from(3);
            }
        };

        // Frame the wire envelope byte-for-byte like client/rgoe-client.mjs buildEnvelope.
        let envelope = serde_json::json!({
            "v": 3,
            "target": built.target,
            "nonce": built.nonce,
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

        // Dispatch to the resolved transport. Both send the SAME `wire` and read one
        // newline-terminated ack; `gateway` in the success print is the human-readable dial.
        let (gateway_label, sent) = match &transport {
            Transport::PlainTcp(hp) => {
                eprintln!("egress: dialing gateway {hp} (plain TCP, no Tor) ...");
                (hp.clone(), send_envelope(hp, &wire))
            }
            Transport::Onion { onion, port } => {
                let label = format!("{onion}.onion:{port}");
                (label, tor_dial_and_send(onion, *port, &wire))
            }
        };

        match sent {
            Ok(ack) => {
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
                    ExitCode::from(1)
                }
            }
            Err(e) => {
                eprintln!("egress: {e}");
                ExitCode::from(3)
            }
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
