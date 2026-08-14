//! `rgoe` — the RGOE distributable client (single static binary, embedded Tor).
//!
//! This is the scaffold from T-RUST-0. It links `rgoe-proto` (the shared,
//! trust-critical checks) to prove the workspace wires together. The real client
//! (directory fetch + verify, RLN proving via zerokit, arti-dialed onion connect,
//! envelope send) lands in T-RUST-2/3. See docs/adr/0001-client-language.md.

use rgoe_proto::request_signal;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    // Prove the proto crate is linked and callable. `request_signal` is the one
    // real, deterministic primitive implemented at scaffold time (spec 6.2).
    let _ = request_signal("example.com:443", "0");

    println!("rgoe {VERSION} (scaffold; client impl is T-RUST-2)");
    println!("usage: rgoe <target-host:port>   [not yet implemented]");
    println!("see: docs/PROTOCOL-API.md, docs/adr/0001-client-language.md");
}
