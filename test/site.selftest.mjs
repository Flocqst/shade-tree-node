// Static-site regression checks for the compact landing page, research note,
// signed public Grove, and privacy-preserving Three.js scenes.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grovePublicKeyRawBase64, verifyPublicGroveAttestation } from "../lib/public-grove.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs", "post");
const read = (path) => readFileSync(join(SITE, path), "utf8");
const checks = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`  ok   ${name}`);
}

function visibleWords(html) {
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ")
    .replace(/[·↗…]/g, " ");
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
}

const landing = read("index.html");
const landingCss = read("site.css");
const research = read("research/index.html");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const protocol = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8");
const loader = read("site.js");
const landingScene = read("grove.js");
const grovePage = read("grove/index.html");
const groveCss = read("grove/grove.css");
const groveLoader = read("grove/network.js");
const groveScene = read("grove/scene.js");
const groveApi = read("api/grove.mjs");
const groveApiContract = read("api/_grove-contract.mjs");
const pathGraphic = read("fig/shade-tree-path.svg");
const mobilePathGraphic = read("fig/shade-tree-path-mobile.svg");
const fallbackSnapshot = JSON.parse(read("grove/network.fallback.json"));
const grovePublicKey = readFileSync(join(ROOT, "network", "grove-signing-public.pem"), "utf8");
const config = JSON.parse(read("vercel.json"));
const csp = config.headers[0].headers.find((header) => header.key === "Content-Security-Policy")?.value || "";

check("landing is one-third-length copy", landing.length < 9_000 && visibleWords(landing) <= 105 && research.length > 40_000);
check("Grove is one-third-length copy", grovePage.length < 6_000 && visibleWords(grovePage) <= 65);
check("landing has one H1 and one decorative canvas", (landing.match(/<h1\b/g) || []).length === 1 && (landing.match(/<canvas[^>]+aria-hidden="true"/g) || []).length === 1);
check("Grove has one H1, one main section, and one live status", (grovePage.match(/<h1\b/g) || []).length === 1 && (grovePage.match(/<main\b/g) || []).length === 1 && (grovePage.match(/<main[\s\S]*?<section\b/g) || []).length === 1 && /role="status" aria-live="polite"/.test(grovePage));

for (const [name, page] of [["landing", landing], ["Grove", grovePage]]) {
  check(`${name} has no eyebrow, tiny semantic text, or em dash`, !/eyebrow|preview-label|preview-note|<small\b|<sup\b|<sub\b|<figcaption\b|\u2014/.test(page));
}

