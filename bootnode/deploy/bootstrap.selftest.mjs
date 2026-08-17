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
