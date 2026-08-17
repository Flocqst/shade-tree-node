# Go-live log — 2026-08-17 (T-DEPLOY-1 / T-DEPLOY-2)

Execution record of [`docs/GO-LIVE.md`](GO-LIVE.md). One row per runbook step: what was run,
pass/fail, the observed value. Onions and pubkeys of the NEW fleet are published here on
purpose (they are the discovery handles); no droplet or laptop IP appears — boxes are cited by
name/region.

**Decision (GO-LIVE 0.2 / 0.12):** GO 2026-08-17 with the testnet-only, untrusted RLN artifacts
pinned in `circuits/rln/ARTIFACTS.md` (`rln-0b25f824a04da3a8`, `trust=UNTRUSTED-TESTNET`); the
fleet is labelled testnet. Admission `open` (Phase 3 stake admission NOT done — see "Left open").
Ref deployed: `main` @ `cb237e070f07c5a97928ad1c1831ddad9e7bfc9f` (PR #8 merged first, because
`bootstrap.sh` fetches `main`).

**Machines:**

| runbook name | this go-live | notes |
|---|---|---|
| `laptop` | operator workstation (macOS, Homebrew tor 0.4.9.9 `pow: no`, Node 24) | client tor via `scripts/start-tor-client.sh` (SOCKS 9260) |
| `droplet-1` = **`anon-egress`** | EXISTING DigitalOcean droplet, **NYC1**, Ubuntu 24.04, 2 vCPU/2 GB, Tor Project tor 0.4.9.9 (`pow: yes`), ufw inbound-22-only | reused instead of renting (GAP-1: this is the box the June PoC ran on) |
| `droplet-2` = **`rgoe-gw-04`** | to be provisioned via `~/agent-devops` OpenTofu (role `egress`, `s-1vcpu-1gb`, non-NYC DO region, legacy `rgoe_gateway` role OFF) | **BLOCKED this run — no DigitalOcean API token available** (see Phase 5) |

**Fleet record (published):**

| | value |
|---|---|
| `<BN_ONION>` | `kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion` |
| `<SIGNER>` | `d79f78c369bd9c7b74575eae0c5068e6921f90bfdc97d43af9adc0039f953a73` |
| `<GW1_ONION>` (region `na`) | `yaxo4ywgoizk4yiylx66k3vjsgcj5waruumgi6dgds4fgaihd2eh7yqd.onion` |
| `<GW2_ONION>` | — (droplet-2 not provisioned, see Phase 5) |
| admission | `open` |
| onion PoW | `RGOE_ENABLE_POW=0` (off) |
| membership root | committed `group/members.json` (PoC fallback), 8 members |

