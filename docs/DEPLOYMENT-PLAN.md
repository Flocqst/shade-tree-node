# Protocol v4 deployment plan

**Status:** blocked for node deployment · website deployable · 2026-08-24

This is the current rollout plan. The older `DEPLOYMENT.md`, `GO-LIVE.md`, and
Sepolia records describe the retired pre-v4 research fleet.

## Topology

```text
discovery

Shade Tree node -- signed heartbeat --> Elder Tree -- signed Canopy --> Proxy

traffic

agent --> Proxy --> Tor --> Shade Tree node --> destination
```

The Elder Tree (`bootnode` in source) is a separate control-plane service. It
signs the Canopy and never carries agent traffic. The Shade Tree node (`gateway`
in source) verifies the v4 proof before it opens destination egress.

## Current inventory

- The Vercel `shade-tree-node` project is linked and can be deployed separately.
- The provider-visible egress droplet runs the retired repository at a pre-v4
  commit. It is not an upgrade target until ownership and rollback are confirmed.
- The reachable Elder Tree also runs pre-v4 code, but it is absent from the
  currently selected provider account. Its ownership and lifecycle are unclear.
- Other egress hosts remain in local OpenTofu state or Ansible inventory but are
  absent from the provider. Inventory is not proof that a server exists.
- The local Ansible role clones the old repository and has no Elder Tree role.
  The standalone Terraform has no selected state or variables for this rollout.

No host has been added, repurposed, or removed as part of this audit.

## Gates before infrastructure changes

1. **Complete:** [#73](https://github.com/dmarzzz/shade-tree-node/issues/73). Nodes reject
   private, loopback, link-local, carrier-grade NAT, metadata, multicast, and
   reserved destinations after resolving every answer, then dial the checked
   numeric address. The local-test override is explicit and warns at startup.
2. Complete [#75](https://github.com/dmarzzz/shade-tree-node/issues/75): persist and
   atomically coordinate Proxy slot allocation across restarts and processes so
   one member secret cannot accidentally reuse a slot inside an epoch.
3. Replace the untrusted development Groth16 setup, or explicitly scope a new
   isolated fleet to disposable testnet research with no real funds or sensitive
   traffic. The decision and artifact hashes must be recorded. The v4 preflight
   rejects `production` while the pinned artifact lock still says
   `UNTRUSTED-TESTNET` or lacks a completed trusted ceremony.
4. Choose targets and confirm their provider account, owner, region, size,
   admin CIDR, SSH keys, and rollback path. Do not reuse an unowned Elder Tree.
5. **Preflight implemented; live values pending.** Create a v4 network record
   containing the Elder onion, pinned Canopy signer, admitted roots, accepted
   artifact identifiers, and protocol range. Pin an immutable git commit for every
   service. [`deploy/v4/preflight.mjs`](../deploy/v4/preflight.mjs) validates this
   record and recomputes verification-key hashes/content ids before any target is
   changed; its null-filled example cannot deploy.
6. **Target-independent automation implemented; provider execution pending.** The
   [`deploy/v4` Ansible role](../deploy/v4/README.md) reconciles the Elder Tree,
   Shade Tree node, Tor, heartbeat, firewall, JSON logs, and loopback-only metrics
   through the current pinned checkout and shared hardened bootstrap. It verifies
   restored identities, active services, source commit, artifact configuration,
   and listener scope before writing its idempotence marker. No target inventory is
   committed and no provider was changed by this work.
7. **Fail-closed guard implemented; operator decision pending.** The record and role
   default to invited-only. Staked or paid admission cannot run unless the reviewed
   contract roots, non-secret authorization reference, explicit operator approval,
   RPC, and required slashing/operator keys are all present. Missing configuration
   stops before the first remote mutation.

These gates require a target/provider decision and security work. They are not
safe defaults to infer from the retired fleet.

## Rollout order

1. Provision or adopt the Elder Tree target. Generate or restore its onion and
   Canopy-signing keys, expose only its onion service, and keep health and metrics
   on loopback.
2. Provision one isolated Shade Tree node with a dedicated public IP. Keep GPU,
   validator, wallet, metadata, and authenticated RPC surfaces unreachable from
   egress.
3. Start the proof gate and heartbeat. Confirm the Elder Tree accepts the signed
   announcement and returns a v4 Canopy containing exactly that node.
4. Publish the Elder onion and signer pin out of band to the test Proxy. Do not
   publish node IPs or a raw per-node observer feed.
5. Add the actual Elder and node hosts to Ansible inventory in the same change
   that provisions them. Never add placeholder or absent hosts.
6. Expand beyond one node only after the single-node checks pass and the rollback
   has been exercised.

## Verification

- Elder `/health` and signed Canopy are reachable over Tor and reject tampering.
- The node is reachable only through its onion and advertises protocol v4.
- An authorized proof opens one CONNECT tunnel; malformed, stale, wrong-root,
  wrong-artifact, replayed, and unauthorized proofs fail closed.
- Nullifier accounting enforces the node's configured per-epoch view. If a
  cross-node tally is enabled, its fail-open behavior is tested and documented.
- Private and reserved destinations fail before any outbound connection.
- A permitted HTTPS request returns the node IP, not the Proxy IP, while TLS
  still terminates at the destination.
- Metrics remain loopback-only, logs contain no target, onion, nullifier, member
  secret, or payment authorization, and each service has a working rollback.

Record the final hosts, immutable refs, onions, signer pin, artifact IDs, health
evidence, and rollback result without committing secret keys.
