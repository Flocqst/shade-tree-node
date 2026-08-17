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

---

## 2026-08-17 (later) — T-DEPLOY-2 + stake admission

Second session, same day, once a DigitalOcean API token was available (env-only, per
`agent-devops/RESTORE.md`; never written to disk in either repo). Executed Phase 5 (droplet-2),
Phase 3 (stake admission + on-chain slashing), 6.6/6.7 (backups + restore proof), and the box-1
PoC tidy. Same privacy rule as above: onions/pubkeys/addresses yes, IPs no.

**Machines (update):**

| runbook name | this session | notes |
|---|---|---|
| `droplet-2` = **`rgoe-gw-04`** | NEW DigitalOcean droplet, **SFO3**, `s-1vcpu-1gb`, Ubuntu 24.04.4, provisioned by `~/agent-devops` OpenTofu (`tofu apply -target='module.droplet["rgoe-gw-04"]'`, role `egress`, `dev_tools.rgoe_gateway=false`) + `task bootstrap HOST=rgoe-gw-04` (mindagent + passwordless sudo, ufw 22/tcp only), then the repo's own `bootstrap.sh` in **gateway-only mode** | GAP-1 closed: this box was rented + configured by tooling, not hand-ssh. NOTE: the DO token in hand belongs to a different DO account than the rest of the agent-devops fleet state (documented in the tfvars/FLEET.md row); do not run an untargeted `tofu apply` with it. |

**Fleet record (update):**

| | value |
|---|---|
| `<GW2_ONION>` (region `na`, SFO) | `av4m256h4wwgwdmg74wnqem7s7l333h6755sroydlbcq62ptkmawtwid.onion` |
| admission | **`stake`** (`RGOE_STAKE_MODE=onchain`, `RGOE_GATEWAY_REGISTRY=0x94ECeD0C1c7a8793a5c901c8C1995C8E7039A868`, `RGOE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com`, `RGOE_CONFIRMATIONS` left at default 0 = `latest`) |
| staked operator | `0xc8606C75E003EDA7C0a377B4708AbEC6EB7a7f02` (fleet operator hot key; one stake backs both onions) — stake tx `0x15d810b7a9aca783321697aadc0f98b81b2f2ae51fd92d5f002693bc0f5d15fc`, block 11510519, bond 0.001 ETH |
| gateway slashing | on-chain on both gateways: `RGOE_SLASH_CONTRACT=0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC`, receiver = operator |
| droplet-2 ref | `main` @ `d8a6530146b13986870eb42299ace1118ebfb0b9` (bootstrap fetched `main`); droplet-1 unchanged (`cb237e07`) |

Receipt files (laptop-local, gitignored `golive/`, they contain IPs): `golive/directory-2gw.json`
(open), `golive/directory-2gw-stake.json` (stake; committed as `network/sepolia/directory-bootnode.json`),
`golive/accept-2b.txt`, `golive/accept-2b-stake.txt`, `golive/accept-2c.txt`, `golive/asn.txt`,
`golive/client-2gw.log`, `golive/rust/{slot.cursor,health.json}` (`identity.json` deleted after use).

### Phase 5 — Gateway-2 (droplet-2 = rgoe-gw-04) `[RECEIPT T-DEPLOY-2]`