Receipt files (laptop-local, NOT committed — they contain IPs): `golive/directory-1gw.json`,
`golive/accept-1a.txt`, `golive/accept-1b.json`, `golive/accept-1c.txt`, `golive/accept-neg.txt`,
`golive/rust/{identity.json,slot.cursor,health.json}` (identity.json deleted after use).
Committed receipts: `network/sepolia/bootnode.json` (record, `status: live`),
`network/sepolia/directory-bootnode.json` (the bootnode's signed `/directory` export = 4.4).

---

## Phase 0 — Preconditions

| # | check | result | observed |
|---|---|---|---|
| 0.1 | Gates 1+2 | pass (inherited) | PR #5 merged 2026-08-15 with both gates; PR #8 CI green (test node 20/22/24, lint, supply-chain, bootstrap-e2e ×2, real-Tor e2e) before merge |
| 0.2 | ceremony decision | decided | testnet-only untrusted artifacts, fleet labelled testnet (above) |
| 0.3 | artifact hashes | pass | Rust `-live` client verified its embedded artifacts against the zk-artifacts lock at run time (`artifact=rln-0b25f824a04da3a8`, 4.7 output) |
| 0.4 | existing-fleet inventory | done | do-not-touch: agent-devops `egress` group `egress-01`, `egress-02`, `rgoe-03` (nyc3). None was touched. |
| 0.5 | Sepolia contracts | pass | `contracts.json`: `stakedReputationSet` `0xdAE242AE…20FC`; `gatewayRegistry` `0x94ECeD0C…A868` (deployed 2026-08-17 by another slice, `network/sepolia/README.md`) — not used (admission open) |
| 0.6 | deployer/operator keys | n/a | Phase 3 out of scope; no key placed on any box |
| 0.7 | member secret | pass | `demo-keys.local.md` member `alice` (leaf = `group/members.json[0]`), read via env only. NOTE: the laptop `.secret` file (June PoC) is NOT in the committed set (its leaf is absent from `members.json`) — it is a legacy PoC secret; do not use it for the fleet. |
| 0.8 | laptop tor | noted | `Tor 0.4.9.9`, `pow: no` → drives the PoW decision (4.0) |
| 0.9 | Rust client | pass | `cargo build --release -p rgoe-client --features live` at `cb237e07` (fresh build; the pre-existing binary predated T-HARD-8) |
| 0.10 | provider accounts | **partial** | DO account exists (droplet-1). No DO API token reachable from the laptop (`DIGITALOCEAN_TOKEN` unset, `doctl` token → 401); second box not created. |
| 0.11 | bootstrap ref | decided | `main` (bootstrap default after PR #8) = `cb237e07` |
| 0.12 | go/no-go | GO 2026-08-17 | orchestrator decision; agent executed |

## Phase 1 — Bootnode (droplet-1 = anon-egress)

| # | step | result | observed |
|---|---|---|---|
| 1.1 | create droplet | **deviation** | Existing box reused (orchestrator decision), no `bootnode/deploy/terraform` run. Pre-flight: the June PoC units `rgoe-gateway.service` / `rgoe-tor.service` were loaded+dead; **`rgoe-gateway.service` name collides** with the unit bootstrap writes → both PoC unit files backed up to `/root/poc-units-backup/` and bootstrap overwrote `rgoe-gateway.service` (`rgoe-tor.service` left in place, disabled-by-being-dead). A stray nohup'd PoC `node gateway/gateway.mjs` (since Jul 8) was holding `127.0.0.1:8443` — killed (pid only; the PoC checkout `~/reputation-gated-onion-egress` and its PoC tor on 9250/9251 + HS keys were left untouched). |
| 1.2 | bootstrap | pass (after fix) | `curl -fsSL …/main/bootnode/deploy/bootstrap.sh \| sudo RGOE_ENABLE_POW=0 RGOE_GATEWAY_REGION=na bash`. Banner: bootnode onion + gateway onion above; signer printed as `<check: journalctl>` because the units were crash-looping at that moment (next row). |
| 1.3 | units + tor | pass (after fix) | **First attempt: all three units died `status=31/SYS` (SIGSYS) in a restart loop** — kernel audit: `syscall=330` (`pkey_alloc`) from `/usr/bin/node` (pre-installed NodeSource **20.20.2**; bootstrap only upgrades Node < 18). `SystemCallFilter=@system-service` does not allow `pkey_alloc`; Node 24 does not call it (verified with `systemd-run -p SystemCallFilter=@system-service`: v24 exits 0, v20 dumps SYS, v20 + `pkey_alloc pkey_free pkey_mprotect` exits 0). Fix applied on the box: NodeSource 24 (`v24.19.0`), `systemctl restart` → `tor rgoe-bootnode rgoe-gateway rgoe-heartbeat` all `active`. `tor --list-modules` `pow: yes`. `systemd-analyze security` = **2.8 OK** for all three units. Repo fix in this PR: `bootstrap.sh` now upgrades Node < 24. |
| 1.4 | health loopback | pass | `{"ok":true,"count":1,"admission":"open","signer":"d79f78c3…3a73"}` |
| 1.5 | health over Tor (on-box 9050) | pass | same JSON, first try after ~60 s |
| 1.6 | signer pinned | pass | `bootnode-signer.key` `.pub` == `<SIGNER>`; unit has `RGOE_BOOTNODE_SIGNER_KEY` + `RGOE_BOOTNODE_STORE` |
| 1.7 | firewall | pass | from laptop `nc -z` to droplet-1 `:8877 :8443 :9101` → closed/filtered; ufw = 22/tcp only |

## Phase 2 — Gateway-1 (droplet-1)

| # | step | result | observed |
|---|---|---|---|
| 2.1 | gateway up | pass | `gateway up on 127.0.0.1:8443 epoch=14891621 epochSeconds=120`, `egress policy: allow=[*:443]`, `root source: members.json (PoC fallback) members=8` (laptop `group/members.json` = 8, byte-identical main vs `cb237e07`), `zk artifacts accepted=["rln-0b25f824a04da3a8"]`, `slash: DRY-RUN` |
| 2.2 | heartbeat | pass | `heartbeat: yaxo4ywgoizk4yiy..onion -> kssrk54kb5kngr4j..onion every 300s`, `capabilities advertised (signed): {"region":"na","proto":{"min":3,"max":3}}`, `announced (staked=false, ttl=900s)` |
| 2.3 | directory lists gw-1 | pass | `/directory` over on-box Tor: 1 gateway `yaxo4ywg…7yqd.onion` weight 100 health up, `signer` = `<SIGNER>` → `golive/directory-1gw.json` |
| 2.4 | region cap | pass | done at bootstrap time (`RGOE_GATEWAY_REGION=na`, PR #8 tunable) — see 2.2 |
| 2.5 | metrics | pass | drop-in `/etc/systemd/system/rgoe-gateway.service.d/metrics.conf` (`RGOE_METRICS_PORT=9101`) → `127.0.0.1:9101/metrics` serves `rgoe_gateway_*`; loopback only (1.7) |
| 2.6 | egress IP | pass | on-box `curl https://api.ipify.org` == droplet-1's public IP |

## Phase 3 — Stake admission

Skipped by decision (acceptance is with `admission open`, GO-LIVE Phase 3 header). Nothing was
broadcast, no key was placed on any box. Follow-up flagged in "Left open".

## Phase 4 — First laptop client egress `[RECEIPT T-DEPLOY-1]`

| # | step | result | observed |
|---|---|---|---|
| 4.0 | PoW decision | decided | Laptop tor is `pow: no`; fleet deployed with `RGOE_ENABLE_POW=0` (the new bootstrap default, GAP-3 closed by PR #8). No torrc edit needed. Turn on later once every client runs a pow-capable tor. |
| 4.1 | laptop tor | pass | `start-tor-client.sh` → SOCKS 9260; `curl --socks5-hostname 127.0.0.1:9260 http://<BN_ONION>/health` = same JSON as 1.5 |
| 4.2 | JS client | pass | `node bin/rgoe.mjs client --bootnode <BN_ONION> --dir-signer <SIGNER> --tor-port 9260` → `shim up: http://127.0.0.1:8888`, `mode: directory fleet rotation` |
| 4.3 | **T-DEPLOY-1 acceptance A** | **PASS** | `curl -sx http://127.0.0.1:8888 "https://api.ipify.org?format=json"` → `{"ip":<droplet-1 public IP>}` (equal to 2.6; not the laptop, not a Tor exit). Shim: `TUNNEL api.ipify.org:443 slot=0 via yaxo4ywgoizk4yiy..onion`. Gateway journal: `egress target=api.ipify.org:443 nullifier=1489419039.. externalNullifier=8252901646..` (the current log line form of the runbook's `PASS egress->…`). → `golive/accept-1a.txt` |
| 4.4 | **T-DEPLOY-1 acceptance B** | **PASS** | `/directory` via laptop tor lists `["yaxo4ywgoizk4yiylx66k3vjsgcj5waruumgi6dgds4fgaihd2eh7yqd.onion"]`; `rgoe verify-directory golive/accept-1b.json --signer <SIGNER>` → `ok`. Committed as `network/sepolia/directory-bootnode.json`. |
| 4.5 | privacy | pass | laptop public IP occurrences: gateway journal **0**, bootnode journal **0** |
| 4.6 | Rust identity | pass | `rgoe identity --out golive/rust/identity.json` (secret via env; GAP-4 closed by PR #9) → `{identitySecret, leaf}`, mode 0600 |
| 4.7 | Rust live egress | pass (2nd try) | `rgoe egress --bootnode-onion <BN_ONION> --signer <SIGNER> --identity … --members group/members.json --target api.ipify.org:443 --slot-cursor … --health-cache …` (embedded arti). Attempt 1: bootnode discovery OK (`1 candidate gateway(s) from verified directory`), gateway dial `onion connect timed out after 180s`. Attempt 2 (same cursor): `ok / gateway: yaxo4ywg…7yqd.onion:80 / target: api.ipify.org:443 / nullifier: 1214268440…` → `golive/accept-1c.txt` |
| 4.8 | negative check | pass | fresh `rgoe enroll --commitment-only` secret on a second shim (8889): `ERROR api.ipify.org:443 (proveForSlot: identity's rateCommitment not in group)`, curl `000`, nothing egressed |
| 4.9 | uptime probe | pass | `{"ok":true,"bootnodeReachable":true,"signerOk":true,"fleetSize":1}` exit 0 |
| 7.3-ish | `RGOE_NETWORK=sepolia` path | pass | with the new record: `RGOE_SECRET=… RGOE_NETWORK=sepolia RGOE_TOR_PORT=9260 node bin/rgoe.mjs client` → `network "sepolia" supplied RGOE_BOOTNODE_ONION, RGOE_DIR_SIGNER, …`, curl through 8888 → droplet-1's IP |

## Phase 5 — Gateway-2, different region `[RECEIPT T-DEPLOY-2]` — **BLOCKED**

| # | step | result | observed |
|---|---|---|---|
| 5.1 | create droplet-2 | **BLOCKED** | Plan: `~/agent-devops` tofu entry `rgoe-gw-04` (role `egress`, `s-1vcpu-1gb`, region `sfo3` (fallback `ams3`/`fra1`), `dev_tools = { rgoe_gateway = false }`, targeted `tofu apply -target='module.droplet["rgoe-gw-04"]'`, `task bootstrap HOST=rgoe-gw-04`, then `RGOE_BOOTNODE_ONION=<BN_ONION> RGOE_BOOTNODE_SIGNER=<SIGNER> RGOE_GATEWAY_REGION=na sudo -E bash bootstrap.sh` (gateway-only mode, GAP-6 closed by PR #8)). Not executed: no DigitalOcean API token is reachable from the laptop (`DIGITALOCEAN_TOKEN` unset in every shell/env file, `~/agent-devops/.env` has only `SOPS_AGE_KEY_FILE`, the stored `doctl` token answers `401`; `RESTORE.md`/memory confirm the token is deliberately not on disk). Operator was pinged (hermes) to drop a token into `~/agent-devops/.env`. |
| 5.2–5.10 | | not run | depend on 5.1 |

Everything needed to finish T-DEPLOY-2 once a token exists is in place: bootstrap gateway-only
mode is merged and CI-tested; the bootnode is live and admits gateways openly; the client
already rotates across whatever `/directory` lists (`RGOE_ROTATION_SPREAD=1` for strict
round-robin).

## Phase 6 / 7 — partial

- 6.6 backup of onion identities + signer: **not done** (flagged). `deploy-state/` on droplet-1
  holds `bootnode-signer.key`, `bootnode-hs/`, `gateway-hs/`, `bootnode-state.json`.
- 7.1 fleet record: done (`network/sepolia/bootnode.json` `status: live`, README "Bootnode").
- 7.2 static fallback: done (`network/sepolia/directory-bootnode.json`, wired as
  `staticDirectory` in the record; legacy `directory.json` untouched, its loader unchanged).
- 7.3 member docs: `docs/JOIN.md` (fleet quickstart banner), `docs/post/JOIN.md`,
  `docs/CLIENTS.md`, `network/sepolia/README.md` point at `RGOE_NETWORK=sepolia`.
  `scripts/run-client.sh` / `scripts/join.sh` (PoC defaults) not retargeted (owned elsewhere).

## Left open (follow-ups)

1. **T-DEPLOY-2 (droplet-2 / `rgoe-gw-04`)** — blocked on a DO API token; steps above.
2. **Stake admission (Phase 3)** — `GatewayRegistry` is now on Sepolia; switch the bootnode unit
   to `RGOE_BOOTNODE_ADMISSION=stake` + heartbeat operator auth per GO-LIVE 3.4–3.6 when decided.
3. **Backups (6.6/6.7)** — run `rgoe backup` on droplet-1, store off-box, prove restore.
4. **Monitoring (6.1–6.4)** — metrics are on loopback :9101 (gateway) / :8877 (bootnode) for
   SSH-tunnel scraping; no scrape configured yet. SLO baseline snapshot not taken.
5. **PoC leftovers on droplet-1** — PoC tor (SOCKS 9250) and PoC shim (8888, box-local) still
   run from the old checkout; the PoC onion now maps to the NEW gateway on 8443. Decide whether
   to retire them (`rgoe-tor.service` unit still enabled-but-dead; PoC checkout untouched).
6. **bootstrap.sh + Node < 24** — fixed in this PR (upgrade instead of tolerate); a fresh box
   was never affected.