check("both sites use the same nocturnal palette", /--understory:\s*#070c09/.test(landingCss) && /--wet-bark:\s*#111913/.test(landingCss) && /--pulse:\s*#d1b66e/.test(landingCss) && !/#f3f0e7|--paper\b/.test(landingCss) && /background:\s*var\(--understory\)/.test(groveCss));
check("tree imagery remains behind every surface", /body::before/.test(landingCss) && /shade-tree-banner\.webp/.test(landingCss) && /forest-fallback/.test(landing) && /canopy-fallback/.test(grovePage));

check("landing and README state the Proxy and Node story", /Run the proxy beside an agent/.test(landing) && /Run a node to provide cover/.test(landing) && /Run the proxy beside an agent/.test(readme) && /Run a Shade Tree node to provide cover/.test(readme));
check("landing exposes both direct actions", /href="#proxy">Run the proxy/.test(landing) && /href="#node">Run a node/.test(landing));
check("landing and README embed responsive two-plane path graphics", /<picture>[\s\S]*?media="\(max-width: 560px\)"[\s\S]*?srcset="\/fig\/shade-tree-path-mobile\.svg"[^>]+width="720" height="1710"[\s\S]*?<img src="\/fig\/shade-tree-path\.svg"/.test(landing) && /<picture>[\s\S]*?srcset="docs\/post\/fig\/shade-tree-path-mobile\.svg"[\s\S]*?<img src="docs\/post\/fig\/shade-tree-path\.svg"/.test(readme));
check("Tor boundary copy is precise and qualified", /Tor exit addresses are public/.test(landing) && /publishes no egress-IP list/.test(landing) && /Destinations still see and can block a node IP/.test(landing) && /Destinations still see and can block a node IP/.test(readme));
check("public vocabulary stays paired with protocol names", /Elder Tree/.test(readme) && /bootnode/.test(readme) && /Canopy/.test(readme) && /discovery\s+authority/.test(readme) && /\| Proxy \| client \|/.test(protocol));

check("Grove names the research census pulse without claiming browser bootnode contact", /full pulse marks a newly signed research census verified over Tor/i.test(grovePage) && /Counts and rounded time remain\. Node records do not\./.test(grovePage) && !/browser.{0,30}(queries|contacts|fetches).{0,30}(bootnode|Elder)/i.test(grovePage));
check("Grove links to the public data contract", /docs\/PUBLIC-GROVE\.md/.test(grovePage));

check("path graphic has accessible text and separates the two planes", /<title[^>]*>[^<]+<\/title>/.test(pathGraphic) && /<desc[^>]*>[^<]+<\/desc>/.test(pathGraphic) && /Discovery plane/i.test(pathGraphic) && /Traffic path/i.test(pathGraphic) && /stays out of this path/i.test(pathGraphic) && !/<script\b|\u2014/.test(pathGraphic));
check("mobile path graphic is accessible, vertical, and complete", /<svg[^>]+width="720"[^>]+height="1710"[^>]+role="img"[^>]+aria-labelledby="title desc"/.test(mobilePathGraphic) && /<title[^>]*>[^<]+<\/title>/.test(mobilePathGraphic) && /<desc[^>]*>[^<]+<\/desc>/.test(mobilePathGraphic) && /Discovery plane/i.test(mobilePathGraphic) && /Traffic path/i.test(mobilePathGraphic) && /signed heartbeat/.test(mobilePathGraphic) && /signed Canopy/.test(mobilePathGraphic) && /Elder Tree stays out of this path/.test(mobilePathGraphic) && /Destination[\s\S]*sees node IP/.test(mobilePathGraphic) && !/<script\b|\u2014/.test(mobilePathGraphic));

check("full research article is preserved at /research", /id="references"/.test(research) && /id="further-reading"/.test(research));
check("landing and research canonical URLs are distinct", /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/"/.test(landing) && /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/research\/"/.test(research));
check("Grove has its own canonical URL", /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/grove\/"/.test(grovePage));

const researchImages = [...research.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
check("research-note image paths remain intact", researchImages.length === 6 && researchImages.every((src) => src.startsWith("../fig/")));
for (const src of researchImages) check(`research asset exists: ${src}`, existsSync(resolve(SITE, "research", src)));

for (const asset of [
  "site.css",
  "site.js",
  "grove.js",
  "fig/shade-tree-banner.webp",
  "fig/shade-tree-path.svg",
  "fig/shade-tree-path-mobile.svg",
  "favicon.svg",
  "vendor/three-0.185.1/three.module.min.js",
  "vendor/three-0.185.1/three.core.min.js",
  "vendor/three-0.185.1/LICENSE.txt",
  "grove/index.html",
  "grove/grove.css",
  "grove/network.js",
  "grove/scene.js",
  "grove/network.fallback.json",
  "api/grove.mjs",
  "api/_grove-contract.mjs",
  "sitemap.xml",
]) check(`site asset exists: ${asset}`, existsSync(join(SITE, asset)));

check("Three.js is pinned locally with its license", /three-0\.185\.1\/three\.module\.min\.js/.test(landingScene) && /\.\.\/vendor\/three-0\.185\.1\/three\.module\.min\.js/.test(groveScene) && statSync(join(SITE, "vendor/three-0.185.1/LICENSE.txt")).size > 1000);
check("home scene uses WebGL when available, including mobile", /connection\?\.saveData/.test(loader) && /getContext\("webgl2"/.test(loader) && /import\("\.\/grove\.js"\)/.test(loader) && !/compactOrCoarse/.test(loader));
check("Grove lowers quality on mobile instead of disabling WebGL", /const lowQuality = window\.matchMedia/.test(groveLoader) && /quality: lowQuality \? "low" : "high"/.test(groveLoader) && /getContext\("webgl2"/.test(groveLoader) && /import\("\.\/scene\.js"\)/.test(groveLoader));
check("both scenes handle reduced motion, visibility, DPR, and context loss", [landingScene, groveScene].every((scene) => /reducedMotion/.test(scene) && /IntersectionObserver/.test(scene) && /devicePixelRatio/.test(scene) && /webglcontextlost/.test(scene)));

check("network scene draws literal trees and one uncounted Elder", /CylinderGeometry/.test(groveScene) && /branchTransform/.test(groveScene) && /crownGeometry/.test(groveScene) && /elder-tree-uncounted/.test(groveScene));
check("announced trees grow with deterministic stagger", /growthCurve/.test(groveScene) && /groveBornAt/.test(groveScene) && /index \* \(lowQuality/.test(groveScene));
check("scene controller exposes the complete query lifecycle", /return \{[\s\S]*beginQuery,[\s\S]*failQuery,[\s\S]*finishQuery,[\s\S]*updateSnapshot: replaceSnapshot/.test(groveScene));
check("loader emits soft checks and strong new-census pulses", /sceneController\?\.beginQuery\(\)/.test(groveLoader) && /sceneController\?\.finishQuery\(snapshot, \{ freshCensus \}\)/.test(groveLoader) && /sceneController\?\.failQuery\(\)/.test(groveLoader) && /lastLiveObservedAt !== snapshot\.observedAt/.test(groveLoader));
check("Grove geometry is aggregate-only", /snapshot\.observedAt/.test(groveScene) && /snapshot\.nodes\.announced/.test(groveScene) && !/onion|pubkey|operator|wallet|region|location|asn/i.test(groveScene));

const headingIds = [...research.matchAll(/<h[1-6][^>]+id="([^"]+)"/g)].map((match) => match[1]);
check("legacy article bookmarks are forwarded", headingIds.length >= 15 && headingIds.every((id) => loader.includes(`"${id}"`)));
check("malformed and same-page article bookmarks remain safe", loader.includes('"title-block-header"') && loader.includes('"TOC"') && /try\s*\{[\s\S]*decodeURIComponent/.test(loader) && /addEventListener\("hashchange", forwardArticleBookmark\)/.test(loader));
check("clipboard fallback copies the command without its prompt", /helper\.value = command/.test(loader) && /execCommand\("copy"\)/.test(loader));

check("CSP permits only self-hosted scripts", csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && !csp.includes("unsafe-eval") && !/https?:/.test(csp));
check("CSP limits reads and closes objects and workers", csp.includes("connect-src 'self'") && csp.includes("object-src 'none'") && csp.includes("worker-src 'none'"));
check("browser reads only the same-origin API and bundled fallback", /const LIVE_URL = "\/api\/grove"/.test(groveLoader) && /const FALLBACK_URL = "\/grove\/network\.fallback\.json"/.test(groveLoader) && !/raw\.githubusercontent|fetch\([^)]*\.onion/i.test(groveLoader));
check("browser polling allows the API response to use edge caching", !/cache:\s*"no-store"/.test(groveLoader));
check("browser verifies a pinned Ed25519 snapshot before rendering", /crypto\.subtle\.verify/.test(groveLoader) && /invalid public snapshot/.test(groveLoader) && groveLoader.includes(grovePublicKeyRawBase64(grovePublicKey)));
check("Vercel keeps the old aggregate path as an internal API alias", config.rewrites?.length === 1 && config.rewrites[0].source === "/grove/network.json" && config.rewrites[0].destination === "/api/grove");
check("Vercel deploys a bounded Grove function instead of an external rewrite", config.functions?.["api/grove.mjs"]?.maxDuration === 5 && !/raw\.githubusercontent/.test(JSON.stringify(config)));
check("Grove API validates a fixed, bounded, signed source", /GROVE_SNAPSHOT_URL = "https:\/\/raw\.githubusercontent\.com\/dmarzzz\/shade-tree-node\/network-state\/grove\.json"/.test(groveApiContract) && /GROVE_MAX_BYTES = 64 \* 1024/.test(groveApiContract) && /verifyBytes/.test(groveApiContract));
check("Grove API controls success and failure caching without CORS", /Vercel-CDN-Cache-Control/.test(groveApi) && /"Cache-Control": "no-store"/.test(groveApi) && !/Access-Control-Allow-Origin/i.test(groveApi));

check("bundled snapshot uses the public aggregate schema", fallbackSnapshot.schema === "shade-tree-public-grove-v1" && fallbackSnapshot.source?.directoryVerified === true && fallbackSnapshot.source?.definition === "announced-within-ttl");
check("bundled snapshot top level is allowlisted", Object.keys(fallbackSnapshot).sort().join(",") === "attestation,growth,history,network,nodes,observedAt,privacy,schema,source");
check("bundled snapshot source is allowlisted", Object.keys(fallbackSnapshot.source).sort().join(",") === "bootnodeReachable,cadenceMinutes,definition,directoryVerified");
check("bundled history contains count-only samples", fallbackSnapshot.history.every((sample) => Object.keys(sample).sort().join(",") === "announced,at"));
check("bundled reference has a valid pinned publication signature", verifyPublicGroveAttestation(fallbackSnapshot, grovePublicKey));
check("tampering with the bundled count breaks its signature", !verifyPublicGroveAttestation({ ...fallbackSnapshot, nodes: { announced: 3 } }, grovePublicKey));
const fallbackText = JSON.stringify(fallbackSnapshot);
check("bundled snapshot contains no identity, place, activity, or pulse field", !/\.onion|pubkey|operator|wallet|address|region|country|coordinates?|asn|destination|tunnels?|bytes|requests?|queries|pulse/i.test(fallbackText));

for (const script of ["site.js", "grove.js", "grove/network.js", "grove/scene.js", "api/grove.mjs", "api/_grove-contract.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", join(SITE, script)], { encoding: "utf8" });
  check(`${script} parses as JavaScript`, result.status === 0);
}

check("robots advertises the sitemap", /Sitemap: https:\/\/shade-tree-node\.vercel\.app\/sitemap\.xml/.test(read("robots.txt")));
check("sitemap contains all public pages", /<loc>https:\/\/shade-tree-node\.vercel\.app\/<\/loc>/.test(read("sitemap.xml")) && /<loc>https:\/\/shade-tree-node\.vercel\.app\/research\/<\/loc>/.test(read("sitemap.xml")) && /<loc>https:\/\/shade-tree-node\.vercel\.app\/grove\/<\/loc>/.test(read("sitemap.xml")));

console.log(`PASS: site selftest (${checks.length} checks)`);
