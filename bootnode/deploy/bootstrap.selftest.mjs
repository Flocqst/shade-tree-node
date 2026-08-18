// Offline proof of what bootnode/deploy/bootstrap.sh RENDERS, without root, apt, tor, or systemd.
// bootstrap.sh has a render mode (RGOE_RENDER_ONLY=<dir> / --render <dir>) that runs the SAME
// torrc + unit renderers the live path uses and writes them under <dir>/etc/... with fixed
// placeholder onions, so the output is deterministic and can be byte-compared.
//
// What is asserted:
//   1. DEFAULT (no tunables) is frozen against bootnode/deploy/golden/default/** — any drift in
//      the torrc include or the three units is a deliberate, reviewed change (regenerate with
//      RGOE_UPDATE_GOLDEN=1 node bootnode/deploy/bootstrap.selftest.mjs and commit the diff).
//   2. RGOE_ENABLE_POW=1 / =0 (GAP-3): valid torrc in both states; the PoW line is a PER-SERVICE
//      option and must sit inside each HiddenServiceDir block right after its HiddenServicePort;
//      nothing else changes; a garbage value is rejected before anything would be installed.
//   3. RGOE_BOOTNODE_ONION=<onion> (GAP-6, gateway-only): NO rgoe-bootnode unit, NO bootnode HS
//      block, the heartbeat announces to the REMOTE onion (with/without .onion suffix accepted),
//      the gateway unit is byte-identical to the default one, a malformed onion is rejected.
//   4. RGOE_GATEWAY_REGION passthrough into the heartbeat unit; invalid bucket rejected.
//   5. Nothing outside <dir> is touched (the render dir is the only side effect).
//   6. RGOE_HELIOS=1 (T-DEV-9b, opt-in): a 4th unit rgoe-helios.service (hardened, loopback-only,
//      endpoints via env not argv, W^X on) and the gateway unit ordered after it carrying
//      RGOE_ROOT_PROVIDER=light + RGOE_HELIOS_RPC_URL + RGOE_RPC_URL + RGOE_GROUP_CONTRACT; the
//      other files byte-identical to the default; missing/invalid companions rejected up front;
//      RGOE_HELIOS=0 == default (golden unchanged, i.e. the sidecar is opt-in).
//
//   7. RGOE_REGISTRAR=1 (T-FEAT-7, opt-in): a rgoe-registrar.service (hardened, loopback, operator
//      key NOT rendered), an EXTRA HiddenServicePort inside the bootnode HS block (same onion), the
//      bootnode unit advertising the offer (RGOE_REGISTRAR_ADVERTISE=1 + RGOE_PAY_*), everything
//      else byte-identical; companions validated up front; incompatible with gateway-only mode;
//      RGOE_REGISTRAR=0 == default (golden unchanged).
//   8. RGOE_FROM_BLOCK / RGOE_FROM_BLOCKS (eth_getLogs start blocks, fleet crash-loop 2026-08-17):
//      passed verbatim into the gateway unit when set, validated up front, everything else
//      byte-identical; unset == default (golden unchanged).
//   9. RGOE_ADMIT (T-FEAT-9, docs/adr/0008): DEFAULT `invited` (the golden gateway + heartbeat units
//      carry Environment=RGOE_ADMIT=invited -- regenerated for this); staked/paid opt-in renders the
//      contracts + RPC into the gateway unit and is fail-closed on a missing companion; canonical
//      order; RGOE_PAY_PROTOCOLS subset normalized into registrar + both adverts; RGOE_REGISTRAR=1
//      requires `paid` admitted; a GATEWAY-ONLY box may run the registrar on the GATEWAY onion.
//
//   node bootnode/deploy/bootstrap.selftest.mjs
//
// Exit 0 = every check passed; nonzero = a check failed (prints which). Needs bash on PATH.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "bootstrap.sh");
const GOLDEN = join(HERE, "golden", "default");

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const ONION = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx";

// Run bootstrap.sh in render mode with a MINIMAL env (only PATH + HOME + our tunables), so
// nothing from the developer's shell (e.g. a stray RGOE_ENABLE_POW) leaks into the render.
function render(work, name, env = {}, args = []) {
  const out = join(work, name);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/", RGOE_RENDER_ONLY: args.length ? "" : out, ...env },
    encoding: "utf8",
  });
  return { out, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function listFiles(root) {
  const acc = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p); else acc.push(relative(root, p));
    }
  }
  await walk(root);
  return acc.sort();
}

async function readAll(root) {
  const files = await listFiles(root);
  const m = new Map();
  for (const f of files) m.set(f, await readFile(join(root, f), "utf8"));
  return m;
}

