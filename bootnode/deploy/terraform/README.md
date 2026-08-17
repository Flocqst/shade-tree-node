# Terraform / OpenTofu: provision a bootnode + gateway box

Infrastructure-as-code for **standing up the droplet** that
[`bootstrap.sh`](../bootstrap.sh) then configures. This module is a **thin
wrapper**: it creates the DigitalOcean droplet + firewall + SSH key and, via
cloud-init `user_data`, fetches `bootstrap.sh` at a pinned git ref and hands off.
All real provisioning — Node 24, Tor (with `pow: yes`), the minted onion
identities, and the three hardened systemd units (`rgoe-bootnode`,
`rgoe-gateway`, `rgoe-heartbeat`) — lives in `bootstrap.sh` and is **not**
duplicated here.

Works with either [OpenTofu](https://opentofu.org) (`tofu`, the SHIP-PLAN's
choice) or Terraform (`terraform`); the HCL is compatible with both. Commands
below use `tofu` — substitute `terraform` if you prefer.

## What it creates

| Resource | Purpose |
|---|---|
| `digitalocean_ssh_key.operator` | Your public key, injected into `root` on the box |
| `digitalocean_droplet.bootnode` | Ubuntu 24.04 box; `user_data` runs `bootstrap.sh` at first boot |
| `digitalocean_firewall.bootnode` | **SSH-in only, all-out** (see Firewall below) |

## Secrets / vars the operator supplies

Two required inputs; everything else has a default matching `bootstrap.sh`.

| Var | What | How to supply |
|---|---|---|
| `do_token` | DigitalOcean API token (read/write) | `export TF_VAR_do_token="dop_v1_..."` (preferred) or a **gitignored** `terraform.tfvars` |
| `ssh_public_key` | Your SSH **public** key material | `ssh_public_key = file("~/.ssh/id_ed25519.pub")` in `terraform.tfvars`, or paste the line |

Nothing else is secret. Never commit a real token — `terraform.tfvars` and all
state files are already in this directory's [`.gitignore`](.gitignore). Start
from [`terraform.tfvars.example`](terraform.tfvars.example).

## Plan / apply / destroy

```bash
cd bootnode/deploy/terraform

cp terraform.tfvars.example terraform.tfvars   # then edit (or use TF_VAR_* env)
export TF_VAR_do_token="dop_v1_..."            # keep the token out of the file

tofu init                # download the DigitalOcean provider
tofu plan                # preview
tofu apply               # create the box; user_data runs bootstrap.sh at first boot

# watch first-boot provisioning (Node + Tor + onion mint + units):
ssh root@$(tofu output -raw ipv4_address) 'tail -f /var/log/rgoe-bootstrap.log'

# the bootnode onion, pinned signer, and gateway onion are printed at the tail
# of that log (bootstrap.sh's final banner). Verify over Tor:
tofu output verify_command      # prints the exact ssh + curl to run

# tear it down:
tofu destroy
```

`tofu output` also exposes `ssh_command`, `ipv4_address`, `region`, and
`provisioning_log_command`.

## Firewall

SSH (22) inbound, everything outbound. The bootnode (`8877`) and gateway
(`8443`) are **loopback-only** backends published as Tor v3 onions, so they take
**no inbound clearnet ports** — do not add inbound rules for them. Tor needs
unrestricted outbound to build circuits. Lock `ssh_allowed_cidrs` to your admin
IP(s) in production (default is open).

## Variables (defaults match `bootstrap.sh`)

| Var | Default | Notes |
|---|---|---|
| `region` | `nyc3` | any DO region slug |
| `droplet_size` | `s-1vcpu-1gb` | 1vCPU/1GB runs Tor + 3 Node units comfortably |
| `image` | `ubuntu-24-04-x64` | bootstrap targets fresh 24.04 |
| `droplet_name` | `rgoe-bootnode` | also names the key + firewall |
| `git_repo` | `github.com/dmarzzz/reputation-gated-onion-egress` | passed as `RGOE_REPO` |
| `git_ref` | `main` | passed as `RGOE_REF`; **pin a tag/sha for reproducibility** |
| `admission` | `open` | `open` or `stake` → `RGOE_ADMISSION` |
| `bootnode_port` | `8877` | loopback → `RGOE_BOOTNODE_PORT` |
| `gateway_port` | `8443` | loopback → `RGOE_GATEWAY_PORT` |
| `tor_socks_port` | `9050` | informational; used in the `verify_command` output (bootstrap pins the heartbeat's `RGOE_TOR_PORT` to 9050) |
| `ssh_allowed_cidrs` | `["0.0.0.0/0", "::/0"]` | lock down in prod |
| `tags` | `["rgoe","bootnode","gateway"]` | DO tags |

## How it delegates to `bootstrap.sh`

`user_data.sh.tftpl` renders a small first-boot script that:

1. exports `RGOE_REPO`, `RGOE_REF`, `RGOE_ADMISSION`, `RGOE_BOOTNODE_PORT`,
   `RGOE_GATEWAY_PORT` — the exact env tunables `bootstrap.sh` reads;
2. waits out the first-boot apt lock;
3. `curl`s `bootstrap.sh` from `raw.githubusercontent.com` at the **same pinned
   ref**, and runs it as root.

The wrapper contains **zero** provisioning logic of its own. If bring-up changes,
it changes in `bootstrap.sh`; this module keeps working unchanged.

## Multiple gateways across regions/ASNs (T-DEPLOY-2)

Run this module once per box with a different `region` (and `droplet_name`),
e.g. via separate workspaces/dirs or a `for_each` wrapper, to spread the
both-ends AS vantage. Each box announces its gateway to its own bootnode; point
clients at the directory as usual.

## Updates — composes with the rolling update (T-DEPLOY-6)

This module is for **first bring-up**. To move a live box to a new git ref
**without re-provisioning or touching `deploy-state`** (onion seeds, signer key,
persistence store are reused), do **not** re-`apply` a new `git_ref` — that would
recreate the droplet and mint new onions. Instead use
[`rolling-update.sh`](../rolling-update.sh) / [`ROLLING-UPDATE.md`](../ROLLING-UPDATE.md):

```bash
ssh root@$(tofu output -raw ipv4_address) \
  'sudo bash /opt/rgoe/bootnode/deploy/rolling-update.sh <ref>'
```

For a multi-box fleet, sequence one gateway at a time per `ROLLING-UPDATE.md` so
a healthy gateway stays in the signed directory throughout. `tofu` owns the box's
existence and shape (size, region, firewall); `rolling-update.sh` owns the code
running on it.
