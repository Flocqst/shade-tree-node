# Changelog

## 0.3.0 — Shade Tree research preview

### Changed

- Renamed the project, package, CLI, services, metrics, paths, Rust crates,
  JavaScript API, and configuration surface to Shade Tree.
- Introduced the `shade-tree run -- <command>` process wrapper for proxy-aware
  agents and local tools.
- Moved the protocol to explicit v4 and rotated every name-bearing signature
  domain.
- Reworked operator defaults for safer service isolation and clearer
  co-location guidance.
- Replaced the public README and research-note presentation with the minimal
  Shade Tree identity and banner.

### Compatibility

- v3 and unversioned envelopes are rejected.
- Old configuration names have no compatibility alias.
- Capability, operator, and receipt records must be re-signed.
- Exit and withdrawal paths require contracts deployed with the new contexts.
- The checked-in Sepolia records describe the earlier research deployment.

See [`docs/MIGRATING-TO-SHADE-TREE.md`](docs/MIGRATING-TO-SHADE-TREE.md) for
the rollout sequence.

