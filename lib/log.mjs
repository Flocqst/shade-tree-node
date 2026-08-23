// lib/log.mjs — T-MON-1: a tiny, zero-dependency leveled logger.
//
// Two behaviors, both env-controlled and both decided at CALL time — importing this
// module installs NOTHING (no port, no timer, no side effect); it is pure functions
// plus a per-call read of the environment:
//
//   SHADE_TREE_LOG_FORMAT = text | json          (default: text — today's human-readable lines)
//   SHADE_TREE_LOG_LEVEL  = debug|info|warn|error (default: info)
//
// text mode: `<msg> key=value key=value` — a concise line that ~matches the pre-T-MON-1
//   console.log style (no timestamp/level prefix), so operator greps on existing
//   substrings (e.g. "gateway up on", "SLASH tx 0x…", "SLASH mined block 42") keep matching.
// json mode: exactly one JSON object per line: { ts, level, msg, ...fields }.
//
// Levels map to console sinks: debug/info -> console.log (stdout), warn -> console.warn,
// error -> console.error (stderr) — the conventional split; a human terminal looks the same.
//
// SECURITY — this logger is a PURE PASSTHROUGH. It NEVER redacts. Redaction is the
// caller's job. Do NOT hand it secrets: no member identitySecret, no reconstructed RLN
// secret, no private key bytes, no envelope share witnesses. Log the PUBLIC value only —
// the commitment leaf, the nullifier, the onion address — never the witness that produced
// it. (The callers in gateway/gateway.mjs and bootnode/server.mjs already log public
// values only; keep it that way when adding fields.)

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Read env fresh on every call so a process (or a test) can flip format/level at runtime
// without a re-import. Both reads are trivial string compares on a cold logging path.
function threshold() {
  return LEVELS[String(process.env.SHADE_TREE_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
}
function jsonMode() {
  return String(process.env.SHADE_TREE_LOG_FORMAT || "text").toLowerCase() === "json";
}

// Circular- and BigInt-safe JSON.stringify. JSON.stringify throws on a BigInt and on a
// circular reference; a logger must NEVER throw, so we guard both (plus functions/symbols)
// and fall back to a diagnostic object if anything else goes wrong.
function safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, function (_key, value) {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (typeof value === "symbol") return value.toString();
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    try { return JSON.stringify({ logError: "unserializable-fields: " + (e && e.message) }); }
    catch { return '{"logError":"unserializable-fields"}'; }
  }
}

// Render one `key=value` token for text mode. Objects/arrays are rendered as compact
// (circular-safe) JSON; scalars are stringified; a value carrying whitespace or a quote
// (or the empty string) is JSON-quoted so the token stays a single unambiguous field.
function textField(key, value) {
  if (value !== null && typeof value === "object") return `${key}=${safeStringify(value)}`;
  let s = value === null || value === undefined ? String(value)
    : typeof value === "bigint" ? value.toString()
    : String(value);
  if (s === "" || /[\s"]/.test(s)) s = JSON.stringify(s);
  return `${key}=${s}`;
}

function textLine(msg, fields) {
  const parts = [String(msg)];
  if (fields && typeof fields === "object") {
    for (const key of Object.keys(fields)) parts.push(textField(key, fields[key]));
  }
  return parts.join(" ");
}

function sink(level) {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  return console.log; // debug + info
}

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold()) return; // below the configured level: dropped
  const line = jsonMode()
    ? safeStringify({ ts: new Date().toISOString(), level, msg: String(msg), ...(fields && typeof fields === "object" ? fields : {}) })
    : textLine(msg, fields);
  sink(level)(line);
}

// The public API: log.info(msg, fields?), .warn, .error, .debug. `fields` is optional and,
// when present, must be a plain object of PUBLIC values (see SECURITY note above).
export const log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};

export default log;
