# Architecture decision records

Terse records of the load-bearing decisions in reputation-gated onion egress: the
context, the decision, its consequences, and the alternatives that were rejected. Each
claim is traceable to a source file, contract, or existing doc.

| ADR | Title | One-line summary |
|---|---|---|
| [0001](0001-client-language.md) | Client implementation language | JS stays the reference implementation and single source of truth for the trust-critical checks; a Rust client (`arti` + `zerokit`) is the distributable, kept honest by the conformance vectors. |
| [0002](0002-onion-never-on-chain.md) | The onion address is never stored on chain | `GatewayRegistry` keys the stake by operator address, never the onion, so the fleet stays un-enumerable and one stake can rotate across many onions; the onion↔operator link lives only in the signed announce. |
| [0003](0003-bootnode-is-a-cache-not-a-trust-root.md) | The bootnode is a cache, not a trust root | Every entry is self-authenticating (the onion IS its key, re-derived by clients) and stake is re-checkable on chain, so a hostile bootnode can only omit a gateway, never inject one. |
| [0004](0004-rln-over-slot-scheme.md) | Real RLN over the public-slot scheme | Chose real circom-rln Groth16 (fresh per-request share, over-spend reconstructs the secret and slashes) over the ROADMAP-v1 #1 public-slot scheme, which was simpler but leaked the slot histogram and had no slashing. |
| [0005](0005-governed-gateway-slash.md) | Gateway slashing governed, member slashing permissionless | Member over-spend is a cryptographic proof, so its slash is permissionless; gateway misbehavior is subjective, so its slash is owner-governed (swappable for a DAO / fraud-proof). |

## Format

Each ADR carries Status / Date / Task, then Context, Decision, Consequences, and
Alternatives considered, plus a References list pinning every claim to a source. Numbered
sequentially; a superseded decision is marked in its own Status line rather than deleted.
