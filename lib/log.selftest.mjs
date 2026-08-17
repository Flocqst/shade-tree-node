// Self-test for the zero-dep leveled logger (T-MON-1).
//
//   node lib/log.selftest.mjs
//
// Asserts: text mode is the default (concise `msg key=value` lines, no timestamp/level
// prefix); json mode emits ONE parseable JSON object per line carrying ts/level/msg +
// the caller's fields; level filtering drops sub-threshold calls (debug suppressed at the
// default info level); scalar/bigint field serialization; level->console-sink routing
// (warn->console.warn, error->console.error); and that odd or CIRCULAR fields never crash
// the logger (JSON.stringify is guarded). Captures console output to make the assertions.

import { log } from "./log.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// Run `fn` with console.{log,warn,error} captured; return the captured lines per sink.
// Each sink receives exactly one string arg from the logger, but join() is defensive.
function capture(fn) {
  const logs = [], warns = [], errors = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  try { fn(); } finally { Object.assign(console, orig); }
  return { logs, warns, errors };
}

// Set env for the duration of `fn`, restoring the prior values (and unset-ness) after.
function withEnv(env, fn) {
  const keys = Object.keys(env);
  const prev = keys.map((k) => [k, Object.prototype.hasOwnProperty.call(process.env, k), process.env[k]]);
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const [k, had, v] of prev) { if (had) process.env[k] = v; else delete process.env[k]; }
  }
}

function main() {
  // === text mode is the default =============================================
  console.log("text mode (default):");
  {
    const { logs } = withEnv({ RGOE_LOG_FORMAT: undefined, RGOE_LOG_LEVEL: undefined }, () =>
      capture(() => log.info("egress", { target: "example.com:443", nullifier: "abc.." })));
    ok(logs.length === 1, "one line emitted");
    ok(logs[0] === "egress target=example.com:443 nullifier=abc..", "concise `msg key=value` line, no ts/level prefix");
    ok(!/"ts"|\{/.test(logs[0]), "text line is NOT json");
  }
  {
    // A bare message with no fields renders as just the message.
    const { logs } = withEnv({ RGOE_LOG_FORMAT: "text" }, () => capture(() => log.info("gateway up on 127.0.0.1:8443")));
    ok(logs[0] === "gateway up on 127.0.0.1:8443", "bare msg renders verbatim (grep substrings preserved)");
  }
  {
    // Values carrying whitespace/quotes are JSON-quoted so the field stays one token.
    const { logs } = withEnv({ RGOE_LOG_FORMAT: "text" }, () => capture(() => log.info("m", { a: "two words", b: "" })));
    ok(logs[0] === 'm a="two words" b=""', "odd/empty text values are quoted");
  }

  // === json mode: one parseable object per line =============================
  console.log("\njson mode:");
  {
    const before = Date.now();
    const { logs } = withEnv({ RGOE_LOG_FORMAT: "json" }, () =>
      capture(() => log.info("egress", { target: "example.com:443", n: 3, ok: true })));
    ok(logs.length === 1 && !logs[0].includes("\n"), "exactly one line, no embedded newline");
    let obj = null;
    try { obj = JSON.parse(logs[0]); } catch { /* obj stays null */ }
    ok(obj && typeof obj === "object", "line parses as JSON");
    ok(obj && obj.level === "info" && obj.msg === "egress", "carries level + msg");
    ok(obj && obj.target === "example.com:443" && obj.n === 3 && obj.ok === true, "caller fields present + typed");
    const ts = obj && Date.parse(obj.ts);
    ok(Number.isFinite(ts) && ts >= before - 1000, "ts is an ISO timestamp");
  }
  {
    // warn/error levels are labeled in json and go to their sinks (see below).
    const { warns } = withEnv({ RGOE_LOG_FORMAT: "json" }, () => capture(() => log.warn("drop", { reason: "bad-target" })));
    const obj = JSON.parse(warns[0]);
    ok(obj.level === "warn" && obj.msg === "drop" && obj.reason === "bad-target", "warn json shape");
  }

  // === level filtering ======================================================
  console.log("\nlevel filtering:");
  {
    const { logs } = withEnv({ RGOE_LOG_LEVEL: undefined }, () => capture(() => log.debug("noise", { x: 1 })));
    ok(logs.length === 0, "debug suppressed at default (info) level");
  }
  {
    const { logs } = withEnv({ RGOE_LOG_LEVEL: "debug" }, () => capture(() => log.debug("noise")));
    ok(logs.length === 1, "debug emitted when RGOE_LOG_LEVEL=debug");
  }
  {
    const { logs, warns, errors } = withEnv({ RGOE_LOG_LEVEL: "error" }, () =>
      capture(() => { log.info("i"); log.warn("w"); log.error("e"); }));
    ok(logs.length === 0 && warns.length === 0 && errors.length === 1, "level=error drops info+warn, keeps error");
  }

  // === sink routing =========================================================
  console.log("\nsink routing:");
  {
    const { logs, warns, errors } = withEnv({ RGOE_LOG_FORMAT: "text", RGOE_LOG_LEVEL: "debug" }, () =>
      capture(() => { log.info("i"); log.warn("w"); log.error("e"); log.debug("d"); }));
    ok(logs.length === 2 && logs.includes("i") && logs.includes("d"), "info+debug -> console.log");
    ok(warns.length === 1 && warns[0] === "w", "warn -> console.warn");
    ok(errors.length === 1 && errors[0] === "e", "error -> console.error");
  }

  // === field serialization: scalars + bigint ================================
  console.log("\nfield serialization:");
  {
    const { logs } = withEnv({ RGOE_LOG_FORMAT: "text" }, () =>
      capture(() => log.info("m", { big: 7n, num: 1.5, bool: false, nil: null })));
    ok(logs[0] === "m big=7 num=1.5 bool=false nil=null", "bigint/number/bool/null render in text");
  }
  {
    const { logs } = withEnv({ RGOE_LOG_FORMAT: "json" }, () => capture(() => log.info("m", { epoch: 7n })));
    const obj = JSON.parse(logs[0]);
    ok(obj.epoch === "7", "bigint serialized as string in json (JSON.stringify would otherwise throw)");
  }

  // === odd / circular fields never crash ====================================
  console.log("\ncircular + odd fields:");
  {
    const circ = { a: 1 }; circ.self = circ; // circular reference
    let threw = false, out = null;
    withEnv({ RGOE_LOG_FORMAT: "json" }, () => {
      const cap = capture(() => { try { log.info("circ", { circ, fn: () => {}, sym: Symbol("s"), undef: undefined }); } catch { threw = true; } });
      out = cap.logs[0];
    });
    ok(!threw, "circular/odd fields do not throw in json mode");
    let obj = null; try { obj = JSON.parse(out); } catch { /* stays null */ }
    ok(obj && obj.msg === "circ", "line still parses after circular guard");
    ok(obj && obj.circ && obj.circ.self === "[Circular]", "circular reference replaced with [Circular]");
  }
  {
    // Same in text mode: an object field is compact-JSON'd, circular-safe, no throw.
    const circ = {}; circ.me = circ;
    let threw = false; let logs;
    withEnv({ RGOE_LOG_FORMAT: "text" }, () => { logs = capture(() => { try { log.info("m", { o: circ }); } catch { threw = true; } }).logs; });
    ok(!threw && logs.length === 1 && logs[0].startsWith("m o="), "circular object safe in text mode too");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: log selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
