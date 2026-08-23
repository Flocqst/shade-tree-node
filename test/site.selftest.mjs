// Static-site regression checks for the hand-authored landing page, the preserved
// research note, and the aggregate-only public Grove scenes.

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

const landing = read("index.html");
const research = read("research/index.html");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const loader = read("site.js");
const landingScene = read("grove.js");
const grovePage = read("grove/index.html");
const groveLoader = read("grove/network.js");
const groveScene = read("grove/scene.js");
const fallbackSnapshot = JSON.parse(read("grove/network.fallback.json"));
const grovePublicKey = readFileSync(join(ROOT, "network", "grove-signing-public.pem"), "utf8");
const config = JSON.parse(read("vercel.json"));
const csp = config.headers[0].headers.find((header) => header.key === "Content-Security-Policy")?.value || "";

check("landing remains a concise front door, not a copy of the research note", landing.length < 18_000 && research.length > 40_000);
check("landing has exactly one H1 and the canvas is decorative", (landing.match(/<h1\b/g) || []).length === 1 && /<canvas[^>]+aria-hidden="true"/.test(landing));
check("full research article is preserved at /research", /id="references"/.test(research) && /id="further-reading"/.test(research));
check("landing and research canonical URLs are distinct", /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/"/.test(landing) && /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/research\/"/.test(research));
check("landing and README state both sides of the user story", /Run the proxy beside your agent/.test(landing) && /Run a Shade Tree node to provide cover for agents/.test(landing) && /Running an agent\? Run the local proxy beside it/.test(readme) && /Providing cover for agents\? Run a Shade Tree node/.test(readme));
check("landing exposes the Grove without diluting the two user paths", /href="\/grove\/">Grove</.test(landing) && /href="#run">Use the proxy/.test(landing) && /href="#provide">Provide a node/.test(landing));
check("Grove has one accessible H1 and a decorative canvas", (grovePage.match(/<h1\b/g) || []).length === 1 && /<canvas[^>]+aria-hidden="true"/.test(grovePage) && /role="status" aria-live="polite"/.test(grovePage));
check("Grove has its own canonical URL and precise aggregate framing", /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/grove\/"/.test(grovePage) && /last signed directory/.test(grovePage) && /topology, not territory/.test(grovePage));
check("Grove states the public-data exclusions and reporting threshold", /No onion, key, wallet, operator/.test(grovePage) && /No IP, ASN, city, coordinate/.test(grovePage) && /No destinations, traffic volumes/.test(grovePage) && /at least five reporting nodes/.test(grovePage) && /not prove five independent operators/.test(grovePage));
check("Grove explains both directory and publication verification", /verifies a fresh signed directory/.test(grovePage) && /verifies that dedicated publication signature/.test(grovePage));

const researchImages = [...research.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
check("every research-note image uses its relocated relative path", researchImages.length === 6 && researchImages.every((src) => src.startsWith("../fig/")));
for (const src of researchImages) {
  check(`research asset exists: ${src}`, existsSync(resolve(SITE, "research", src)));
}

for (const asset of [
  "site.css",
  "site.js",
  "grove.js",
  "fig/shade-tree-banner.webp",
  "fig/shade-tree-protocol.png",
  "favicon.svg",
  "vendor/three-0.185.1/three.module.min.js",
  "vendor/three-0.185.1/three.core.min.js",
  "vendor/three-0.185.1/LICENSE.txt",
  "grove/index.html",
  "grove/grove.css",
  "grove/network.js",
  "grove/scene.js",
  "grove/network.fallback.json",
  "sitemap.xml",
]) {
  check(`landing asset exists: ${asset}`, existsSync(join(SITE, asset)));
}

check("Three.js is pinned locally with its license", /three-0\.185\.1\/three\.module\.min\.js/.test(landingScene) && /\.\.\/vendor\/three-0\.185\.1\/three\.module\.min\.js/.test(groveScene) && statSync(join(SITE, "vendor/three-0.185.1/LICENSE.txt")).size > 1000);
check("mobile, Save-Data, and WebGL2 gate the dynamic scene import", /compactOrCoarse/.test(loader) && /connection\?\.saveData/.test(loader) && /getContext\("webgl2"/.test(loader) && /import\("\.\/grove\.js"\)/.test(loader));
check("Grove also gates WebGL and loads its scene only on capable clients", /compactOrCoarse/.test(groveLoader) && /connection\?\.saveData/.test(groveLoader) && /getContext\("webgl2"/.test(groveLoader) && /import\("\.\/scene\.js"\)/.test(groveLoader));
check("both scenes handle reduced motion, visibility, DPR, and context loss", [landingScene, groveScene].every((scene) => /reducedMotion/.test(scene) && /IntersectionObserver/.test(scene) && /devicePixelRatio/.test(scene) && /webglcontextlost/.test(scene)));
check("Grove geometry is seeded by aggregate time and count, never a node identity", /snapshot\.observedAt/.test(groveScene) && /snapshot\.nodes\.announced/.test(groveScene) && !/onion|pubkey|operator|wallet|region|location|asn/i.test(groveScene));

const headingIds = [...research.matchAll(/<h[1-6][^>]+id="([^"]+)"/g)].map((match) => match[1]);
check("legacy article bookmarks are forwarded", headingIds.length >= 15 && headingIds.every((id) => loader.includes(`"${id}"`)));
check("non-heading, same-page, and malformed article bookmarks are handled", loader.includes('"title-block-header"') && loader.includes('"TOC"') && /try\s*{[\s\S]*decodeURIComponent/.test(loader) && /addEventListener\("hashchange", forwardArticleBookmark\)/.test(loader));
check("clipboard fallback copies the command without its prompt", /helper\.value = command/.test(loader) && /execCommand\("copy"\)/.test(loader));

check("CSP permits only self-hosted scripts", csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && !csp.includes("unsafe-eval") && !/https?:/.test(csp));
check("CSP limits reads to same-origin and keeps objects and workers closed", csp.includes("connect-src 'self'") && csp.includes("object-src 'none'") && csp.includes("worker-src 'none'"));
check("browser fetches only the same-origin aggregate with a bundled fallback", /const LIVE_URL = "\/grove\/network\.json"/.test(groveLoader) && /const FALLBACK_URL = "\/grove\/network\.fallback\.json"/.test(groveLoader) && !/raw\.githubusercontent|\.onion/i.test(groveLoader));
check("browser verifies a pinned Ed25519 snapshot before rendering", /crypto\.subtle\.verify/.test(groveLoader) && /invalid public snapshot/.test(groveLoader) && groveLoader.includes(grovePublicKeyRawBase64(grovePublicKey)));
check("Vercel rewrites only the aggregate route to the generated state branch", config.rewrites?.length === 1 && config.rewrites[0].source === "/grove/network.json" && /\/network-state\/grove\.json$/.test(config.rewrites[0].destination));

check("bundled snapshot uses the public schema and verified aggregate source", fallbackSnapshot.schema === "shade-tree-public-grove-v1" && fallbackSnapshot.source?.directoryVerified === true && fallbackSnapshot.source?.definition === "announced-within-ttl");
check("bundled snapshot top level is allowlisted", Object.keys(fallbackSnapshot).sort().join(",") === "attestation,growth,history,network,nodes,observedAt,privacy,schema,source");
check("bundled snapshot source is allowlisted", Object.keys(fallbackSnapshot.source).sort().join(",") === "bootnodeReachable,cadenceMinutes,definition,directoryVerified");
check("bundled history contains count-only samples", fallbackSnapshot.history.every((sample) => Object.keys(sample).sort().join(",") === "announced,at"));
check("bundled reference has a valid pinned publication signature", verifyPublicGroveAttestation(fallbackSnapshot, grovePublicKey));
check("tampering with the bundled count breaks its publication signature", !verifyPublicGroveAttestation({ ...fallbackSnapshot, nodes: { announced: 3 } }, grovePublicKey));
const fallbackText = JSON.stringify(fallbackSnapshot);
check("bundled snapshot contains no node identity, place, or activity field", !/\.onion|pubkey|operator|wallet|address|region|country|coordinates?|asn|destination|tunnels?|bytes|requests?/i.test(fallbackText));
check("live Three.js canopy can be replaced when the signed snapshot changes", /sceneSeed/.test(groveLoader) && /updateSnapshot/.test(groveLoader) && /updateSnapshot/.test(groveScene) && /disposeObject/.test(groveScene));

for (const script of ["site.js", "grove.js", "grove/network.js", "grove/scene.js"]) {
  const result = spawnSync(process.execPath, ["--check", join(SITE, script)], { encoding: "utf8" });
  check(`${script} parses as JavaScript`, result.status === 0);
}

check("robots advertises the sitemap", /Sitemap: https:\/\/shade-tree-node\.vercel\.app\/sitemap\.xml/.test(read("robots.txt")));
check("sitemap contains all three public pages", /<loc>https:\/\/shade-tree-node\.vercel\.app\/<\/loc>/.test(read("sitemap.xml")) && /<loc>https:\/\/shade-tree-node\.vercel\.app\/research\/<\/loc>/.test(read("sitemap.xml")) && /<loc>https:\/\/shade-tree-node\.vercel\.app\/grove\/<\/loc>/.test(read("sitemap.xml")));

console.log(`PASS: site selftest (${checks.length} checks)`);
