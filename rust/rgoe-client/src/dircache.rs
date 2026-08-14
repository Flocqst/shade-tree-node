//! Directory loading with last-known-good caching + rollback / max-age guards —
//! the Rust port of `client/selection.mjs`'s `ensureLoaded` / `loadFromBootnode`
//! discipline (T-RUST-3, slice 2). Default-build (serde_json + rgoe-proto only).
//!
//! A verified directory is cached to disk; if a fresh fetch fails or is
//! unverifiable, the client falls back to the last-known-good cache. It NEVER
//! serves an unverified directory (both the fresh and the cached path run
//! `verify_directory`, which enforces the pinned signer + the onion<->key binding).
//! Two guards from `selection.mjs` are ported here because they are client-side
//! session state, not stateless proto checks:
//!
//!   - ROLLBACK FLOOR (audit loop-15 F2): a FRESH directory whose `issued` predates
//!     the last-known-good cache's `issued` is refused (a hostile/replaying source
//!     re-serving an old, validly-signed directory to resurrect a dropped gateway).
//!     For a one-shot CLI the persisted cache IS the high-water mark, so the cached
//!     `issued` is the floor. A same-or-newer `issued` is accepted (idempotent
//!     refetch is fine) and overwrites the cache, raising the floor.
//!   - ABSOLUTE MAX-AGE (T-FEAT-21): OPTIONAL. A FRESH directory whose `issued` is
//!     older than `now - max_age - skew` is refused (a far-behind or replaying
//!     source serving a months-old-but-validly-signed directory to a cold client).
//!
//! The last-known-good CACHE is EXEMPT from both guards: a stale-but-verified cache
//! is still better than going dark, exactly as `selection.mjs` treats it.

use std::path::Path;

use rgoe_proto::{verify_directory, Caps, Directory, GatewayEntry, ProtoCaps};
use serde::Deserialize;

// --------------------------------------------------------------------------
// Untrusted-JSON DTOs (serde) -> rgoe-proto Directory (trust-critical checks)
// --------------------------------------------------------------------------
//
// Mirrors the on-the-wire signed-directory JSON (lib/directory.mjs). UNTRUSTED
// input: we deserialize it, map it into rgoe-proto's Directory, and let
// verify_directory make every security-critical decision.

#[derive(Deserialize)]
pub struct DirEntryDto {
    pub onion: String,
    pub pubkey: String,
    pub weight: u64,
    pub health: String,
    #[serde(default)]
    pub operator: Option<String>,
    #[serde(default)]
    pub staked: Option<bool>,
    // T-FEAT-10c: carry the self-declared caps + their onion-bound signature through so
    // verify_directory can enforce capsSig (bad-caps-sig) and the client can filter on
    // capability. OPTIONAL/additive: absent on a legacy entry (verify + selection unchanged).
    #[serde(default)]
    pub caps: Option<CapsDto>,
    #[serde(rename = "capsSig", default)]
    pub caps_sig: Option<String>,
}

/// Untrusted caps object on a directory entry (`g.caps`). Deserialized leniently, then
/// mapped to rgoe_proto's `Caps` and CANONICALIZED (dedup/sort/range-check) by the proto
/// crate — this DTO does no validation itself.
#[derive(Deserialize)]
pub struct CapsDto {
    #[serde(default)]
    pub ports: Option<Vec<i64>>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub proto: Option<ProtoCapsDto>,
}

#[derive(Deserialize)]
pub struct ProtoCapsDto {
    pub min: i64,
    pub max: i64,
}

#[derive(Deserialize)]
pub struct DirectoryDto {
    pub version: u64,
    pub issued: u64,
    #[serde(default)]
    pub gateways: Vec<DirEntryDto>,
    #[serde(default)]
    pub signer: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    // T-FEAT-9c: carry the M-of-N threshold fields through so the client consumes
    // threshold-signed directories (verify_directory auto-delegates when present).
    #[serde(default)]
    pub signers: Option<Vec<String>>,
    #[serde(default)]
    pub signatures: Option<Vec<String>>,
    #[serde(default)]
    pub threshold: Option<i64>,
}

