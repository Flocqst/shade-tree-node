//! Opt-in capability-aware selection filter (T-FEAT-10c) — the Rust port of
//! `client/selection.mjs`'s `gatewayMeetsRequirement` / `requirementActive` /
//! `filterByCapability`.
//!
//! A request MAY carry a capability REQUIREMENT `{ port?, proto?, region? }` so the
//! client routes to a gateway that can actually serve it (a destination port the
//! gateway's egress policy allows, a mutually-supported envelope version, or a coarse
//! region). Capabilities are the gateway's SIGNED self-declaration (`caps`/`capsSig`,
//! already verified by `verify_directory` before selection).
//!
//! OPT-IN and byte-identical by default: an EMPTY requirement leaves selection
//! untouched (`is_active() == false` — the fleet is not filtered). A requirement that
//! NO gateway meets FAILS CLOSED at the call site (the `select` command prints an error
//! naming the unmet requirement rather than dialing an incapable gateway).

use rgoe_proto::{canonical_caps, GatewayEntry, DEFAULT_EGRESS_PORT, DEFAULT_PROTO_VERSION};

/// A capability requirement carried by a request. All fields OPTIONAL; an all-`None`
/// requirement is INACTIVE and never filters. Mirrors the JS `req { port?, proto?, region? }`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Requirement {
    pub port: Option<u64>,
    pub proto: Option<u64>,
    pub region: Option<String>,
}

impl Requirement {
    /// A requirement is "active" only if it actually constrains something; an empty one
    /// leaves selection untouched (`requirementActive`, `selection.mjs`).
    pub fn is_active(&self) -> bool {
        self.port.is_some() || self.proto.is_some() || self.region.is_some()
    }

    /// Human-readable `port=..,proto=..,region=..` for the fail-closed error
    /// (`describeRequirement`, `selection.mjs`).
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(p) = self.port {
            parts.push(format!("port={p}"));
        }
        if let Some(p) = self.proto {
            parts.push(format!("proto={p}"));
        }
        if let Some(r) = &self.region {
            parts.push(format!("region={r}"));
        }
        parts.join(",")
    }
}

/// Does one directory entry satisfy a capability requirement? Pure + TOTAL
/// (`gatewayMeetsRequirement`, `selection.mjs`).
///
/// A gateway that advertises NO caps is assumed to meet ONLY the conservative default
/// ([`DEFAULT_EGRESS_PORT`] / [`DEFAULT_PROTO_VERSION`]) — it cannot prove a non-default
/// capability, so it is not selected for one. Region is NEVER implicit: a gateway must
/// advertise a matching region bucket to satisfy a region requirement.
pub fn gateway_meets_requirement(entry: &GatewayEntry, req: &Requirement) -> bool {
    // canonicalCaps(undefined) === {} in JS: a no-caps entry canonicalizes to empty.
    let caps = entry.caps.as_ref().map(canonical_caps).unwrap_or_default();

    if let Some(port) = req.port {
        match &caps.ports {
            Some(ports) => {
                if !ports.contains(&port) {
                    return false;
                }
            }
            // No advertised ports => only the conservative default egress port.
            None => {
                if port != DEFAULT_EGRESS_PORT {
                    return false;
                }
            }
        }
    }
    if let Some(v) = req.proto {
        match caps.proto {
            Some((min, max)) => {
                if v < min || v > max {
                    return false;
                }
            }
            // No advertised range => only the conservative default proto version.
            None => {
                if v != DEFAULT_PROTO_VERSION {
                    return false;
                }
            }
        }
    }
    if let Some(region) = &req.region {
        match &caps.region {
            Some(r) if r == region => {}
            _ => return false, // region is never implicit
        }
    }
    true
}