// Parse a torrc include into HS blocks: [{dir, lines:[...]}]. Lines before the first
// HiddenServiceDir (comments) are dropped. Comments inside blocks are dropped too.
function hsBlocks(torrc) {
  const blocks = [];
  for (const raw of torrc.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("HiddenServiceDir ")) blocks.push({ dir: line.slice("HiddenServiceDir ".length), lines: [] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    else throw new Error(`torrc option before any HiddenServiceDir: ${line}`);
  }
  return blocks;
}

function unitEnv(unit, key) {
  const m = unit.match(new RegExp(`^Environment=${key}=(.*)$`, "m"));
  return m ? m[1] : null;
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "rgoe-bootstrap-render-"));
  try {
    // ---------------------------------------------------------------- 1. default == golden
    console.log("default render (golden):");
    const def = render(work, "default");
    ok(def.status === 0, `render exits 0 (${(def.stdout || "").trim()})`);
    const got = await readAll(def.out);
    ok(
      [...got.keys()].join(",") === "etc/systemd/system/rgoe-bootnode.service,etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/tor/torrc.d-rgoe",
      `emits exactly torrc + 3 units (${[...got.keys()].join(", ")})`,
    );
    if (process.env.RGOE_UPDATE_GOLDEN === "1") {
      await rm(GOLDEN, { recursive: true, force: true });
      for (const [f, body] of got) { await mkdir(dirname(join(GOLDEN, f)), { recursive: true }); await writeFile(join(GOLDEN, f), body); }
      console.log(`  (golden regenerated at ${GOLDEN})`);
    }
    const want = await readAll(GOLDEN);
    ok(want.size === got.size, `golden has the same file set (${want.size} files)`);
    for (const [f, body] of want) ok(got.get(f) === body, `byte-identical to golden: ${f}`);
    // Sanity on the golden itself (so a bad regeneration cannot freeze a broken render).
    const torrc = got.get("etc/tor/torrc.d-rgoe");
    const blocks = hsBlocks(torrc);
    ok(blocks.length === 2 && blocks[0].dir === "/var/lib/tor/rgoe-bootnode" && blocks[1].dir === "/var/lib/tor/rgoe-gateway", "default torrc: bootnode + gateway HS blocks, in that order");
    for (const b of blocks) {
      ok(b.lines[0]?.startsWith("HiddenServicePort 80 127.0.0.1:") && b.lines[1] === "HiddenServicePoWDefensesEnabled 0" && b.lines.length === 2,
        `${b.dir}: HiddenServicePort then HiddenServicePoWDefensesEnabled 0 (PoW default OFF), nothing else`);
    }
    ok(blocks[0].lines[0].endsWith(":8877") && blocks[1].lines[0].endsWith(":8443"), "default ports 8877 (bootnode) / 8443 (gateway)");
    const hbDef = got.get("etc/systemd/system/rgoe-heartbeat.service");
    ok(unitEnv(hbDef, "RGOE_BOOTNODE_ONION")?.endsWith(".onion") && /^After=rgoe-bootnode\.service tor\.service$/m.test(hbDef), "default heartbeat -> LOCAL bootnode, ordered after rgoe-bootnode.service");
    ok(unitEnv(hbDef, "RGOE_GATEWAY_REGION") === null, "default heartbeat advertises no region");
    for (const f of got.keys()) if (f.endsWith(".service")) {
      const u = got.get(f);
      ok(/^NoNewPrivileges=true$/m.test(u) && /^ProtectSystem=strict$/m.test(u) && /^CapabilityBoundingSet=$/m.test(u) && /^SystemCallFilter=@system-service$/m.test(u), `${f}: sandbox lines present (T-DEPLOY-4)`);
    }

    // ---------------------------------------------------------------- 2. PoW toggle
    console.log("RGOE_ENABLE_POW (GAP-3):");
    const powOn = render(work, "pow-on", { RGOE_ENABLE_POW: "1" });
    ok(powOn.status === 0, "RGOE_ENABLE_POW=1 renders");
    const onT = await readFile(join(powOn.out, "etc/tor/torrc.d-rgoe"), "utf8");
    const onBlocks = hsBlocks(onT);
    ok(onBlocks.length === 2 && onBlocks.every((b) => b.lines[0].startsWith("HiddenServicePort ") && b.lines[1] === "HiddenServicePoWDefensesEnabled 1" && b.lines.length === 2),
      "pow=1: each HS block = HiddenServicePort then HiddenServicePoWDefensesEnabled 1 (per-service option placement)");
    const strip = (s) => s.split("\n").filter((l) => !l.startsWith("#") && !l.startsWith("HiddenServicePoWDefensesEnabled")).join("\n");
    ok(strip(onT) === strip(torrc), "pow=1 vs default: only the PoW lines (and the comment) differ");
    const onUnits = await readAll(powOn.out);
    for (const f of got.keys()) if (f.endsWith(".service")) ok(onUnits.get(f) === got.get(f), `pow=1 leaves ${f} byte-identical`);
    for (const alias of ["true", "yes", "on"]) {
      const r = render(work, `pow-${alias}`, { RGOE_ENABLE_POW: alias });
      ok(r.status === 0 && (await readFile(join(r.out, "etc/tor/torrc.d-rgoe"), "utf8")) === onT, `RGOE_ENABLE_POW=${alias} == 1`);
    }
    const powOff = render(work, "pow-off", { RGOE_ENABLE_POW: "0" });
    ok(powOff.status === 0 && (await readFile(join(powOff.out, "etc/tor/torrc.d-rgoe"), "utf8")) === torrc, "RGOE_ENABLE_POW=0 == default (explicit off is the default)");
    for (const alias of ["false", "no", "off"]) {
      const r = render(work, `pow-${alias}`, { RGOE_ENABLE_POW: alias });
      ok(r.status === 0 && (await readFile(join(r.out, "etc/tor/torrc.d-rgoe"), "utf8")) === torrc, `RGOE_ENABLE_POW=${alias} == 0`);
    }
    const powBad = render(work, "pow-bad", { RGOE_ENABLE_POW: "maybe" });
    ok(powBad.status !== 0 && /RGOE_ENABLE_POW must be 1 or 0/.test(powBad.stderr), "RGOE_ENABLE_POW=maybe is rejected up front");
    ok(!(await stat(powBad.out).catch(() => null)), "rejected render writes nothing");

    // ---------------------------------------------------------------- 3. gateway-only mode
    console.log("RGOE_BOOTNODE_ONION gateway-only (GAP-6):");
    const gw = render(work, "gw-only", { RGOE_BOOTNODE_ONION: `${ONION}.onion` });
    ok(gw.status === 0 && /gateway-only/.test(gw.stdout), `gateway-only renders (${(gw.stdout || "").trim()})`);
    const gwFiles = await readAll(gw.out);
    ok([...gwFiles.keys()].join(",") === "etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/tor/torrc.d-rgoe",
      `emits torrc + gateway + heartbeat ONLY (${[...gwFiles.keys()].join(", ")})`);
    const gwBlocks = hsBlocks(gwFiles.get("etc/tor/torrc.d-rgoe"));
    ok(gwBlocks.length === 1 && gwBlocks[0].dir === "/var/lib/tor/rgoe-gateway", "torrc: gateway HS block only (no bootnode HS)");
    ok(!/rgoe-bootnode/.test(gwFiles.get("etc/tor/torrc.d-rgoe").split("\n").filter((l) => !l.startsWith("#")).join("\n")), "torrc: no bootnode dir anywhere");
    ok(gwBlocks[0].lines[0] === "HiddenServicePort 80 127.0.0.1:8443" && gwBlocks[0].lines[1] === "HiddenServicePoWDefensesEnabled 0", "gateway block: port then PoW (default off)");
    ok(gwFiles.get("etc/systemd/system/rgoe-gateway.service") === got.get("etc/systemd/system/rgoe-gateway.service"), "gateway unit byte-identical to the default one");
    const hb = gwFiles.get("etc/systemd/system/rgoe-heartbeat.service");
    ok(unitEnv(hb, "RGOE_BOOTNODE_ONION") === `${ONION}.onion`, "heartbeat announces to the REMOTE bootnode onion");
    ok(!/rgoe-bootnode\.service/.test(hb) && /^After=network-online\.target tor\.service$/m.test(hb), "heartbeat no longer ordered after a (non-existent) local rgoe-bootnode unit");
    ok(unitEnv(hb, "RGOE_GW_IDENTITY") === unitEnv(hbDef, "RGOE_GW_IDENTITY") && unitEnv(hb, "RGOE_TOR_PORT") === "9050", "heartbeat identity/Tor SOCKS unchanged");
    const stripUnit = (u) => u.split("\n").filter((l) => !/^(Description=|After=|Wants=|Environment=RGOE_BOOTNODE_ONION=)/.test(l)).join("\n");
    ok(stripUnit(hb) === stripUnit(hbDef), "heartbeat unit otherwise identical to the default (sandbox, exec, restart)");
    const gwBare = render(work, "gw-only-bare", { RGOE_BOOTNODE_ONION: ONION });
    ok(gwBare.status === 0 && unitEnv(await readFile(join(gwBare.out, "etc/systemd/system/rgoe-heartbeat.service"), "utf8"), "RGOE_BOOTNODE_ONION") === `${ONION}.onion`, "bare 56-char onion (no suffix) is normalised to <onion>.onion");
    for (const bad of ["not-an-onion", `${ONION.slice(0, 55)}.onion`, `${ONION}1.onion`, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX.onion", `${ONION}.onion;rm -rf /`]) {
      const r = render(work, "gw-bad", { RGOE_BOOTNODE_ONION: bad });
      ok(r.status !== 0 && /RGOE_BOOTNODE_ONION must be a v3 onion/.test(r.stderr), `malformed bootnode onion rejected: ${JSON.stringify(bad)}`);
    }
    // PoW toggle composes with gateway-only.
    const gwPow = render(work, "gw-only-pow", { RGOE_BOOTNODE_ONION: ONION, RGOE_ENABLE_POW: "1" });
    const gwPowBlocks = hsBlocks(await readFile(join(gwPow.out, "etc/tor/torrc.d-rgoe"), "utf8"));
    ok(gwPow.status === 0 && gwPowBlocks.length === 1 && gwPowBlocks[0].lines[1] === "HiddenServicePoWDefensesEnabled 1", "gateway-only + RGOE_ENABLE_POW=1: single block, PoW on");
    // --render <dir> CLI form == env form.
    const cli = render(work, "cli", { RGOE_BOOTNODE_ONION: ONION }, ["--render", join(work, "cli")]);
    ok(cli.status === 0 && (await readAll(join(work, "cli"))).get("etc/systemd/system/rgoe-heartbeat.service") === hb, "`--render <dir>` == RGOE_RENDER_ONLY=<dir>");

    // ---------------------------------------------------------------- 4. region passthrough
    console.log("RGOE_GATEWAY_REGION passthrough:");
    const reg = render(work, "region", { RGOE_GATEWAY_REGION: "eu" });
    ok(reg.status === 0 && unitEnv(await readFile(join(reg.out, "etc/systemd/system/rgoe-heartbeat.service"), "utf8"), "RGOE_GATEWAY_REGION") === "eu", "RGOE_GATEWAY_REGION=eu lands in the heartbeat unit");
    const regT = await readAll(reg.out);
    ok(regT.get("etc/tor/torrc.d-rgoe") === torrc && regT.get("etc/systemd/system/rgoe-bootnode.service") === got.get("etc/systemd/system/rgoe-bootnode.service"), "region does not touch torrc / bootnode unit");
    const regBad = render(work, "region-bad", { RGOE_GATEWAY_REGION: "mars" });
    ok(regBad.status !== 0 && /RGOE_GATEWAY_REGION must be one of/.test(regBad.stderr), "invalid region bucket rejected");

    // ---------------------------------------------------------------- 6. helios sidecar (opt-in)
    console.log("RGOE_HELIOS sidecar (T-DEV-9b):");
    // T-FEAT-9: the helios sidecar anchors the STAKED (on-chain) root, so it requires an admission
    // policy that admits staked leaves; RGOE_ADMIT=invited,staked here (default `invited` alone is rejected below).
    const HEL = { RGOE_HELIOS: "1", RGOE_HELIOS_CONSENSUS_RPC: "https://beacon.example/", RGOE_RPC_URL: "https://rpc.example/v1/KEY", RGOE_GROUP_CONTRACT: "0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC", RGOE_ADMIT: "invited,staked" };
    const hel = render(work, "helios", HEL);
    ok(hel.status === 0 && /helios=1/.test(hel.stdout), `RGOE_HELIOS=1 renders (${(hel.stdout || "").trim()})`);
    const helFiles = await readAll(hel.out);
    ok([...helFiles.keys()].join(",") === "etc/systemd/system/rgoe-bootnode.service,etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/systemd/system/rgoe-helios.service,etc/tor/torrc.d-rgoe",
      `emits torrc + 3 units + rgoe-helios.service (${[...helFiles.keys()].join(", ")})`);
    const hu = helFiles.get("etc/systemd/system/rgoe-helios.service");
    ok(/^ExecStart=\/usr\/local\/bin\/helios ethereum --network sepolia --rpc-bind-ip 127\.0\.0\.1 --rpc-port 8546 --data-dir \/opt\/rgoe\/deploy-state\/helios --load-external-fallback$/m.test(hu), "helios ExecStart: sepolia, loopback bind, port 8546, data-dir under deploy-state, external checkpoint fallback (no RGOE_HELIOS_CHECKPOINT)");
    ok(unitEnv(hu, "EXECUTION_RPC") === HEL.RGOE_RPC_URL && unitEnv(hu, "CONSENSUS_RPC") === HEL.RGOE_HELIOS_CONSENSUS_RPC, "helios endpoints passed via EXECUTION_RPC / CONSENSUS_RPC env (not argv)");
    ok(!/ExecStart=.*(rpc\.example|beacon\.example)/.test(hu), "no endpoint URL on the helios command line (API keys stay out of `ps`)");
    ok(/^User=rgoe$/m.test(hu) && /^MemoryDenyWriteExecute=true$/m.test(hu) && /^NoNewPrivileges=true$/m.test(hu) && /^ProtectSystem=strict$/m.test(hu) && /^CapabilityBoundingSet=$/m.test(hu) && /^SystemCallFilter=@system-service$/m.test(hu) && /^Restart=always$/m.test(hu), "helios unit: sandbox lines + W^X (Rust binary) + Restart=always");
    ok(unitEnv(hu, "CHECKPOINT") === null, "no CHECKPOINT env when RGOE_HELIOS_CHECKPOINT unset");
    const gwH = helFiles.get("etc/systemd/system/rgoe-gateway.service");
    ok(/^After=network-online\.target tor\.service rgoe-helios\.service$/m.test(gwH) && /^Wants=network-online\.target rgoe-helios\.service$/m.test(gwH), "gateway unit ordered after + wants rgoe-helios.service");
    ok(unitEnv(gwH, "RGOE_ROOT_PROVIDER") === "light" && unitEnv(gwH, "RGOE_HELIOS_RPC_URL") === "http://127.0.0.1:8546" && unitEnv(gwH, "RGOE_RPC_URL") === HEL.RGOE_RPC_URL && unitEnv(gwH, "RGOE_GROUP_CONTRACT") === HEL.RGOE_GROUP_CONTRACT, "gateway unit: RGOE_ROOT_PROVIDER=light + RGOE_HELIOS_RPC_URL + RGOE_RPC_URL + RGOE_GROUP_CONTRACT");
    const stripGw = (u) => u.split("\n").filter((l) => !/^(After=|Wants=|Environment=RGOE_(GROUP_CONTRACT|RPC_URL|ROOT_PROVIDER|HELIOS_RPC_URL)=)/.test(l)).join("\n").replace("Environment=RGOE_ADMIT=invited,staked", "Environment=RGOE_ADMIT=invited");
    ok(stripGw(gwH) === stripGw(got.get("etc/systemd/system/rgoe-gateway.service")), "gateway unit otherwise identical to the default (sandbox, exec, restart)");
    for (const f of ["etc/tor/torrc.d-rgoe", "etc/systemd/system/rgoe-bootnode.service"]) ok(helFiles.get(f) === got.get(f), `helios=1 leaves ${f} byte-identical`);
    ok(helFiles.get("etc/systemd/system/rgoe-heartbeat.service").replace("Environment=RGOE_ADMIT=invited,staked", "Environment=RGOE_ADMIT=invited") === got.get("etc/systemd/system/rgoe-heartbeat.service"), "helios=1 leaves the heartbeat unit byte-identical apart from advertising RGOE_ADMIT=invited,staked");
    // companions + checkpoint + port + network
    const helCp = render(work, "helios-cp", { ...HEL, RGOE_HELIOS_CHECKPOINT: "0x" + "ab".repeat(32), RGOE_HELIOS_PORT: "9545", RGOE_HELIOS_NETWORK: "mainnet" });
    const huCp = await readFile(join(helCp.out, "etc/systemd/system/rgoe-helios.service"), "utf8");
    ok(helCp.status === 0 && unitEnv(huCp, "CHECKPOINT") === "0x" + "ab".repeat(32) && /--network mainnet --rpc-bind-ip 127\.0\.0\.1 --rpc-port 9545 /.test(huCp) && !/--load-external-fallback/.test(huCp), "pinned checkpoint -> CHECKPOINT env, no external fallback; port + network passthrough");
    ok(unitEnv(await readFile(join(helCp.out, "etc/systemd/system/rgoe-gateway.service"), "utf8"), "RGOE_HELIOS_RPC_URL") === "http://127.0.0.1:9545", "gateway RGOE_HELIOS_RPC_URL follows RGOE_HELIOS_PORT");
    // guards
    const bad = [
      [{ ...HEL, RGOE_HELIOS_CONSENSUS_RPC: "" }, /needs RGOE_HELIOS_CONSENSUS_RPC/],
      [{ ...HEL, RGOE_HELIOS_CONSENSUS_RPC: "beacon.example" }, /needs RGOE_HELIOS_CONSENSUS_RPC/],
      [{ ...HEL, RGOE_RPC_URL: "" }, /needs RGOE_RPC_URL/],
      [{ ...HEL, RGOE_RPC_URL: "https://x/;rm -rf /" }, /needs RGOE_RPC_URL/],
      [{ ...HEL, RGOE_GROUP_CONTRACT: "" }, /needs RGOE_GROUP_CONTRACT/],
      [{ ...HEL, RGOE_GROUP_CONTRACT: "0x1234" }, /needs RGOE_GROUP_CONTRACT/],
      [{ ...HEL, RGOE_ADMIT: "invited" }, /RGOE_HELIOS=1 anchors the ON-CHAIN \(staked\) admission root, but RGOE_ADMIT=invited/],
      [{ ...HEL, RGOE_HELIOS_NETWORK: "goerli" }, /RGOE_HELIOS_NETWORK must be/],
      [{ ...HEL, RGOE_HELIOS_PORT: "80" }, /RGOE_HELIOS_PORT must be/],
      [{ ...HEL, RGOE_HELIOS_PORT: "abc" }, /RGOE_HELIOS_PORT must be/],
      [{ ...HEL, RGOE_HELIOS_CHECKPOINT: "0x1234" }, /RGOE_HELIOS_CHECKPOINT must be/],
      [{ ...HEL, RGOE_HELIOS_VERSION: "latest" }, /RGOE_HELIOS_VERSION must look like/],
      [{ ...HEL, RGOE_HELIOS_SHA256: "nothex" }, /RGOE_HELIOS_SHA256 must be/],
      [{ RGOE_HELIOS: "maybe" }, /RGOE_HELIOS must be 1 or 0/],
    ];
    for (const [env, re] of bad) {
      const r = render(work, "helios-bad", env);
      ok(r.status !== 0 && re.test(r.stderr), `rejected up front: ${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k, v]) => HEL[k] !== v)))}`);
    }
    for (const off of ["0", "false", "off"]) {
      const r = render(work, `helios-${off}`, { RGOE_HELIOS: off });
      const files = await readAll(r.out);
      ok(r.status === 0 && files.size === got.size && [...got].every(([f, b]) => files.get(f) === b), `RGOE_HELIOS=${off} == default (opt-in; golden untouched)`);
    }
    // composes with gateway-only
    const helGw = render(work, "helios-gw-only", { ...HEL, RGOE_BOOTNODE_ONION: ONION });
    const helGwFiles = await readAll(helGw.out);
    ok(helGw.status === 0 && [...helGwFiles.keys()].join(",") === "etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/systemd/system/rgoe-helios.service,etc/tor/torrc.d-rgoe" && helGwFiles.get("etc/systemd/system/rgoe-helios.service") === hu, "gateway-only + helios: gateway + heartbeat + helios units, helios unit identical");

    // ---------------------------------------------------------------- 7. 402 registrar (opt-in)
    console.log("RGOE_REGISTRAR (T-FEAT-7):");
    // T-FEAT-9: a gateway must ADMIT what it sells, so RGOE_REGISTRAR=1 requires `paid` in RGOE_ADMIT
    // (the default `invited` alone is rejected below); the gateway unit then carries the paid set + RPC.
    const REG = { RGOE_REGISTRAR: "1", RGOE_PAID_ACCESS_CONTRACT: "0x1111111111111111111111111111111111111111", RGOE_PAY_ASSET: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", RGOE_PAY_PRICES: "8=100000,32=400000", RGOE_RPC_URL: "https://rpc.example/v1/KEY", RGOE_ADMIT: "invited,paid" };
    const reg1 = render(work, "registrar", REG);
    ok(reg1.status === 0 && /registrar=1/.test(reg1.stdout), `RGOE_REGISTRAR=1 renders (${(reg1.stdout || "").trim()})`);
    const regFiles = await readAll(reg1.out);
    ok([...regFiles.keys()].join(",") === "etc/systemd/system/rgoe-bootnode.service,etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/systemd/system/rgoe-registrar.service,etc/tor/torrc.d-rgoe",
      `emits torrc + 3 units + rgoe-registrar.service (${[...regFiles.keys()].join(", ")})`);
    const rgT = hsBlocks(regFiles.get("etc/tor/torrc.d-rgoe"));
    ok(rgT.length === 2 && rgT[0].dir === "/var/lib/tor/rgoe-bootnode" && rgT[0].lines.join("|") === "HiddenServicePort 80 127.0.0.1:8877|HiddenServicePort 8878 127.0.0.1:8878|HiddenServicePoWDefensesEnabled 0", "bootnode HS block: port 80 + EXTRA port 8878 -> 127.0.0.1:8878, then the PoW line (registrar rides the bootnode onion)");
    ok(rgT[1].lines.join("|") === "HiddenServicePort 80 127.0.0.1:8443|HiddenServicePoWDefensesEnabled 0", "gateway HS block unchanged");
    const ru = regFiles.get("etc/systemd/system/rgoe-registrar.service");
    ok(/^ExecStart=\/usr\/bin\/node \/opt\/rgoe\/payments\/registrar\.mjs$/m.test(ru) && unitEnv(ru, "RGOE_REGISTRAR_PORT") === "8878" && unitEnv(ru, "RGOE_PAID_ACCESS_CONTRACT") === REG.RGOE_PAID_ACCESS_CONTRACT && unitEnv(ru, "RGOE_PAY_ASSET") === REG.RGOE_PAY_ASSET && unitEnv(ru, "RGOE_PAY_PRICES") === REG.RGOE_PAY_PRICES && unitEnv(ru, "RGOE_RPC_URL") === REG.RGOE_RPC_URL && unitEnv(ru, "RGOE_REGISTRAR_STORE") === "/opt/rgoe/deploy-state/registrar-state.json" && unitEnv(ru, "RGOE_REGISTRAR_ONION")?.endsWith(".onion"), "registrar unit: ExecStart payments/registrar.mjs + port/contract/asset/prices/rpc/store/onion env");
    ok(unitEnv(ru, "RGOE_REGISTRAR_KEY") === null && !/RGOE_REGISTRAR_KEY/.test(ru) && unitEnv(ru, "RGOE_PAY_TO") === null, "operator key NOT rendered (drop-in only); no RGOE_PAY_TO unless given");
    ok(/^User=rgoe$/m.test(ru) && /^NoNewPrivileges=true$/m.test(ru) && /^ProtectSystem=strict$/m.test(ru) && /^CapabilityBoundingSet=$/m.test(ru) && /^SystemCallFilter=@system-service$/m.test(ru) && /^Restart=always$/m.test(ru) && !/MemoryDenyWriteExecute/.test(ru), "registrar unit: same sandbox as the other Node units (no W^X: V8 JIT)");
    const bnR = regFiles.get("etc/systemd/system/rgoe-bootnode.service");
    ok(unitEnv(bnR, "RGOE_REGISTRAR_ADVERTISE") === "1" && unitEnv(bnR, "RGOE_REGISTRAR_PORT") === "8878" && unitEnv(bnR, "RGOE_PAY_ASSET") === REG.RGOE_PAY_ASSET && unitEnv(bnR, "RGOE_PAY_PRICES") === REG.RGOE_PAY_PRICES && unitEnv(bnR, "RGOE_PAY_CHAIN_ID") === "11155111", "bootnode unit advertises the offer (RGOE_REGISTRAR_ADVERTISE=1 + port/asset/prices/chain)");
    ok(unitEnv(bnR, "RGOE_PAY_PROTOCOLS") === "x402,mpp" && unitEnv(ru, "RGOE_PAY_PROTOCOLS") === "x402,mpp", "default rails x402,mpp rendered into the bootnode advert + the registrar unit (RGOE_PAY_PROTOCOLS, T-FEAT-9)");
    const stripBn = (u) => u.split("\n").filter((l) => !/^Environment=RGOE_(REGISTRAR_ADVERTISE|REGISTRAR_PORT|PAY_ASSET|PAY_PRICES|PAY_CHAIN_ID|PAY_PROTOCOLS)=/.test(l)).join("\n");
    ok(stripBn(bnR) === got.get("etc/systemd/system/rgoe-bootnode.service"), "bootnode unit otherwise byte-identical to the default");
    // T-FEAT-9: the gateway unit admits invited,paid (+ the paid set + RPC it needs); the heartbeat
    // advertises the SAME policy + the offer as signed caps (RGOE_REGISTRAR_ADVERTISE + RGOE_PAY_* + onion).
    const gwR = regFiles.get("etc/systemd/system/rgoe-gateway.service"), hbR = regFiles.get("etc/systemd/system/rgoe-heartbeat.service");
    ok(unitEnv(gwR, "RGOE_ADMIT") === "invited,paid" && unitEnv(gwR, "RGOE_PAID_ACCESS_CONTRACT") === REG.RGOE_PAID_ACCESS_CONTRACT && unitEnv(gwR, "RGOE_RPC_URL") === REG.RGOE_RPC_URL && unitEnv(gwR, "RGOE_GROUP_CONTRACT") === null, "gateway unit: RGOE_ADMIT=invited,paid + RGOE_PAID_ACCESS_CONTRACT + RGOE_RPC_URL (no staked contract)");
    ok(unitEnv(hbR, "RGOE_ADMIT") === "invited,paid" && unitEnv(hbR, "RGOE_REGISTRAR_ADVERTISE") === "1" && unitEnv(hbR, "RGOE_REGISTRAR_ONION") === unitEnv(ru, "RGOE_REGISTRAR_ONION") && unitEnv(hbR, "RGOE_PAY_ASSET") === REG.RGOE_PAY_ASSET && unitEnv(hbR, "RGOE_PAY_PRICES") === REG.RGOE_PAY_PRICES && unitEnv(hbR, "RGOE_PAY_PROTOCOLS") === "x402,mpp" && unitEnv(hbR, "RGOE_PAY_CHAIN_ID") === "11155111" && unitEnv(hbR, "RGOE_REGISTRAR_PORT") === "8878", "heartbeat unit: same RGOE_ADMIT + the pay advert env (advertised as signed caps.pay; registrar onion = the bootnode's)");
    const stripAdm = (u) => u.split("\n").filter((l) => !/^Environment=RGOE_(PAID_ACCESS_CONTRACT|RPC_URL|REGISTRAR_ADVERTISE|REGISTRAR_PORT|REGISTRAR_ONION|PAY_ASSET|PAY_PRICES|PAY_CHAIN_ID|PAY_PROTOCOLS)=/.test(l)).join("\n").replace("Environment=RGOE_ADMIT=invited,paid", "Environment=RGOE_ADMIT=invited");
    for (const f of ["etc/systemd/system/rgoe-gateway.service", "etc/systemd/system/rgoe-heartbeat.service"]) ok(stripAdm(regFiles.get(f)) === got.get(f), `registrar=1 leaves ${f} otherwise byte-identical`);
    const regPT = render(work, "registrar-payto", { ...REG, RGOE_PAY_TO: "0x2222222222222222222222222222222222222222", RGOE_REGISTRAR_PORT: "9878", RGOE_PAY_CHAIN_ID: "1" });
    const ruPT = await readFile(join(regPT.out, "etc/systemd/system/rgoe-registrar.service"), "utf8");
    ok(regPT.status === 0 && unitEnv(ruPT, "RGOE_PAY_TO") === "0x2222222222222222222222222222222222222222" && unitEnv(ruPT, "RGOE_REGISTRAR_PORT") === "9878" && hsBlocks(await readFile(join(regPT.out, "etc/tor/torrc.d-rgoe"), "utf8"))[0].lines[1] === "HiddenServicePort 9878 127.0.0.1:9878" && unitEnv(await readFile(join(regPT.out, "etc/systemd/system/rgoe-bootnode.service"), "utf8"), "RGOE_PAY_CHAIN_ID") === "1", "RGOE_PAY_TO / RGOE_REGISTRAR_PORT / RGOE_PAY_CHAIN_ID passthrough (unit + torrc + advert)");
    const rgBad = [
      [{ ...REG, RGOE_PAID_ACCESS_CONTRACT: "" }, /needs RGOE_PAID_ACCESS_CONTRACT/],
      [{ ...REG, RGOE_PAY_ASSET: "usdc" }, /needs RGOE_PAY_ASSET/],
      [{ ...REG, RGOE_PAY_PRICES: "8=free" }, /needs RGOE_PAY_PRICES/],
      [{ ...REG, RGOE_PAY_PRICES: "" }, /needs RGOE_PAY_PRICES/],
      [{ ...REG, RGOE_RPC_URL: "" }, /needs RGOE_RPC_URL/],
      [{ ...REG, RGOE_PAY_TO: "0x12" }, /RGOE_PAY_TO must be/],
      [{ ...REG, RGOE_REGISTRAR_PORT: "80" }, /RGOE_REGISTRAR_PORT must be/],
      [{ ...REG, RGOE_PAY_CHAIN_ID: "sepolia" }, /RGOE_PAY_CHAIN_ID must be/],
      [{ ...REG, RGOE_ADMIT: "invited" }, /RGOE_REGISTRAR=1 sells paid leaves but RGOE_ADMIT=invited does not admit them/],
      [{ ...REG, RGOE_PAY_PROTOCOLS: "lightning" }, /RGOE_PAY_PROTOCOLS must be/],
      [{ ...REG, RGOE_PAY_PROTOCOLS: "x402,,mpp" }, /RGOE_PAY_PROTOCOLS must be/],
      [{ RGOE_REGISTRAR: "maybe" }, /RGOE_REGISTRAR must be 1 or 0/],
    ];
    for (const [env, re] of rgBad) {
      const r = render(work, "registrar-bad", env);
      ok(r.status !== 0 && re.test(r.stderr), `rejected up front: ${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k, v]) => REG[k] !== v)))}`);
    }
    for (const off of ["0", "false", "off"]) {
      const r = render(work, `registrar-${off}`, { RGOE_REGISTRAR: off });
      const files = await readAll(r.out);
      ok(r.status === 0 && files.size === got.size && [...got].every(([f, b]) => files.get(f) === b), `RGOE_REGISTRAR=${off} == default (opt-in; golden untouched)`);
    }
    const regHel = render(work, "registrar-helios", { ...REG, ...HEL, RGOE_ADMIT: "invited,staked,paid" });
    ok(regHel.status === 0 && (await readAll(regHel.out)).size === 6, "composes with RGOE_HELIOS=1 (6 files; RGOE_ADMIT=invited,staked,paid admits both what helios anchors and what the registrar sells)");
    const regHelNoPaid = render(work, "registrar-helios-nopaid", { ...REG, ...HEL });
    ok(regHelNoPaid.status !== 0 && /RGOE_REGISTRAR=1 sells paid leaves but RGOE_ADMIT=invited,staked does not admit them/.test(regHelNoPaid.stderr), "…and RGOE_HELIOS=1's invited,staked WITHOUT paid is refused when the registrar sells");

    // ---------------------------------------------------------------- 8. from-block passthrough
    console.log("RGOE_FROM_BLOCK / RGOE_FROM_BLOCKS (eth_getLogs start blocks):");
    const FB = { RGOE_FROM_BLOCK: "0xafa5ad", RGOE_FROM_BLOCKS: "0xFe48De8b9aCA4386DC31C845d579ae62f04f9d25=11510541,0x4e8C2Bf5d3c5454A04837401095fce2646484111=0xafa6b9" };
    const fb = render(work, "fromblock", FB);
    ok(fb.status === 0, "renders with both set");
    const fbFiles = await readAll(fb.out);
    const gwFb = fbFiles.get("etc/systemd/system/rgoe-gateway.service");
    ok(unitEnv(gwFb, "RGOE_FROM_BLOCK") === FB.RGOE_FROM_BLOCK && unitEnv(gwFb, "RGOE_FROM_BLOCKS") === FB.RGOE_FROM_BLOCKS, "gateway unit carries RGOE_FROM_BLOCK + RGOE_FROM_BLOCKS verbatim");
    const stripFb = (u) => u.split("\n").filter((l) => !/^Environment=RGOE_FROM_BLOCKS?=/.test(l)).join("\n");
    ok(stripFb(gwFb) === got.get("etc/systemd/system/rgoe-gateway.service"), "gateway unit otherwise byte-identical to the default");
    for (const f of ["etc/tor/torrc.d-rgoe", "etc/systemd/system/rgoe-bootnode.service", "etc/systemd/system/rgoe-heartbeat.service"]) ok(fbFiles.get(f) === got.get(f), `from-block leaves ${f} byte-identical`);
    const fbOne = render(work, "fromblock-one", { RGOE_FROM_BLOCK: "11510541" });
    const gwOne = await readFile(join(fbOne.out, "etc/systemd/system/rgoe-gateway.service"), "utf8");
    ok(fbOne.status === 0 && unitEnv(gwOne, "RGOE_FROM_BLOCK") === "11510541" && unitEnv(gwOne, "RGOE_FROM_BLOCKS") === null, "decimal RGOE_FROM_BLOCK alone -> one line, no RGOE_FROM_BLOCKS");
    const fbHel = render(work, "fromblock-helios", { ...HEL, RGOE_FROM_BLOCK: "0xafa5ad" });
    const gwHelFb = await readFile(join(fbHel.out, "etc/systemd/system/rgoe-gateway.service"), "utf8");
    ok(fbHel.status === 0 && unitEnv(gwHelFb, "RGOE_FROM_BLOCK") === "0xafa5ad" && unitEnv(gwHelFb, "RGOE_ROOT_PROVIDER") === "light", "composes with RGOE_HELIOS=1 (light provider + start block)");
    for (const [env, re] of [
      [{ RGOE_FROM_BLOCK: "latest" }, /RGOE_FROM_BLOCK must be a block number/],
      [{ RGOE_FROM_BLOCK: "0x" }, /RGOE_FROM_BLOCK must be a block number/],
      [{ RGOE_FROM_BLOCK: "12; rm -rf /" }, /RGOE_FROM_BLOCK must be a block number/],
      [{ RGOE_FROM_BLOCKS: "0x1234=5" }, /RGOE_FROM_BLOCKS must be/],
      [{ RGOE_FROM_BLOCKS: "0x" + "ab".repeat(20) + "=" }, /RGOE_FROM_BLOCKS must be/],
      [{ RGOE_FROM_BLOCKS: "0x" + "ab".repeat(20) + "=5,junk" }, /RGOE_FROM_BLOCKS must be/],
      [{ RGOE_FROM_BLOCKS: "0x" + "ab".repeat(20) + "=5 " }, /RGOE_FROM_BLOCKS must be/],
    ]) {
      const r = render(work, "fromblock-bad", env);
      ok(r.status !== 0 && re.test(r.stderr), `rejected up front: ${JSON.stringify(env)}`);
    }
    for (const env of [{ RGOE_FROM_BLOCK: "" }, { RGOE_FROM_BLOCKS: "" }]) {
      const r = render(work, "fromblock-unset", env);
      const files = await readAll(r.out);
      ok(r.status === 0 && files.size === got.size && [...got].every(([f, b]) => files.get(f) === b), `${Object.keys(env)[0]} empty == default (golden untouched)`);
    }

    // ---------------------------------------------------------------- 9. admission policy + rails (T-FEAT-9)
    console.log("RGOE_ADMIT / RGOE_PAY_PROTOCOLS / registrar on a gateway-only box (T-FEAT-9):");
    // default = invited: both units carry Environment=RGOE_ADMIT=invited (this IS the golden now)
    ok(unitEnv(got.get("etc/systemd/system/rgoe-gateway.service"), "RGOE_ADMIT") === "invited" && unitEnv(got.get("etc/systemd/system/rgoe-heartbeat.service"), "RGOE_ADMIT") === "invited", "default render: gateway + heartbeat units carry RGOE_ADMIT=invited (max-anon default; golden regenerated for T-FEAT-9)");
    ok(!/RGOE_(GROUP_CONTRACT|PAID_ACCESS_CONTRACT|RPC_URL)=/.test(got.get("etc/systemd/system/rgoe-gateway.service")), "default gateway unit carries no contract / RPC (invited needs none)");
    for (const spelling of ["invited", "INVITED", " invited ", ""]) {
      const r = render(work, "admit-inv", { RGOE_ADMIT: spelling });
      const files = await readAll(r.out);
      ok(r.status === 0 && files.size === got.size && [...got].every(([f, b]) => files.get(f) === b), `RGOE_ADMIT=${JSON.stringify(spelling)} == default (case/space tolerant; empty = the default)`);
    }
    const STK = { RGOE_ADMIT: "paid,staked,invited", RGOE_GROUP_CONTRACT: "0xdAE242AE3eCD18e5F74d5e96332fCD4682EB20FC", RGOE_PAID_ACCESS_CONTRACT: "0x1111111111111111111111111111111111111111", RGOE_RPC_URL: "https://rpc.example/v1/KEY" };
    const stk = render(work, "admit-all", STK);
    const stkFiles = await readAll(stk.out);
    const gwS = stkFiles.get("etc/systemd/system/rgoe-gateway.service"), hbS = stkFiles.get("etc/systemd/system/rgoe-heartbeat.service");
    ok(stk.status === 0 && /admit=invited,staked,paid/.test(stk.stdout) && unitEnv(gwS, "RGOE_ADMIT") === "invited,staked,paid" && unitEnv(hbS, "RGOE_ADMIT") === "invited,staked,paid", "RGOE_ADMIT=paid,staked,invited -> normalized to the canonical anonymity order invited,staked,paid in both units");
    ok(unitEnv(gwS, "RGOE_GROUP_CONTRACT") === STK.RGOE_GROUP_CONTRACT && unitEnv(gwS, "RGOE_PAID_ACCESS_CONTRACT") === STK.RGOE_PAID_ACCESS_CONTRACT && unitEnv(gwS, "RGOE_RPC_URL") === STK.RGOE_RPC_URL && unitEnv(gwS, "RGOE_ROOT_PROVIDER") === null, "gateway unit carries the staked + paid contracts + RPC (node provider; helios off)");
    ok(!/RGOE_(GROUP_CONTRACT|PAID_ACCESS_CONTRACT|RPC_URL)=/.test(hbS), "heartbeat unit carries the policy only (no contracts)");
    const stripAll = (u) => u.split("\n").filter((l) => !/^Environment=RGOE_(GROUP_CONTRACT|PAID_ACCESS_CONTRACT|RPC_URL)=/.test(l)).join("\n").replace("Environment=RGOE_ADMIT=invited,staked,paid", "Environment=RGOE_ADMIT=invited");
    ok(stripAll(gwS) === got.get("etc/systemd/system/rgoe-gateway.service") && stripAll(hbS) === got.get("etc/systemd/system/rgoe-heartbeat.service"), "…otherwise byte-identical to the default units");
    ok(stkFiles.get("etc/tor/torrc.d-rgoe") === torrc && stkFiles.get("etc/systemd/system/rgoe-bootnode.service") === got.get("etc/systemd/system/rgoe-bootnode.service"), "policy does not touch torrc / bootnode unit");
    const stkOnly = render(work, "admit-staked", { RGOE_ADMIT: "staked", RGOE_GROUP_CONTRACT: STK.RGOE_GROUP_CONTRACT, RGOE_RPC_URL: STK.RGOE_RPC_URL });
    const gwSO = await readFile(join(stkOnly.out, "etc/systemd/system/rgoe-gateway.service"), "utf8");
    ok(stkOnly.status === 0 && unitEnv(gwSO, "RGOE_ADMIT") === "staked" && unitEnv(gwSO, "RGOE_GROUP_CONTRACT") === STK.RGOE_GROUP_CONTRACT && unitEnv(gwSO, "RGOE_PAID_ACCESS_CONTRACT") === null, "RGOE_ADMIT=staked alone: staked contract only, no members.json needed, no paid");
    for (const [env, re] of [
      [{ RGOE_ADMIT: "onchain" }, /RGOE_ADMIT must be a comma list drawn from invited, staked, paid/],
      [{ RGOE_ADMIT: "static,onchain" }, /RGOE_ADMIT must be/],
      [{ RGOE_ADMIT: "invited,,paid" }, /RGOE_ADMIT must be/],
      [{ RGOE_ADMIT: "invited,staked" }, /RGOE_ADMIT names staked: needs RGOE_GROUP_CONTRACT/],
      [{ RGOE_ADMIT: "invited,staked", RGOE_GROUP_CONTRACT: "0x12" }, /RGOE_ADMIT names staked: needs RGOE_GROUP_CONTRACT/],
      [{ RGOE_ADMIT: "invited,paid" }, /RGOE_ADMIT names paid: needs RGOE_PAID_ACCESS_CONTRACT/],
      [{ RGOE_ADMIT: "invited,staked", RGOE_GROUP_CONTRACT: STK.RGOE_GROUP_CONTRACT }, /RGOE_ADMIT names invited,staked: needs RGOE_RPC_URL/],
      [{ RGOE_ADMIT: "paid", RGOE_PAID_ACCESS_CONTRACT: STK.RGOE_PAID_ACCESS_CONTRACT, RGOE_RPC_URL: "ftp://x" }, /needs RGOE_RPC_URL/],
    ]) {
      const r = render(work, "admit-bad", env);
      ok(r.status !== 0 && re.test(r.stderr), `rejected up front (fail closed): ${JSON.stringify(env)}`);
    }
    // rails subset -> registrar unit + bootnode advert + heartbeat advert all carry it, normalized
    const mppOnly = render(work, "pay-mpp", { ...REG, RGOE_PAY_PROTOCOLS: "MPP" });
    const mppFiles = await readAll(mppOnly.out);
    ok(mppOnly.status === 0 && /pay=mpp/.test(mppOnly.stdout) && ["rgoe-registrar", "rgoe-bootnode", "rgoe-heartbeat"].every((u) => unitEnv(mppFiles.get(`etc/systemd/system/${u}.service`), "RGOE_PAY_PROTOCOLS") === "mpp"), "RGOE_PAY_PROTOCOLS=MPP -> `mpp` in the registrar unit, the bootnode advert and the heartbeat advert");
    const both = render(work, "pay-both", { ...REG, RGOE_PAY_PROTOCOLS: "mpp,x402" });
    ok(both.status === 0 && unitEnv(await readFile(join(both.out, "etc/systemd/system/rgoe-registrar.service"), "utf8"), "RGOE_PAY_PROTOCOLS") === "x402,mpp", "RGOE_PAY_PROTOCOLS=mpp,x402 -> canonical order x402,mpp");
    // registrar on a GATEWAY-ONLY box: rides the gateway onion; heartbeat advertises it; no bootnode unit
    const gwReg = render(work, "registrar-gw-only", { ...REG, RGOE_BOOTNODE_ONION: ONION });
    const gwRegFiles = await readAll(gwReg.out);
    ok(gwReg.status === 0 && [...gwRegFiles.keys()].join(",") === "etc/systemd/system/rgoe-gateway.service,etc/systemd/system/rgoe-heartbeat.service,etc/systemd/system/rgoe-registrar.service,etc/tor/torrc.d-rgoe", `gateway-only + registrar renders gateway + heartbeat + registrar units, no bootnode (${[...gwRegFiles.keys()].join(", ")})`);
    const gwRegT = hsBlocks(gwRegFiles.get("etc/tor/torrc.d-rgoe"));
    ok(gwRegT.length === 1 && gwRegT[0].dir === "/var/lib/tor/rgoe-gateway" && gwRegT[0].lines.join("|") === "HiddenServicePort 80 127.0.0.1:8443|HiddenServicePort 8878 127.0.0.1:8878|HiddenServicePoWDefensesEnabled 0", "torrc: ONE HS block (gateway) with port 80 + EXTRA port 8878 (the registrar rides the GATEWAY onion), then the PoW line");
    const ruG = gwRegFiles.get("etc/systemd/system/rgoe-registrar.service"), hbG = gwRegFiles.get("etc/systemd/system/rgoe-heartbeat.service");
    ok(unitEnv(ruG, "RGOE_REGISTRAR_ONION") === "gatewayplaceholderplaceholderplaceholderplaceholderplace.onion" && unitEnv(hbG, "RGOE_REGISTRAR_ONION") === "gatewayplaceholderplaceholderplaceholderplaceholderplace.onion" && unitEnv(hbG, "RGOE_REGISTRAR_ADVERTISE") === "1" && unitEnv(hbG, "RGOE_BOOTNODE_ONION") === ONION + ".onion", "registrar + heartbeat name the GATEWAY onion as the registrar onion; heartbeat still announces to the remote bootnode");
    ok(unitEnv(gwRegFiles.get("etc/systemd/system/rgoe-gateway.service"), "RGOE_ADMIT") === "invited,paid", "gateway-only gateway unit admits invited,paid");

    // ---------------------------------------------------------------- 5. other guards
    console.log("guards:");
    const adm = render(work, "adm-bad", { RGOE_ADMISSION: "vip" });
    ok(adm.status !== 0 && /RGOE_ADMISSION must be open or stake/.test(adm.stderr), "RGOE_ADMISSION=vip rejected");
    const admStake = render(work, "adm-stake", { RGOE_ADMISSION: "stake" });
    ok(admStake.status === 0 && unitEnv(await readFile(join(admStake.out, "etc/systemd/system/rgoe-bootnode.service"), "utf8"), "RGOE_BOOTNODE_ADMISSION") === "stake", "RGOE_ADMISSION=stake lands in the bootnode unit");
    const only = await listFiles(work);
    ok(only.every((f) => f.startsWith("etc/") || /^[^/]+\/etc\//.test(f)), "render mode writes only under <dir>/etc/ (no stray files)");
    ok(!/apt-get|systemctl|useradd/.test(def.stdout + def.stderr + gw.stdout + gw.stderr), "render mode never mentions apt/systemctl/useradd (nothing executed on the host)");
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(failures ? `\nbootstrap render selftest: ${failures} FAILED` : "\nbootstrap render selftest: all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