impl DirectoryDto {
    pub fn into_proto(self) -> Directory {
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
                    caps: g.caps.map(|c| Caps {
                        ports: c.ports,
                        region: c.region,
                        proto: c.proto.map(|p| ProtoCaps {
                            min: p.min,
                            max: p.max,
                        }),
                    }),
                    caps_sig: g.caps_sig,
                })
                .collect(),
            signer: self.signer,
            signature: self.signature,
            signers: self.signers,
            signatures: self.signatures,
            threshold: self.threshold,
        }
    }
}

/// Parse untrusted directory JSON into a proto `Directory` (no verification yet).
pub fn parse_directory(raw: &str) -> Result<Directory, String> {
    let dto: DirectoryDto =
        serde_json::from_str(raw).map_err(|e| format!("directory parse: {e}"))?;
    Ok(dto.into_proto())
}

/// Parse + verify (pinned signer + onion<->key binding). Never returns an
/// unverified directory.
pub fn parse_and_verify(raw: &str, signer: &str) -> Result<Directory, String> {
    let dir = parse_directory(raw)?;
    verify_directory(&dir, signer).map_err(|e| format!("directory rejected: {e}"))?;
    Ok(dir)
}

/// Where the accepted directory came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// A freshly fetched/read directory that verified and passed the guards.
    Fresh,
    /// The last-known-good on-disk cache (the fresh path failed or was refused).
    Cache,
}

/// The accepted directory + provenance.
#[derive(Debug)]
pub struct LoadOutcome {
    pub dir: Directory,
    pub source: Source,
    /// Why the fresh path was not used, when `source == Cache`.
    pub fresh_error: Option<String>,
}

/// Optional absolute-freshness bound (T-FEAT-21). Both in milliseconds.
#[derive(Clone, Copy, Default)]
pub struct MaxAge {
    pub max_age_ms: Option<u64>,
    pub skew_ms: u64,
}

/// Read + verify the on-disk cache. Best-effort: any error (missing/corrupt/
/// unverifiable) yields `None`, so a broken cache never serves an unverified
/// directory (verify runs here too).
fn read_verified_cache(cache_path: Option<&Path>, signer: &str) -> Option<Directory> {
    let raw = std::fs::read_to_string(cache_path?).ok()?;
    parse_and_verify(&raw, signer).ok()
}

/// Best-effort write-through of an accepted fresh directory to the LKG cache.
fn write_cache(cache_path: Option<&Path>, raw: &str) {
    let Some(path) = cache_path else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = if raw.ends_with('\n') {
        raw.to_string()
    } else {
        format!("{raw}\n")
    };
    let _ = std::fs::write(path, body);
}

