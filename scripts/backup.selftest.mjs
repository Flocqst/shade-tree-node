// Selftest for the encrypted key backup/restore tool (scripts/backup.mjs).
//
// It exercises BOTH the pure exported functions (fast, deterministic — the encrypt/decrypt path
// with no disk) AND the on-disk drivers (runBackup/runRestore), proving the security properties an
// operator relies on:
//   - the outFile contains NO plaintext seed (the seed hex is absent from the encrypted envelope)
//   - restore with the RIGHT passphrase returns the files byte-identical, at 0600 perms
//   - restore with the WRONG passphrase FAILS (GCM auth error) and writes NOTHING
//   - restore refuses to overwrite an existing file unless --force
//   - only the sensitive files (by name) are collected; other files are ignored
//
//   node scripts/backup.selftest.mjs   (exit 0 = all invariants held)

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SENSITIVE_NAMES, collectSecrets, encrypt, decrypt, runBackup, runRestore,
} from "./backup.mjs";

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

const PASS = "correct horse battery staple";
const WRONG = "Tr0ubador&3";

// A fake gateway onion seed (32 bytes hex) and a fake Tor expanded secret key — distinctive byte
// patterns we can grep the ciphertext for.
const SEED_HEX = "deadbeef".repeat(8); // 64 hex chars = 32 bytes
const FAKE_HS_SECRET = Buffer.from("== ed25519v1-secret: type0 ==\0\0\0" + "A".repeat(64), "binary");

function makeSrc() {
  const src = mkdtempSync(join(tmpdir(), "rgoe-bk-src-"));
  const hsDir = join(src, "gateway-hs");
  mkdirSync(hsDir, { recursive: true });
  writeFileSync(join(hsDir, "identity.local.json"),
    JSON.stringify({ label: "gw", onion: "abc.onion", pub: "ff".repeat(32), seed: SEED_HEX }, null, 2) + "\n");
  writeFileSync(join(hsDir, "hs_ed25519_secret_key"), FAKE_HS_SECRET);
  writeFileSync(join(hsDir, "hostname"), "abc.onion\n");           // NOT sensitive — must be ignored
  writeFileSync(join(src, "bootnode-signer.key"),
    JSON.stringify({ pub: "11".repeat(32), priv: SEED_HEX }, null, 2) + "\n");
  writeFileSync(join(src, "README.txt"), "not a secret\n");         // NOT sensitive — must be ignored
  return src;
}

function main() {
  const src = makeSrc();
  const out = mkdtempSync(join(tmpdir(), "rgoe-bk-out-"));
  const dest = mkdtempSync(join(tmpdir(), "rgoe-bk-dest-"));
  const outFile = join(out, "keys.rgoebak");

  try {
    // --- collection: only the sensitive files, by name ---------------------
    console.log("collection:");
    const collected = collectSecrets(src).map((f) => f.relpath).sort();
    ok(collected.length === 3, "collects exactly the 3 sensitive files (ignores hostname, README)");
    ok(collected.includes("gateway-hs/identity.local.json"), "collects identity.local.json (with relpath)");
    ok(collected.includes("gateway-hs/hs_ed25519_secret_key"), "collects hs_ed25519_secret_key");
    ok(collected.includes("bootnode-signer.key"), "collects bootnode-signer.key");
    ok([...SENSITIVE_NAMES].length === 3, "SENSITIVE_NAMES lists the 3 secret basenames");

    // --- backup: encrypt to outFile, no plaintext on disk ------------------
    console.log("\nbackup (encrypt):");
    const b = runBackup({ srcDir: src, outFile, passphrase: PASS });
    ok(b.count === 3, "runBackup reports 3 files backed up");
    ok(existsSync(outFile), "outFile written");
    const envText = readFileSync(outFile, "utf8");
    ok(!envText.includes(SEED_HEX), "outFile contains NO plaintext seed hex (encrypted)");
    ok(!envText.includes("ed25519v1-secret"), "outFile contains NO plaintext Tor key tag");
    const env = JSON.parse(envText);
    ok(env.cipher === "aes-256-gcm" && env.kdf === "scrypt", "envelope declares aes-256-gcm + scrypt");
    ok(env.salt && env.iv && env.authTag && env.ciphertext, "envelope has salt, iv, authTag, ciphertext");

    // --- restore (right passphrase): byte-identical, 0600 ------------------
    console.log("\nrestore (right passphrase):");
    const r = runRestore({ inFile: outFile, destDir: dest, passphrase: PASS });
    ok(r.count === 3, "runRestore reports 3 files restored");
    const idOrig = readFileSync(join(src, "gateway-hs", "identity.local.json"));
    const idBack = readFileSync(join(dest, "gateway-hs", "identity.local.json"));
    ok(Buffer.compare(idOrig, idBack) === 0, "identity.local.json round-trips byte-identical");
    const hsOrig = readFileSync(join(src, "gateway-hs", "hs_ed25519_secret_key"));
    const hsBack = readFileSync(join(dest, "gateway-hs", "hs_ed25519_secret_key"));
    ok(Buffer.compare(hsOrig, hsBack) === 0, "hs_ed25519_secret_key round-trips byte-identical");
    const mode = statSync(join(dest, "gateway-hs", "hs_ed25519_secret_key")).mode & 0o777;
    ok(mode === 0o600, `restored secret has 0600 perms (got 0${mode.toString(8)})`);

    // --- restore (wrong passphrase): fails, writes nothing ----------------
    console.log("\nrestore (wrong passphrase):");
    const dest2 = mkdtempSync(join(tmpdir(), "rgoe-bk-dest2-"));
    let threw = false;
    try { runRestore({ inFile: outFile, destDir: dest2, passphrase: WRONG }); }
    catch (e) { threw = true; ok(/wrong passphrase|decryption failed/i.test(e.message), "wrong passphrase -> loud GCM/decryption error"); }
    ok(threw, "restore with the wrong passphrase throws");
    ok(!existsSync(join(dest2, "gateway-hs")), "wrong passphrase wrote NOTHING (no files on disk)");
    rmSync(dest2, { recursive: true, force: true });

    // --- pure decrypt tamper check ----------------------------------------
    console.log("\ntamper detection (pure):");
    const files = collectSecrets(src);
    const good = encrypt(files, PASS);
    let tamperThrew = false;
    const tampered = { ...good, ciphertext: Buffer.from(readFileSync(join(src, "README.txt"))).toString("base64") };
    try { decrypt(tampered, PASS); } catch { tamperThrew = true; }
    ok(tamperThrew, "tampered ciphertext fails the GCM auth tag");
    const rt = decrypt(good, PASS).map((f) => f.relpath).sort();
    ok(rt.length === 3, "pure encrypt->decrypt round-trips all 3 files");

    // --- overwrite guard ---------------------------------------------------
    console.log("\noverwrite guard:");
    let refuseThrew = false;
    try { runRestore({ inFile: outFile, destDir: dest, passphrase: PASS }); }
    catch (e) { refuseThrew = true; ok(/overwrite|--force/.test(e.message), "restore over existing files refuses without --force"); }
    ok(refuseThrew, "restore into a populated destDir throws without --force");
    const forced = runRestore({ inFile: outFile, destDir: dest, passphrase: PASS, force: true });
    ok(forced.count === 3, "restore --force overwrites (3 files)");
  } finally {
    for (const d of [src, out, dest]) rmSync(d, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: backup selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
