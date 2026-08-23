//! Persisted per-epoch K-slot cursor — the cross-invocation counterpart to the JS
//! client's `makeSlotPool` (client/shade-tree-client.mjs).
//!
//! The JS client is a long-lived process: its `makeSlotPool().nextSlot()` hands out
//! slots `0,1,2,…,K-1` (wrapping) so each request in an epoch uses a DISTINCT
//! message-id — a distinct nullifier — up to the RLN rate cap of K/epoch. The Rust
//! `shade-tree egress` is a ONE-SHOT CLI: without persistence every invocation would reuse
//! slot 0 and mint the SAME nullifier, wasting the K-1 other slots. This module keeps
//! a tiny on-disk cursor so consecutive `shade-tree egress` runs within one epoch advance
//! the slot exactly like `nextSlot()`, and reset to 0 when the epoch rolls over.
//!
//! On-disk shape (versioned envelope, like `health.rs`):
//!
//! ```json
//! { "version": 1, "epoch": 42, "nextSlot": 3 }
//! ```
//!
//! Privacy + scope (matches `health.rs`): a LOCAL file only, never sent anywhere. It
//! stores ONLY two small non-secret integers — the epoch it belongs to and the next
//! slot index to hand out. It contains NO identity secret, NO nullifier, NO proof, NO
//! member data: knowing `{epoch, nextSlot}` reveals nothing an on-chain observer of
//! the epoch couldn't already count. Bounded by construction: one file, two ints.
//!
//! Everything here is default-build serde_json only (no `arti`/`ark`/`tokio`), so the
//! unit is plainly testable; the module is compiled only under `live` (where egress
//! uses it) or `test` (where these unit tests run).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// K = `userMessageLimit` = K_SLOTS: the RLN rate cap of K distinct slots (message
/// ids), hence K distinct nullifiers, per epoch. Mirrors `lib/rln.mjs`
/// `export const K_SLOTS = Number(process.env.SHADE_TREE_SLOTS || 8)` (line 66) — the app
/// default, and the same default this client's `--k`/`userMessageLimit` flag uses.
pub const K_SLOTS: u64 = 8;

/// The largest tier limit the circuit can range-check: RLN(20, 16) compares messageId and
/// userMessageLimit with a 16-bit LessThan, so a limit MUST be <= 2^16 - 1 (lib/rln.mjs
/// MAX_LIMIT). Reputation tiers (T-FEAT-8) are per-leaf limits inside this bound.
pub const MAX_LIMIT: u64 = 65535;

/// The persisted cursor: only the epoch it belongs to and the NEXT slot index to hand
/// out. Two non-secret integers — never any identity/secret/nullifier material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotCursor {
    pub epoch: u64,
    pub next_slot: u64,
}

// The versioned envelope we write and (leniently) read. `nextSlot` matches a JS wire
// key so the file reads naturally alongside the health cache; absent fields decode to
// `None` and are treated as "no usable cursor" (fresh start at slot 0).
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    epoch: Option<u64>,
    #[serde(rename = "nextSlot", default)]
    next_slot: Option<u64>,
}

#[derive(Serialize)]
struct WriteEnvelope {
    version: u64,
    epoch: u64,
    #[serde(rename = "nextSlot")]
    next_slot: u64,
}

/// Read the persisted cursor. Best-effort and TOTAL: any error
/// (missing/unwritable/corrupt/partial) yields `None`, so a broken cursor can never
/// break egress — it just falls back to slot 0.
pub fn load(path: Option<&Path>) -> Option<SlotCursor> {
    let path = path?;
    let raw = std::fs::read_to_string(path).ok()?;
    let env = serde_json::from_str::<Envelope>(&raw).ok()?;
    Some(SlotCursor {
        epoch: env.epoch?,
        next_slot: env.next_slot?,
    })
}

/// Write the cursor. Best-effort: a failure (no path, read-only dir, ...) is swallowed
/// and returns `false`, so persistence-off never affects egress (the run still gets a
/// valid slot from the in-memory computation). Returns `true` iff the file was written.
pub fn save(path: Option<&Path>, cursor: SlotCursor) -> bool {
    let Some(path) = path else { return false };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = match serde_json::to_string_pretty(&WriteEnvelope {
        version: 1,
        epoch: cursor.epoch,
        next_slot: cursor.next_slot,
    }) {
        Ok(s) => s + "\n",
        Err(_) => return false,
    };
    std::fs::write(path, body).is_ok()
}