/// Resolve the directory to use from a (maybe-failed) FRESH fetch + the LKG cache.
///
/// `fresh` is the result of reading a file / fetching over the network; an `Err`
/// models a dead or unreachable source. `signer` is the pinned ed25519 signer hex.
/// `now_ms` is the current wall clock in ms (for the max-age guard).
///
/// Returns the accepted directory + provenance, or an error only when BOTH the
/// fresh path and the cache are unusable (fail-closed: never an unverified list).
pub fn resolve_directory(
    fresh: Result<String, String>,
    cache_path: Option<&Path>,
    signer: &str,
    max_age: MaxAge,
    now_ms: u64,
) -> Result<LoadOutcome, String> {
    // The LKG cache doubles as the monotonic `issued` floor for the rollback guard.
    let cached = read_verified_cache(cache_path, signer);
    let floor = cached.as_ref().map(|d| d.issued).unwrap_or(0);

    // Reason the fresh path was rejected (drives the cache-fallback message).
    let fresh_reject: String = match fresh {
        Ok(raw) => match parse_and_verify(&raw, signer) {
            Ok(dir) => {
                // Rollback guard: a fresh directory must not move `issued` BACKWARD
                // relative to the last-known-good we already accepted.
                if dir.issued < floor {
                    format!(
                        "directory rollback rejected: issued {} < cached {floor}",
                        dir.issued
                    )
                } else if let Some(max) = max_age.max_age_ms {
                    // Absolute max-age guard (fresh only; cache is exempt).
                    let age_ms = now_ms.saturating_sub(dir.issued.saturating_mul(1000));
                    if age_ms > max + max_age.skew_ms {
                        format!(
                            "directory too stale: issued {}s is {}s old > max-age {}s (bound+skew)",
                            dir.issued,
                            age_ms / 1000,
                            (max + max_age.skew_ms) / 1000
                        )
                    } else {
                        // Accept: overwrite the LKG cache (raising the floor).
                        write_cache(cache_path, &raw);
                        return Ok(LoadOutcome {
                            dir,
                            source: Source::Fresh,
                            fresh_error: None,
                        });
                    }
                } else {
                    write_cache(cache_path, &raw);
                    return Ok(LoadOutcome {
                        dir,
                        source: Source::Fresh,
                        fresh_error: None,
                    });
                }
            }
            Err(e) => e,
        },
        Err(e) => e,
    };

    // Fresh path unusable -> fall back to the last-known-good cache (verified above).
    match cached {
        Some(dir) => Ok(LoadOutcome {
            dir,
            source: Source::Cache,
            fresh_error: Some(fresh_reject),
        }),
        None => Err(format!(
            "no verifiable directory (fresh: {fresh_reject}; no valid cache)"
        )),
    }
}

// --------------------------------------------------------------------------
// Minimal HTTP/1.1 over a byte stream (bootnode discovery). Ports bootnode/
// fetch.mjs: the bootnode always sends a Content-Length body over a
// Connection: close socket, so header/body split on the first CRLFCRLF is
// enough. Used over plain TCP here (default build) and over an arti Tor stream
// in the `live` egress module.
// --------------------------------------------------------------------------

/// Generous cap on a bootnode response so a hostile/misbehaving source gets a
/// bounded read, not an OOM (`bootnode/fetch.mjs` `MAX_RESP`, 2 MiB).
pub const MAX_HTTP_RESP: usize = 2 * 1024 * 1024;

/// Build a `GET <path> HTTP/1.1` request for the bootnode onion (Connection:
/// close so the body ends at EOF).
pub fn http_get_request(host: &str, path: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    )
}

/// Parse a full HTTP/1.1 response, returning the body iff the status is 200.
/// Mirrors `bootnode/fetch.mjs` `parseHttp` (no chunked support needed).
pub fn parse_http_body(buf: &[u8]) -> Result<String, String> {
    let sep = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "no HTTP header terminator".to_string())?;
    let head = String::from_utf8_lossy(&buf[..sep]);
    let status_line = head.lines().next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad HTTP status line: {status_line:?}"))?;
    let body = String::from_utf8_lossy(&buf[sep + 4..]).to_string();
    if status != 200 {
        return Err(format!(
            "bootnode HTTP {status}: {}",
            &body.chars().take(200).collect::<String>()
        ));
    }
    Ok(body)
}