| # | step | result | observed |
|---|---|---|---|
| 5.1 | create droplet-2 | pass | agent-devops targeted tofu apply (8 resources: per-server ed25519 key uploaded to DO + written to `~/.ssh/rgoe-gw-04_ed25519` + SOPS-encrypted `ansible/files/secrets/rgoe-gw-04_ed25519.enc`, droplet, cloud firewall inbound-22-only, generated `host_vars/rgoe-gw-04.yml`); ledger/inventory regenerated with a second targeted apply of the `local_file.*` resources; `task bootstrap HOST=rgoe-gw-04` ok (37 tasks; first attempt hit the fresh-box unattended-upgrades dpkg lock, re-run clean). `ipinfo.io` org: droplet-1 = `AS14061 DigitalOcean` (North Bergen NJ), droplet-2 = `AS14061 DigitalOcean` (Santa Clara CA) → **same AS, different region/metro** (`golive/asn.txt`). |
| 5.2+5.3+5.4 | bootstrap gateway-only | pass | `curl -fsSL …/main/bootnode/deploy/bootstrap.sh -o /tmp/bootstrap.sh; sudo RGOE_BOOTNODE_ONION=<BN_ONION> RGOE_BOOTNODE_SIGNER=<SIGNER> RGOE_GATEWAY_REGION=na RGOE_ENABLE_POW=0 bash /tmp/bootstrap.sh` (GAP-6 mode). Tor Project tor 0.4.9.11, Node 24.19.0 (fresh box, no Node-20 SIGSYS). No local bootnode unit rendered (5.4(a) by construction). Banner printed `<GW2_ONION>`. `tor rgoe-gateway rgoe-heartbeat` active; gateway `root source: members.json (PoC fallback) members=8`, `zk artifacts accepted=["rln-0b25f824a04da3a8"]`; heartbeat `heartbeat: av4m256h4wwgwdmg..onion -> kssrk54kb5kngr4j..onion every 300s`, `capabilities advertised (signed): {"region":"na","proto":{"min":3,"max":3}}`, `announced (staked=false, ttl=900s)` first try. `systemd-analyze security` = 2.8 OK both units; ufw 22/tcp only. |
| 5.5 | metrics | pass | drop-in `rgoe-gateway.service.d/metrics.conf` (`RGOE_METRICS_PORT=9101`) → `127.0.0.1:9101/metrics` serves 11 `rgoe_gateway_*` lines, loopback only. |
| 5.6 | stake/authorize gateway-2 | pass | see Phase 3 below (same operator; `announced (staked=true, ttl=900s)`). |
| 5.7 | **T-DEPLOY-2 acceptance A** | **PASS** | `/directory` via laptop tor (SOCKS 9260): `2` gateways `["yaxo4ywg…7yqd.onion","av4m256h…twid.onion"]`, both `health: up`, weight 100; `rgoe verify-directory golive/directory-2gw.json --signer <SIGNER>` → `ok`. Bootnode `/health` `{"ok":true,"count":2,…}`. Re-done after the stake switch: `{"ok":true,"count":2,"admission":"stake",…}`, both entries `staked: true`, verify `ok` → committed as `network/sepolia/directory-bootnode.json`. |
| 5.8 | **T-DEPLOY-2 acceptance B (rotation)** | **PASS** | `RGOE_ROTATION_SPREAD=1 node bin/rgoe.mjs client --bootnode <BN_ONION> --dir-signer <SIGNER> --tor-port 9260` → `mode: directory fleet rotation`; 8× `curl -sx http://127.0.0.1:8888 https://api.ipify.org` → **4× droplet-1 IP, 4× droplet-2 IP** (`golive/accept-2b.txt`); shim log `TUNNEL … slot=0 via av4m256h…`, `slot=1 via yaxo4ywg…`, … alternating through slot 7. Repeated after the stake switch: again 4/4 (`golive/accept-2b-stake.txt`). |
| 5.9 | Rust rotation | pass (with a finding) | Fresh `cargo build --release -p rgoe-client --features live` binary at `d8a6530`. Runs with `--slot-cursor golive/rust/slot.cursor --health-cache golive/rust/health.json` (same identity, one epoch): slot 0 → `ok gateway: av4m256h…twid.onion:80`, slot 1 → `av4m256h…`, slot 2 → `av4m256h…`, slot 3 → `ok gateway: yaxo4ywg…7yqd.onion:80` (`golive/accept-2c.txt`); three other invocations exited 2 on `no verifiable directory … tor operation timed out` (embedded arti bootnode dial; retry succeeded each time). **Finding:** a first attempt used the STALE main-checkout binary (built 2026-08-14, before `--slot-cursor` existed) which silently ignored the flag → 4 runs all at slot 0 in one epoch → runs 2 and 4 were `not-ok: gate-refused: over-spend-slashed`; both gateways logged `SLASH (dry-run) commitment=8359813801…` (rate-limit working as designed; slashing was still DRY-RUN at that moment, the per-nullifier `slashed` mark is in-memory and epoch-scoped, no on-chain effect, the demo secret `alice` is not in the on-chain set). Lesson: always rebuild the Rust `-live` binary at the deployed ref before an acceptance. |
| 5.10 | both-ends spread receipt | pass (qualified) | `golive/asn.txt` + `golive/accept-2b.txt`: two egress IPs, two DO regions (NYC vs SFO), one client. **Same ASN (AS14061)** — a second *provider* is still open (GAP-5 note in the runbook: the tofu module is DO-only). |
| 4.5 (re) | privacy | pass | laptop public IP occurrences in gateway + bootnode journals: droplet-1 0/0, droplet-2 0/0. |
| 4.9 (re) | uptime probe | pass | `{"ok":true,"bootnodeReachable":true,"signerOk":true,"fleetSize":2}` exit 0. |

### Phase 3 — Stake admission `[HUMAN decided: yes]` `[FUNDS: 0.001 ETH bond + gas]`