/// Retain in `gateways` only the entries meeting `req`. No-op (leaves the list untouched)
/// when the requirement is INACTIVE, so callers stay on the byte-identical selection path
/// (`filterByCapability`, `selection.mjs`). Returns the count retained.
pub fn filter_by_capability(gateways: &mut Vec<GatewayEntry>, req: &Requirement) -> usize {
    if req.is_active() {
        gateways.retain(|g| gateway_meets_requirement(g, req));
    }
    gateways.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgoe_proto::{Caps, ProtoCaps};

    fn entry_with(caps: Option<Caps>) -> GatewayEntry {
        GatewayEntry {
            onion: "gw.onion".to_string(),
            pubkey: String::new(),
            weight: 100,
            health: "up".to_string(),
            operator: None,
            staked: None,
            caps,
            caps_sig: None,
        }
    }

    fn full_caps() -> Caps {
        Caps {
            ports: Some(vec![80, 443]),
            region: Some("eu".to_string()),
            proto: Some(ProtoCaps { min: 3, max: 3 }),
        }
    }

    #[test]
    fn inactive_requirement_matches_everything() {
        let req = Requirement::default();
        assert!(!req.is_active());
        // Even a no-caps gateway passes an inactive (empty) requirement.
        assert!(gateway_meets_requirement(&entry_with(None), &req));
    }

    #[test]
    fn no_caps_gateway_meets_only_conservative_floor() {
        let e = entry_with(None);
        // Default 443 / proto 3 are the implicit floor a no-caps gateway can serve.
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                port: Some(443),
                ..Default::default()
            }
        ));
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                proto: Some(3),
                ..Default::default()
            }
        ));
        // A non-default port/proto it never advertised => not selected (fail closed).
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                port: Some(80),
                ..Default::default()
            }
        ));
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                proto: Some(4),
                ..Default::default()
            }
        ));
        // Region is never implicit.
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                region: Some("eu".to_string()),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn advertised_caps_gate_by_membership_and_range() {
        let e = entry_with(Some(full_caps()));
        // Advertised port 80 is now allowed; an un-advertised 22 is not.
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                port: Some(80),
                ..Default::default()
            }
        ));
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                port: Some(22),
                ..Default::default()
            }
        ));
        // proto range {3,3}: 3 in range, 2 below.
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                proto: Some(3),
                ..Default::default()
            }
        ));
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                proto: Some(2),
                ..Default::default()
            }
        ));
        // region match / mismatch.
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                region: Some("eu".to_string()),
                ..Default::default()
            }
        ));
        assert!(!gateway_meets_requirement(
            &e,
            &Requirement {
                region: Some("na".to_string()),
                ..Default::default()
            }
        ));
        // All three together, all satisfied.
        assert!(gateway_meets_requirement(
            &e,
            &Requirement {
                port: Some(443),
                proto: Some(3),
                region: Some("eu".to_string()),
            }
        ));
    }

    #[test]
    fn filter_is_noop_when_inactive_and_fails_closed_when_unmet() {
        let mut gws = vec![entry_with(None), entry_with(Some(full_caps()))];
        // Inactive requirement: list untouched (byte-identical selection path).
        let n = filter_by_capability(&mut gws, &Requirement::default());
        assert_eq!(n, 2);
        // Active requirement port=80: only the caps gateway advertises 80.
        let mut gws2 = vec![entry_with(None), entry_with(Some(full_caps()))];
        let n2 = filter_by_capability(
            &mut gws2,
            &Requirement {
                port: Some(80),
                ..Default::default()
            },
        );
        assert_eq!(n2, 1);
        assert_eq!(gws2[0].onion, "gw.onion");
        // Active requirement no gateway meets => empty (caller fails closed).
        let mut gws3 = vec![entry_with(None)];
        let n3 = filter_by_capability(
            &mut gws3,
            &Requirement {
                port: Some(8080),
                ..Default::default()
            },
        );
        assert_eq!(n3, 0);
    }

    #[test]
    fn describe_names_the_unmet_requirement() {
        let req = Requirement {
            port: Some(80),
            proto: Some(3),
            region: Some("eu".to_string()),
        };
        assert_eq!(req.describe(), "port=80,proto=3,region=eu");
    }
}