/// Fetch `path` from a plain-TCP HTTP endpoint (the `--bootnode-tcp` escape hatch,
/// analogous to `--plain-tcp` for egress). Reads to EOF, capped at [`MAX_HTTP_RESP`].
pub fn fetch_http_plain(dial: &str, host: &str, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut stream = TcpStream::connect(dial).map_err(|e| format!("connect {dial}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    stream
        .write_all(http_get_request(host, path).as_bytes())
        .map_err(|e| format!("write request: {e}"))?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .map_err(|e| format!("read response: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HTTP_RESP {
            return Err(format!("bootnode response exceeded {MAX_HTTP_RESP} bytes"));
        }
    }
    parse_http_body(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A tiny valid signed directory + its pinned signer, generated once with the
    // JS reference (group/sign-directory.mjs) so verify_directory accepts it. Kept
    // inline so these tests need no fixtures or network.
    const SIGNER: &str = include_str!("testdata/lkg_signer.txt");
    fn signed_dir(issued: u64) -> String {
        // The signature only covers {version,issued,gateways}; we hold gateways +
        // version fixed and vary issued, so each issued value needs its own
        // signature. The fixtures below are pre-signed for the two issued values
        // the tests use (100 and 200).
        match issued {
            100 => include_str!("testdata/lkg_dir_100.json").to_string(),
            200 => include_str!("testdata/lkg_dir_200.json").to_string(),
            _ => panic!("no fixture for issued={issued}"),
        }
    }

    fn workdir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("rgoe-dircache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn fresh_verifies_and_writes_cache() {
        let d = workdir("fresh");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        let out = resolve_directory(
            Ok(signed_dir(100)),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        assert_eq!(out.source, Source::Fresh);
        assert_eq!(out.dir.issued, 100);
        assert!(cache.exists(), "LKG cache written");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn fresh_failure_falls_back_to_verified_cache() {
        let d = workdir("lkg");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        // Seed a good cache.
        resolve_directory(
            Ok(signed_dir(100)),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        // Fresh fetch fails -> LKG cache is used (never nothing).
        let out = resolve_directory(
            Err("bootnode unreachable".into()),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        assert_eq!(out.source, Source::Cache);
        assert_eq!(out.dir.issued, 100);
        assert!(out.fresh_error.unwrap().contains("unreachable"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unverifiable_fresh_falls_back_never_served() {
        let d = workdir("badfresh");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        resolve_directory(
            Ok(signed_dir(100)),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        // A tampered fresh directory (bad signature) must NOT be served.
        let tampered = signed_dir(100).replace("\"issued\":100", "\"issued\":999");
        let out =
            resolve_directory(Ok(tampered), Some(&cache), signer, MaxAge::default(), 0).unwrap();
        assert_eq!(out.source, Source::Cache);
        assert_eq!(out.dir.issued, 100); // the verified cache, not the tampered 999
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rollback_fresh_is_refused_cache_kept() {
        let d = workdir("rollback");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        // Accept the newer directory first (raises the floor to 200).
        resolve_directory(
            Ok(signed_dir(200)),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        // A validly-signed OLDER directory (issued 100 < 200) is a rollback: refused.
        let out = resolve_directory(
            Ok(signed_dir(100)),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        assert_eq!(out.source, Source::Cache);
        assert_eq!(out.dir.issued, 200);
        assert!(out.fresh_error.unwrap().contains("rollback"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn max_age_rejects_stale_fresh() {
        let d = workdir("maxage");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        resolve_directory(
            Ok(signed_dir(200)),
            Some(&cache),
            signer,
            MaxAge::default(),
            200_000,
        )
        .unwrap();
        // issued=100s => 100_000ms; now=10_000_000ms => age ~9990s. max-age 60s => reject fresh.
        let ma = MaxAge {
            max_age_ms: Some(60_000),
            skew_ms: 0,
        };
        // Use a distinct cache so the 100-directory is not blocked by the 200 floor.
        let cache2 = d.join("dir2.lkg");
        resolve_directory(
            Ok(signed_dir(100)),
            Some(&cache2),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap();
        let out =
            resolve_directory(Ok(signed_dir(100)), Some(&cache2), signer, ma, 10_000_000).unwrap();
        assert_eq!(out.source, Source::Cache); // stale fresh refused, cache kept
        assert!(out.fresh_error.unwrap().contains("too stale"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_fresh_no_cache_is_fatal() {
        let d = workdir("fatal");
        let cache = d.join("dir.lkg");
        let signer = SIGNER.trim();
        let err = resolve_directory(
            Err("dead".into()),
            Some(&cache),
            signer,
            MaxAge::default(),
            0,
        )
        .unwrap_err();
        assert!(err.contains("no verifiable directory"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parse_http_body_extracts_200_and_rejects_non_200() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(parse_http_body(ok).unwrap(), "{}");
        let notfound = b"HTTP/1.1 404 Not Found\r\n\r\nnope";
        assert!(parse_http_body(notfound).is_err());
    }
}