| # | step | result | observed |
|---|---|---|---|
| 3.1–3.3 | deploy | n/a | `GatewayRegistry` was already live (`0x94ECeD0C…A868`, `network/sepolia/contracts.json`). |
| 3.4 | stake operator | pass | operator key = the fleet operator hot key from `agent-devops` `egress.sops.yml` (decrypted into a shell var, never printed). Before: `rgoe gateway-status` `state: not staked`, balance ≈0.052 ETH. `RGOE_REGISTER_KEY=… rgoe register-gateway --gateway-registry 0x94EC…A868 --rpc-url …publicnode.com` → tx `0x15d810b7…d15fc`, `mined in block 11510519; operator staked`. After: `gateway-status` `state: staked (active)`, `cast call … isStaked(address)` = `true`. |
| 3.6 (+5.6) | heartbeat operator auth | pass | On BOTH boxes: drop-in `/etc/systemd/system/rgoe-heartbeat.service.d/operator.conf` (`Environment=RGOE_GW_OPERATOR_KEY=…`, written via stdin, mode 0600, never in argv/log), daemon-reload + restart → `heartbeat: … (operator 0xc8606C75..)`, `announced (staked=true, ttl=900s)` on droplet-1 and droplet-2. Done BEFORE 3.5 so no entry was ever refused. |
| 3.5 | bootnode → stake | pass | droplet-1 drop-in `rgoe-bootnode.service.d/admission.conf` (`RGOE_BOOTNODE_ADMISSION=stake`, `RGOE_STAKE_MODE=onchain`, `RGOE_GATEWAY_REGISTRY`, `RGOE_RPC_URL`), daemon-reload + restart → `persistence: reloaded gateways loaded=2 dropped=0`, `bootnode up on 127.0.0.1:8877 admission=stake stake=onchain ttlSec=900`; `/health` `{"ok":true,"count":2,"admission":"stake",…}`; both heartbeats restarted → `announced (staked=true, ttl=900s)` under stake admission; `/directory` entries `staked: true`, `operator: 0xc8606c75…`. Rollback (untested, GO-LIVE 3.5): delete the drop-in, reload, restart. |
| 3.7 | gateway on-chain slashing | pass | Both boxes: drop-in `rgoe-gateway.service.d/slash.conf` (`RGOE_SLASH_KEY`=same hot key, `RGOE_SLASH_CONTRACT=0xdAE242AE…20FC`, `RGOE_RPC_URL`, `RGOE_SLASH_RECEIVER=0xc8606C75…7f02` — the legacy fleet's config), restart → `slash: on-chain via=0xdAE242AE… receiver=0xc8606C75…` (no more `slash: DRY-RUN`). Caveat: the gateways' membership root is still the PoC `members.json`, not the on-chain `StakedReputationSet` tree (T-DEV-9c), so an on-chain slash of a PoC-set member would target a leaf that contract does not know. |

### Phase 6 — 6.6/6.7 backups + restore proof

| # | step | result | observed |
|---|---|---|---|
| 6.6 | backup | pass | On each box: `sudo -E -u rgoe node /opt/rgoe/bin/rgoe.mjs backup /opt/rgoe/deploy-state /tmp/rgoe-keys-<host>-2026-08-17.rgoebak` (passphrase via env only), `scp` to the laptop `~/reputation-gated-onion-egress/backups/` (gitignored by this PR, `.git/info/exclude` too), on-box copy `shred -u`. droplet-1: 5 secret files (`bootnode-hs/{hs_ed25519_secret_key,identity.local.json}`, `bootnode-signer.key`, `gateway-hs/{…}`); droplet-2: 2 (`gateway-hs/{…}`). Passphrase stored separately at `~/.config/rgoe/backup-passphrase` (0600) — move it to the password manager. |
| 6.7 | prove restore | pass | `rgoe restore <file> <scratch>` for both → `scripts/onion-identity.mjs derive` prints exactly `<GW1_ONION>`, `<BN_ONION>` (droplet-1) and `<GW2_ONION>` (droplet-2); restored `bootnode-signer.key` `.pub` == `<SIGNER>`. Scratch dir removed. (`rgoe restore` has no `--dry-run`; the scratch-dir restore is the dry run.) |
| 6.8 | systemd security | pass | droplet-1 bootnode/gateway/heartbeat 2.8 OK; droplet-2 gateway/heartbeat 2.8 OK. |

### Box-1 tidy (PoC leftovers, "Left open" #5)

Stopped (SIGTERM, pids only): the June PoC `tor -f ./tor/torrc` (mindagent, up 40 d, SOCKS 9250 /
9251, PoC HS dir), the PoC `node client/shim.mjs` (box-local 8888), and a 69-day-old
`experiments/bench-crypto.mjs` benchmark. `rgoe-tor.service` (loaded, dead, was enabled) →
`systemctl disable` (unit file left in place; PoC unit backups still in `/root/poc-units-backup/`).
NOT touched: the PoC checkout `~/reputation-gated-onion-egress` and its `tor/hs/` keys. After:
9250/9251/8888 closed; `tor rgoe-bootnode rgoe-gateway rgoe-heartbeat` all active.

### Left open (updated)

1. ~~T-DEPLOY-2~~ done. Second **provider/ASN** still open (both boxes AS14061).
2. ~~Stake admission~~ done. `RGOE_CONFIRMATIONS` left at 0 (`latest`); consider 6.
3. ~~Backups~~ done for both boxes; passphrase to the password manager.
4. Monitoring (6.1–6.4) unchanged: loopback metrics, no scrape, no SLO baseline.
5. ~~PoC leftovers~~ stopped (not deleted).
6. agent-devops: `rgoe-gw-04` committed on the checkout's current branch (`zakura-min-spec-bench`, pushed) — landing to `main` is a repo decision; the tofu state now mixes two DO accounts (see 5.1 note).
7. Membership root on the gateways is still the PoC `members.json` (T-DEV-9c).
