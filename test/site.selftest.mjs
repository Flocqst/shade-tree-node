// Static-site regression checks for the hand-authored landing page, the preserved
// research note, and the self-hosted Three.js scene.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const loader = read("site.js");
const grove = read("grove.js");
const config = JSON.parse(read("vercel.json"));
const csp = config.headers[0].headers.find((header) => header.key === "Content-Security-Policy")?.value || "";

check("landing remains a concise front door, not a copy of the research note", landing.length < 18_000 && research.length > 40_000);
check("landing has exactly one H1 and the canvas is decorative", (landing.match(/<h1\b/g) || []).length === 1 && /<canvas[^>]+aria-hidden="true"/.test(landing));
check("full research article is preserved at /research", /id="references"/.test(research) && /id="further-reading"/.test(research));
check("landing and research canonical URLs are distinct", /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/"/.test(landing) && /rel="canonical" href="https:\/\/shade-tree-node\.vercel\.app\/research\/"/.test(research));

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
  "sitemap.xml",
]) {
  check(`landing asset exists: ${asset}`, existsSync(join(SITE, asset)));
}

check("Three.js is pinned locally with its license", /three-0\.185\.1\/three\.module\.min\.js/.test(grove) && statSync(join(SITE, "vendor/three-0.185.1/LICENSE.txt")).size > 1000);
check("mobile, Save-Data, and WebGL2 gate the dynamic scene import", /compactOrCoarse/.test(loader) && /connection\?\.saveData/.test(loader) && /getContext\("webgl2"/.test(loader) && /import\("\.\/grove\.js"\)/.test(loader));
check("scene handles reduced motion, visibility, DPR, and context loss", /reducedMotion/.test(grove) && /IntersectionObserver/.test(grove) && /devicePixelRatio/.test(grove) && /webglcontextlost/.test(grove));

const headingIds = [...research.matchAll(/<h[1-6][^>]+id="([^"]+)"/g)].map((match) => match[1]);
check("legacy article bookmarks are forwarded", headingIds.length >= 15 && headingIds.every((id) => loader.includes(`"${id}"`)));
check("non-heading, same-page, and malformed article bookmarks are handled", loader.includes('"title-block-header"') && loader.includes('"TOC"') && /try\s*{[\s\S]*decodeURIComponent/.test(loader) && /addEventListener\("hashchange", forwardArticleBookmark\)/.test(loader));
check("clipboard fallback copies the command without its prompt", /helper\.value = command/.test(loader) && /execCommand\("copy"\)/.test(loader));

check("CSP permits only self-hosted scripts", csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && !csp.includes("unsafe-eval") && !/https?:/.test(csp));
check("CSP keeps network, objects, and workers closed", csp.includes("connect-src 'none'") && csp.includes("object-src 'none'") && csp.includes("worker-src 'none'"));

for (const script of ["site.js", "grove.js"]) {
  const result = spawnSync(process.execPath, ["--check", join(SITE, script)], { encoding: "utf8" });
  check(`${script} parses as JavaScript`, result.status === 0);
}

check("robots advertises the sitemap", /Sitemap: https:\/\/shade-tree-node\.vercel\.app\/sitemap\.xml/.test(read("robots.txt")));
check("sitemap contains both public pages", /<loc>https:\/\/shade-tree-node\.vercel\.app\/<\/loc>/.test(read("sitemap.xml")) && /<loc>https:\/\/shade-tree-node\.vercel\.app\/research\/<\/loc>/.test(read("sitemap.xml")));

console.log(`PASS: site selftest (${checks.length} checks)`);