/// Resolve THIS run's slot and persist the advance — the cross-invocation port of the
/// JS `makeSlotPool().nextSlot()` (client/shade-tree-client.mjs): hand out the cursor, then
/// bump it modulo K. A new epoch (or the absence of any cursor) rolls back to 0, so
/// slots run `0,1,…,K-1,0,…` within an epoch and reset when it rolls.
///
/// Best-effort throughout: a failed load falls back to slot 0; a failed save just means
/// the NEXT run also starts at 0. It never errors and never blocks egress.
pub fn next_slot(path: Option<&Path>, epoch: u64, k: u64) -> u64 {
    // guard: K must be in 1..=MAX_LIMIT (a tier limit; the modulo needs >= 1 and the circuit's
    // 16-bit range check needs <= 65535). `shade-tree egress` rejects an out-of-range --k before
    // reaching here; this keeps the cursor arithmetic well-defined for any caller.
    let k = k.clamp(1, MAX_LIMIT);
    // Continue the cursor only within the SAME epoch and while it's still in range
    // (a shrunk --k could leave a persisted next_slot >= k) — otherwise reset to 0.
    let base = match load(path) {
        Some(c) if c.epoch == epoch && c.next_slot < k => c.next_slot,
        _ => 0,
    };
    let next = (base + 1) % k;
    save(
        path,
        SlotCursor {
            epoch,
            next_slot: next,
        },
    );
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    // A unique temp path per call so parallel tests never collide.
    fn temp_path() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "shade-tree-slotcursor-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p.push("slot-cursor.json");
        p
    }

    #[test]
    fn fresh_starts_at_zero_and_advances() {
        let path = temp_path();
        assert_eq!(next_slot(Some(&path), 5, 8), 0);
        assert_eq!(next_slot(Some(&path), 5, 8), 1);
        assert_eq!(next_slot(Some(&path), 5, 8), 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn k_slots_matches_the_js_app_default() {
        // K = userMessageLimit = 8 (lib/rln.mjs K_SLOTS default). This is the value the
        // egress `--k`/cursor uses; keep it pinned to the JS reference.
        assert_eq!(K_SLOTS, 8);
    }

    #[test]
    fn wraps_at_k() {
        let path = temp_path();
        let k = K_SLOTS;
        // K consecutive runs hand out 0..K-1 ...
        for expect in 0..k {
            assert_eq!(next_slot(Some(&path), 9, k), expect);
        }
        // ... and the (K+1)th wraps back to 0 (an over-spend by construction, exactly
        // what the gateway slashes — same semantics as the JS nextSlot wrap).
        assert_eq!(next_slot(Some(&path), 9, k), 0);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn epoch_rollover_resets_to_zero() {
        let path = temp_path();
        assert_eq!(next_slot(Some(&path), 10, 8), 0);
        assert_eq!(next_slot(Some(&path), 10, 8), 1);
        assert_eq!(next_slot(Some(&path), 10, 8), 2);
        // Epoch rolls -> cursor resets, distinct nullifiers begin fresh for the new epoch.
        assert_eq!(next_slot(Some(&path), 11, 8), 0);
        assert_eq!(next_slot(Some(&path), 11, 8), 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn shrunk_k_resets_out_of_range_cursor() {
        let path = temp_path();
        // Persist a next_slot that a smaller K would put out of range.
        assert!(save(
            Some(&path),
            SlotCursor {
                epoch: 3,
                next_slot: 7
            }
        ));
        // k=4 -> 7 >= 4, so the stale cursor is reset rather than emitting an over-cap slot.
        assert_eq!(next_slot(Some(&path), 3, 4), 0);
        assert_eq!(next_slot(Some(&path), 3, 4), 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn k_of_one_is_always_zero() {
        let path = temp_path();
        assert_eq!(next_slot(Some(&path), 1, 1), 0);
        assert_eq!(next_slot(Some(&path), 1, 1), 0);
        // k=0 is guarded up to 1 (no divide-by-zero).
        assert_eq!(next_slot(Some(&path), 1, 0), 0);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn no_path_is_a_noop_slot_zero() {
        // No cursor configured: preserve the historical default of slot 0, no file written.
        assert_eq!(next_slot(None, 5, 8), 0);
        assert_eq!(next_slot(None, 5, 8), 0);
        assert!(load(None).is_none());
        assert!(!save(
            None,
            SlotCursor {
                epoch: 1,
                next_slot: 1
            }
        ));
    }

    #[test]
    fn load_tolerates_missing_and_corrupt() {
        let path = temp_path();
        // Missing file -> None (not an error).
        assert!(load(Some(&path)).is_none());
        // Corrupt / partial -> None (best-effort).
        std::fs::write(&path, "not json").unwrap();
        assert!(load(Some(&path)).is_none());
        std::fs::write(&path, r#"{"version":1,"epoch":5}"#).unwrap(); // missing nextSlot
        assert!(load(Some(&path)).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn roundtrips_and_persists_only_nonsecret_ints() {
        let path = temp_path();
        assert_eq!(next_slot(Some(&path), 42, 8), 0); // writes nextSlot=1
        let back = load(Some(&path)).unwrap();
        assert_eq!(
            back,
            SlotCursor {
                epoch: 42,
                next_slot: 1
            }
        );

        // Privacy guard: the file holds EXACTLY {version, epoch, nextSlot} — no identity,
        // secret, nullifier, or any other field could leak into it.
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["epoch", "nextSlot", "version"]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
