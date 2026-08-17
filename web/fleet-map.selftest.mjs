// Selftest for the privacy-preserving fleet map (web/fleet-map.mjs).
//
// It pins the two guarantees that make the map safe to publish:
//   1. SMALL-BUCKET FOLD (k-anonymity). A region/ASN declared by fewer than k gateways is NEVER
//      shown under its own name -- not in the bucket output and not in the rendered HTML. It folds
//      into the unnamed "other" bucket. Raising k folds more. This is the invariant that stops the
//      map from revealing "the only gateway in region X is ...".
//   2. SELF-CONTAINED / AGGREGATE-ONLY. The rendered HTML pulls no external resource (no http(s)://,
//      no //cdn, no <script>/<link>/<img>/src=/url()/@import) so it renders from file:// offline,
//      and it leaks NO onion or pubkey -- output is per-bucket counts only.
//
//   node web/fleet-map.selftest.mjs
//
// Exit 0 = every check held; nonzero = a check failed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coarseLabel, bucketBy, bucketFleet, renderFleetMapHTML, DEFAULT_K } from "./fleet-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { console.log(`  FAIL ${msg}`); failures++; } };

// A directory with one deliberately LONE region ("loneland": 1 gateway) that must fold, and a fat
// region ("bigland": 3) that must survive. Same idea for ASNs. Full onions are here so we can
// assert they never leak into the aggregate output.
const LONE_ONION = "lonegatewayonionaddressthatmustnotappearanywhereinoutput";
function fixture() {
  return {
    version: 1,
    gateways: [
      { onion: "big0" + "a".repeat(50), pubkey: "b0", weight: 100, health: "up", region: "bigland", asn: "AS100" },
      { onion: "big1" + "b".repeat(50), pubkey: "b1", weight: 100, health: "up", region: "bigland", asn: "AS100" },
      { onion: "big2" + "c".repeat(50), pubkey: "b2", weight: 90, health: "up", region: "bigland", asn: "AS200" },
      { onion: LONE_ONION, pubkey: "L0", weight: 50, health: "up", region: "loneland", asn: "AS999" },
    ],
  };
}

function main() {
  // === 1. small-bucket fold at the default k =====================================================
  console.log("small-bucket fold (k = " + DEFAULT_K + "):");
  const dir = fixture();
  const rb = bucketBy(dir.gateways, "region", DEFAULT_K);

  const named = rb.shown.map((b) => b.label);
  ok(named.includes("bigland"), "a region with >= k gateways is shown under its own name (bigland)");
  ok(!named.includes("loneland"), "a region with < k gateways is NOT shown under its own name (loneland folded)");
  ok(rb.shown.every((b) => b.count >= DEFAULT_K), "every named bucket has count >= k");
  ok(rb.folded && rb.folded.count === 1, "the lone gateway landed in the unnamed 'other' fold (count 1)");
  ok(rb.folded && rb.folded.mergedLabels === 1, "fold reports 1 merged label and drops its NAME");
  ok(!JSON.stringify(rb).includes("loneland"), "the folded region's NAME appears nowhere in the bucket output");

  // ASN side: AS999 (1 gateway) folds, AS100 (2) survives, AS200 (1) folds.
  const ab = bucketBy(dir.gateways, "asn", DEFAULT_K);
  const asnNamed = ab.shown.map((b) => b.label);
  ok(asnNamed.includes("as100"), "an ASN with >= k gateways is named (as100)");
  ok(!asnNamed.includes("as999") && !asnNamed.includes("as200"), "ASNs with < k gateways fold (as999, as200)");

  // === 2. fold threshold scales: raise k, more folds =============================================
  console.log("\nraising k folds more:");
  const rb4 = bucketBy(dir.gateways, "region", 4);
  ok(rb4.shown.length === 0, "at k=4 even bigland (3) folds -> no named regions");
  ok(rb4.folded && rb4.folded.count === 4, "at k=4 all 4 gateways are in the unnamed fold");

  // === 3. rendered HTML: fold invariant survives into the page ==================================
  console.log("\nrendered HTML honors the fold + aggregate-only:");
  const html = renderFleetMapHTML(dir, { k: DEFAULT_K, now: new Date("2026-08-14T00:00:00Z") });
  ok(html.includes("bigland"), "HTML names the fat region (bigland)");
  ok(!html.includes("loneland"), "HTML never names the lone region (loneland)");
  ok(!html.includes(LONE_ONION), "HTML leaks NO full onion address");
  ok(!html.includes("pubkey") && !/\bb0\b|\bL0\b/.test(html), "HTML carries no pubkey / per-gateway identity");
  ok(html.includes(">other<") || html.includes("other"), "HTML shows the unnamed 'other' fold bar");

  // === 4. self-contained: no external resource of any kind ======================================
  console.log("\nself-contained (renders from file://, no network):");
  const externalUrl = /https?:\/\//i;
  const protoRel = /(?:src|href)\s*=\s*["']\/\//i;
  ok(!externalUrl.test(html), "no http(s):// URL anywhere in the page");
  ok(!protoRel.test(html), "no protocol-relative //host resource");
  ok(!/<script\b/i.test(html), "no <script> tag (static page)");
  ok(!/<link\b/i.test(html), "no <link> (no external stylesheet/font)");
  ok(!/<img\b/i.test(html), "no <img> (no external image / map tile)");
  ok(!/url\(\s*['"]?https?:/i.test(html) && !/@import/i.test(html), "no CSS url(http...) / @import");

  // === 5. the shipped sample dataset is coherent + folds as designed ============================
  console.log("\nbundled sample dataset:");
  const sample = JSON.parse(readFileSync(join(HERE, "fleet-map.sample.json"), "utf8"));
  const agg = bucketFleet(sample, { k: DEFAULT_K });
  ok(agg.total === sample.gateways.length, `sample total matches gateway count (${agg.total})`);
  ok(agg.regions.shown.every((b) => b.count >= DEFAULT_K), "sample: every named region has count >= k");
  ok(agg.asns.shown.every((b) => b.count >= DEFAULT_K), "sample: every named ASN has count >= k");
  ok(agg.regions.folded && agg.regions.folded.count > 0, "sample: some thin regions fold into 'other'");
  ok(agg.asns.folded && agg.asns.folded.count > 0, "sample: some thin ASNs fold into 'other'");
  const sampleHtml = renderFleetMapHTML(sample, { k: DEFAULT_K });
  ok(!sample.gateways.some((g) => sampleHtml.includes(g.onion)), "sample render leaks no full onion");

  // === 6. coarseLabel normalization =============================================================
  console.log("\ncoarse label normalization:");
  ok(coarseLabel("EU-West") === "eu-west", "labels are lowercased/slugged");
  ok(coarseLabel("") === "undeclared" && coarseLabel(null) === "undeclared" && coarseLabel(undefined) === "undeclared",
    "empty/missing label -> 'undeclared' aggregate");
  ok(coarseLabel("x".repeat(200)).length <= 24, "labels are length-capped");
  ok(!/[<>"'&]/.test(coarseLabel("<script>evil</script>")), "markup is stripped from labels");

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: web fleet-map selftest (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
