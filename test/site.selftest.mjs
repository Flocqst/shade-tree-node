// Static-site regression checks for the compact landing page, research note,
// signed public Grove, and privacy-preserving Three.js scenes.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grovePublicKeyRawBase64, verifyPublicGroveAttestation } from "../lib/public-grove.mjs";
import * as THREE from "../docs/post/vendor/three-0.185.1/three.module.min.js";
import { orientGroundBeam } from "../docs/post/grove.js";

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
    .replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ")
    .replace(/[·↗…]/g, " ");
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
}

const landing = read("index.html");
const landingCss = read("site.css");
const agentPage = read("agent/index.html");
const operatorPage = read("operator/index.html");
const research = read("research/index.html");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const agentGuide = readFileSync(join(ROOT, "docs", "AGENT.md"), "utf8");
const joinGuide = readFileSync(join(ROOT, "docs", "JOIN.md"), "utf8");
const quickstartGuide = readFileSync(join(ROOT, "docs", "QUICKSTART.md"), "utf8");
const postJoinGuide = read("JOIN.md");
const currentGuides = [
  "ADAPTERS.md",
  "BOOTNODE.md",
  "CLI.md",
  "CLIENTS.md",
  "JOIN.md",
  "OVERVIEW.md",
  "QUICKSTART.md",
].map((path) => readFileSync(join(ROOT, "docs", path), "utf8"));
const currentGuideShellBlocks = currentGuides.flatMap((guide) =>
  [...guide.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((match) => match[1]),
);
const payGuideOutput = readFileSync(join(ROOT, "group", "pay.mjs"), "utf8");
const protocol = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8");
const deploymentPlan = readFileSync(join(ROOT, "docs", "DEPLOYMENT-PLAN.md"), "utf8");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
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
const reputationGraphic = read("fig/shade-tree-reputation.svg");
const mobileReputationGraphic = read("fig/shade-tree-reputation-mobile.svg");
const fallbackSnapshot = JSON.parse(read("grove/network.fallback.json"));
const grovePublicKey = readFileSync(join(ROOT, "network", "grove-signing-public.pem"), "utf8");
const config = JSON.parse(read("vercel.json"));
const csp = config.headers[0].headers.find((header) => header.key === "Content-Security-Policy")?.value || "";
const handoffBrief = landing.match(/<code id="agent-setup-task">([\s\S]*?)<\/code>/)?.[1] || "";
const handoffBriefWords = (handoffBrief.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
const pngMagic = "89504e470d0a1a0a";

check("landing stays compact beside the full research note", landing.length < 9_000 && visibleWords(landing) <= 210 && research.length > 40_000);
check("Grove is one-third-length copy", grovePage.length < 6_000 && visibleWords(grovePage) <= 65);
check("landing has one H1 and one decorative canvas", (landing.match(/<h1\b/g) || []).length === 1 && (landing.match(/<canvas[^>]+aria-hidden="true"/g) || []).length === 1);
check("Grove has one H1, one main section, and one live status", (grovePage.match(/<h1\b/g) || []).length === 1 && (grovePage.match(/<main\b/g) || []).length === 1 && (grovePage.match(/<main[\s\S]*?<section\b/g) || []).length === 1 && /role="status" aria-live="polite"/.test(grovePage));

for (const [name, page] of [["landing", landing], ["agent guide", agentPage], ["operator guide", operatorPage], ["Grove", grovePage]]) {
  check(`${name} has no eyebrow, tiny semantic text, or em dash`, !/eyebrow|preview-label|preview-note|<small\b|<sup\b|<sub\b|<figcaption\b|\u2014/.test(page));
}

check("both sites use the same nocturnal palette", /--understory:\s*#07100c/.test(landingCss) && /--wet-bark:\s*#102219/.test(landingCss) && /--pulse:\s*#e2be67/.test(landingCss) && !/#f3f0e7|--paper\b/.test(landingCss) && /background:\s*var\(--understory\)/.test(groveCss));
check("tree imagery remains behind every surface", /body:not\(\.home-page\)::before/.test(landingCss) && /shade-tree-banner\.webp/.test(landingCss) && /forest-fallback/.test(landing) && /canopy-fallback/.test(grovePage));

check("landing and README lead with the agent and operator outcomes", /<h2>Install the Proxy<\/h2>/.test(landing) && /<h2>Run a Shade Tree node<\/h2>/.test(landing) && /Add Shade Tree to an agent/.test(readme) && /Run a Shade Tree node to provide cover/.test(readme));
check("landing hero jumps straight to both role starts", /href="#proxy">Install the Proxy/.test(landing) && /href="#node">Run a Shade Tree node/.test(landing) && /class="role-link" href="\/agent\/">Agent guide/.test(landing) && /class="role-link" href="\/operator\/">Operator guide/.test(landing));
check("landing separates the reputation gate from the network path", /<h3>Reputation gate<\/h3>/.test(landing) && /admission policy, not the proof/.test(landing) && /Groth16 RLN/.test(landing) && /rate-commitment leaf/.test(landing) && /epoch-scoped nullifiers/i.test(landing) && /<h3>Network path<\/h3>/.test(landing) && /signed Canopy/.test(landing) && /target-bound CONNECT tunnel through Tor/.test(landing) && /Elder Tree never carries agent traffic/.test(landing));
check("landing stacks one graphic under each mechanism", /class="how-stack"[\s\S]*class="how-mechanism"[\s\S]*shade-tree-reputation-mobile\.svg[\s\S]*shade-tree-reputation\.svg[\s\S]*class="how-mechanism"[\s\S]*shade-tree-path-mobile\.svg[\s\S]*shade-tree-path\.svg/.test(landing) && (landing.match(/class="how-mechanism"/g) || []).length === 2 && !/class="how-parts"/.test(landing));
check("landing has role-specific copyable installs", (landing.match(/data-copy="npm install --global git\+https:\/\/github\.com\/dmarzzz\/shade-tree-node\.git/g) || []).length === 1 && /data-copy="git clone https:\/\/github\.com\/dmarzzz\/shade-tree-node\.git &amp;&amp; cd shade-tree-node &amp;&amp; npm ci &amp;&amp; npm link &amp;&amp; shade-tree join node"/.test(landing) && /aria-label="Copy npm installation command"/.test(landing) && /aria-label="Copy node operator installation commands"/.test(landing) && !/npm install (?:--global )?shade-tree-node/.test(landing));
check("landing provides a safe handoff brief for existing agents", /Hermes, OpenClaw, or another agent/.test(landing) && /data-copy="Add Shade Tree to this agent by following https:\/\/github\.com\/dmarzzz\/shade-tree-node\/blob\/main\/docs\/AGENT\.md/.test(landing) && /operator-supplied v4 access profile/.test(landing) && /Do not use the retired Sepolia records or invent profile values/.test(landing) && /hidden prompt/.test(landing) && /Never put the secret in arguments, logs, or source/.test(landing) && /aria-label="Copy Shade Tree setup brief for an AI agent"/.test(landing));
check("agent handoff stays bounded even though command text is outside the prose budget", handoffBriefWords >= 70 && handoffBriefWords <= 100);
check("agent page gives the complete shortest integration path", /npm install --global git\+https:\/\/github\.com\/dmarzzz\/shade-tree-node\.git/.test(agentPage) && /read -s SHADE_TREE_SECRET/.test(agentPage) && /SHADE_TREE_MEMBERS_FILE=\.\/members\.json/.test(agentPage) && /shade-tree proxy/.test(agentPage) && /--limit &lt;operator-tier&gt;/.test(agentPage) && /--leaf-source invited/.test(agentPage) && !/--secret/.test(agentPage) && /shade-tree run -- your-agent/.test(agentPage) && /replace <code>your-agent<\/code> with <code>hermes<\/code>/.test(agentPage) && /There is no public v4 profile yet/.test(agentPage));
const agentCopies = [...agentPage.matchAll(/data-copy="([^"]+)"/g)].map((match) => match[1]);
const secretPromptCopy = agentCopies.find((command) => command.includes("read -s SHADE_TREE_SECRET")) || "";
const proxyStartCopy = agentCopies.find((command) => command.includes("shade-tree proxy")) || "";
check("secret prompt and Proxy launch are separate copy actions", secretPromptCopy === "read -s SHADE_TREE_SECRET &amp;&amp; export SHADE_TREE_SECRET" && !/read -s SHADE_TREE_SECRET/.test(proxyStartCopy) && /SHADE_TREE_MEMBERS_FILE/.test(proxyStartCopy) && /--limit &lt;operator-tier&gt;/.test(proxyStartCopy) && /--leaf-source invited/.test(proxyStartCopy));
check("operator page is guided from a source checkout and keeps only current deployment blockers", /git clone https:\/\/github\.com\/dmarzzz\/shade-tree-node\.git &amp;&amp; cd shade-tree-node &amp;&amp; npm ci &amp;&amp; npm link/.test(operatorPage) && !/npm install --global/.test(operatorPage) && /shade-tree join node/.test(operatorPage) && /Local research only/.test(operatorPage) && /rejects non-public destination addresses after DNS resolution/.test(operatorPage) && /untrusted development Groth16 artifacts/.test(operatorPage) && /issues\/6/.test(operatorPage) && !/issues\/73/.test(operatorPage) && /no repo-maintained public v4 connection profile/.test(operatorPage) && /It does not configure Tor/.test(operatorPage) && /manual local quickstart uses the checkout/.test(operatorPage));
check("README and canonical agent doc give an honest current integration path", /## Agent developers/.test(readme) && /docs\/AGENT\.md/.test(readme) && /Git install, not an npm registry release/.test(readme) && /read -s SHADE_TREE_SECRET/.test(readme) && !/shade-tree proxy[^\n]*--secret/.test(readme) && /shade-tree run -- your-agent/.test(readme) && /no repo-maintained public v4\s+connection profile yet/i.test(readme) && /npm install --global git\+https:\/\/github\.com\/dmarzzz\/shade-tree-node\.git/.test(agentGuide) && /There is no repo-maintained public v4 access profile/.test(agentGuide) && /read -s SHADE_TREE_SECRET/.test(agentGuide) && !/shade-tree proxy[^\n]*--secret/.test(agentGuide) && /SHADE_TREE_MEMBERS_FILE=\.\/members\.json/.test(agentGuide) && /shade-tree run -- hermes/.test(agentGuide));
check("current guidance keeps bearer secrets out of Proxy argv", [...currentGuides, payGuideOutput].every((guide) => !/shade-tree (?:proxy|client|shim)[^\n]*--secret(?!-file)\b/.test(guide)) && currentGuideShellBlocks.every((block) => !/shade-tree (?:proxy|client|shim)[\s\S]{0,120}--secret(?!-file)\b/.test(block)) && /do not pass it on argv/.test(payGuideOutput));
check("setup guides never place a member secret in argv or inline shell history", [joinGuide, quickstartGuide, postJoinGuide, agentPage].every((guide) => !/SHADE_TREE_SECRET\s*=\s*<(?:hex|member|your)/i.test(guide) && !/shade-tree (?:proxy|client)[^\n]*--secret(?!-file)\b/.test(guide) && !/scripts\/join\.sh\s+<[^>\n]*secret/i.test(guide)));
check("setup guides require the operator's exact tier and invited member file", [joinGuide, quickstartGuide, postJoinGuide].every((guide) => /read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET/.test(guide) && /--limit "\$SHADE_TREE_LIMIT"/.test(guide) && /SHADE_TREE_MEMBERS_FILE=\/path\/from-operator\/members\.json/.test(guide) && /--leaf-source invited/.test(guide)));
check("Git install payload carries every routed CLI runtime", ["bin/", "bootnode/", "client/", "gateway/", "group/", "lib/", "network/", "payments/", "scripts/", "circuits/", "contracts/"].every((path) => packageJson.files.includes(path)));
check("deployment plan includes the Elder Tree and safety gates", /Elder Tree \(`bootnode` in source\)/.test(deploymentPlan) && /\[#73\]/.test(deploymentPlan) && /untrusted development Groth16 setup/.test(deploymentPlan) && /Add the actual Elder and node hosts to Ansible inventory/.test(deploymentPlan));
check("existing Discussions provide lightweight support", /shade-tree-node\/discussions/.test(landing));
check("landing uses the responsive path graphic and README uses its compact flow", /<picture\b[^>]*>[\s\S]*?media="\(max-width: 560px\)"[\s\S]*?srcset="\/fig\/shade-tree-path-mobile\.svg"[^>]+width="720" height="1250"[\s\S]*?<img src="\/fig\/shade-tree-path\.svg"/.test(landing) && /docs\/post\/fig\/shade-tree-readme\.svg/.test(readme));
check("Tor boundary copy is precise and qualified", /Tor exit addresses are public/.test(landing) && /publishes no egress-IP list/.test(landing) && /Destinations still see and can block a node IP/.test(landing) && /Destinations still see and can block a node IP/.test(readme));
check("public vocabulary stays paired with protocol names", /Elder Tree/.test(readme) && /bootnode/.test(readme) && /Canopy/.test(readme) && /controls discovery/.test(readme) && /\| Proxy \| client \|/.test(protocol));

check("Grove names the research census pulse without claiming browser bootnode contact", /full pulse marks a newly signed research census verified over Tor/i.test(grovePage) && /Counts and rounded time remain\. Node records do not\./.test(grovePage) && !/browser.{0,30}(queries|contacts|fetches).{0,30}(bootnode|Elder)/i.test(grovePage));
check("Grove links to the public data contract", /docs\/PUBLIC-GROVE\.md/.test(grovePage));

check("path graphic has accessible text and separates the two planes", /<title[^>]*>[^<]+<\/title>/.test(pathGraphic) && /<desc[^>]*>[^<]+<\/desc>/.test(pathGraphic) && /Discovery plane/i.test(pathGraphic) && /Traffic path/i.test(pathGraphic) && /target-bound RLN proof \+ nullifier/.test(pathGraphic) && /stays out of this path/i.test(pathGraphic) && !/<script\b|\u2014/.test(pathGraphic));
check("mobile path graphic is accessible, vertical, and complete", /<svg[^>]+width="720"[^>]+height="1250"[^>]+role="img"[^>]+aria-labelledby="title desc"/.test(mobilePathGraphic) && /<title[^>]*>[^<]+<\/title>/.test(mobilePathGraphic) && /<desc[^>]*>[^<]+<\/desc>/.test(mobilePathGraphic) && /Discovery plane/i.test(mobilePathGraphic) && /Traffic path/i.test(mobilePathGraphic) && /signed heartbeat/.test(mobilePathGraphic) && /signed Canopy/.test(mobilePathGraphic) && /target-bound RLN proof[\s\S]*epoch nullifier/.test(mobilePathGraphic) && /Elder Tree stays out of this path/.test(mobilePathGraphic) && /Destination[\s\S]*sees node IP/.test(mobilePathGraphic) && !/<script\b|\u2014/.test(mobilePathGraphic));
check("reputation graphics are accessible and keep admission separate from proof", [reputationGraphic, mobileReputationGraphic].every((graphic) => /role="img"[^>]+aria-labelledby="title desc"/.test(graphic) && /<title[^>]*>[^<]+<\/title>/.test(graphic) && /<desc[^>]*>[^<]+<\/desc>/.test(graphic) && /Operator admission/i.test(graphic) && /Groth16 RLN proof/.test(graphic) && /without revealing which leaf/i.test(graphic) && /epoch[^<]+nullifier/i.test(graphic) && /local (?:view of the )?tunnel budget|Local tunnel[\s\S]*budget view/i.test(graphic) && !/<script\b|\u2014/.test(graphic)));
const mobileDiagramFontSizes = [mobilePathGraphic, mobileReputationGraphic]
  .flatMap((graphic) => [...graphic.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1])));
check("mobile diagram labels remain readable after responsive scaling", mobileDiagramFontSizes.length >= 8 && Math.min(...mobileDiagramFontSizes) >= 34);

check("Grove exposes the uncounted Elder label to assistive technology", /<div class="elder-label"><span class="elder-leader" aria-hidden="true"><\/span><span data-elder-label>Elder Tree · discovery · not counted<\/span><\/div>/.test(grovePage) && !/<div class="elder-label"[^>]+aria-hidden/.test(grovePage));
check("compact navigation and controls keep full touch targets", /\.wordmark\s*\{[\s\S]*?min-height:\s*2\.75rem/.test(landingCss) && /\.nav-links a\s*\{[\s\S]*?min-width:\s*2\.75rem;[\s\S]*?min-height:\s*2\.75rem/.test(landingCss) && /\.copy-command\s*\{[\s\S]*?min-width:\s*7\.6rem;[\s\S]*?min-height:\s*2\.75rem/.test(landingCss) && /\.site-footer a\s*\{[\s\S]*?min-width:\s*2\.75rem;[\s\S]*?min-height:\s*2\.75rem/.test(landingCss) && /\.grove-contract a\s*\{[\s\S]*?min-height:\s*2\.75rem/.test(groveCss));

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
  "fig/shade-tree-og.png",
  "fig/shade-tree-path.svg",
  "fig/shade-tree-path-mobile.svg",
  "fig/shade-tree-reputation.svg",
  "fig/shade-tree-reputation-mobile.svg",
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
  "agent/index.html",
  "operator/index.html",
  "sitemap.xml",
]) check(`site asset exists: ${asset}`, existsSync(join(SITE, asset)));

check("Open Graph images are real PNG files", [
  join(SITE, "fig/shade-tree-og.png"),
  join(ROOT, "assets", "shade-tree-og.png"),
].every((path) => existsSync(path) && readFileSync(path).subarray(0, 8).toString("hex") === pngMagic));

check("Three.js is pinned locally with its license", /three-0\.185\.1\/three\.module\.min\.js/.test(landingScene) && /\.\.\/vendor\/three-0\.185\.1\/three\.module\.min\.js/.test(groveScene) && statSync(join(SITE, "vendor/three-0.185.1/LICENSE.txt")).size > 1000);
check("home scene uses WebGL when available, including mobile", /connection\?\.saveData/.test(loader) && /getContext\("webgl2"/.test(loader) && /import\("\.\/grove\.js"\)/.test(loader) && !/compactOrCoarse/.test(loader));
check("home scene camera follows the stacked-layout breakpoint", /matchMedia\("\(max-width: 900px\)"\)/.test(landingScene) && /@media \(max-width: 900px\)/.test(landingCss));
check("home scene is an irregular canopy map with a bidirectional through-running pixel route", /targetCount = mobile \? 18 : 29/.test(landingScene) && /crowded = trees\.some/.test(landingScene) && /SphereGeometry\(1, 7, 5\)/.test(landingScene) && /CatmullRomCurve3/.test(landingScene) && /segmentCount = mobile \? 36 : 52/.test(landingScene) && /new THREE\.Vector3\(-0\.7, 0\.34, 13\.5\)/.test(landingScene) && /new THREE\.Vector3\(18\.0, 0\.34, -7\.4\)/.test(landingScene) && /const destination = new THREE\.Mesh/.test(landingScene) && /const outbound = makePacket/.test(landingScene) && /const inbound = makePacket/.test(landingScene) && /direction: -1/.test(landingScene) && /positionPacket\(outbound, outboundProgress\)/.test(landingScene) && /positionPacket\(inbound, 1 - outboundProgress\)/.test(landingScene));
check("home scene uses larger trees, a feathered shade field, and three crossing sunbeams", /treeScale = mobile \? 1\.08 : 1\.07/.test(landingScene) && /height = \(2\.5 \+ random\(\) \* 1\.8\) \* treeScale/.test(landingScene) && /inCopyClearing/.test(landingScene) && /new THREE\.PlaneGeometry\(mobile \? 17 : 34, mobile \? 27 : 23\)/.test(landingScene) && /new THREE\.ShaderMaterial/.test(landingScene) && /smoothstep\(0\.56 \+ edge, 0\.99 \+ edge/.test(landingScene) && /const beamSpecs = mobile \? \[/.test(landingScene) && /\{ width: 1\.65, length: 48, angle: -1\.02/.test(landingScene) && /\{ width: 1\.02, length: 46, angle: 1\.01/.test(landingScene) && /\{ width: 2\.2, length: 66, angle: -1\.02/.test(landingScene) && /\{ width: 1\.3, length: 62, angle: 1\.01/.test(landingScene) && /beamSpecs\.forEach/.test(landingScene) && /beamStrength: \{ value: spec\.strength \}/.test(landingScene) && /orientGroundBeam\(beam, spec\.angle\)/.test(landingScene) && !/new THREE\.ShapeGeometry\(shape\)/.test(landingScene) && /new THREE\.Fog\(NIGHT, 35, 60\)/.test(landingScene) && /new THREE\.Vector3\(mobile \? 8 : 14, mobile \? 31 : 28, mobile \? 18 : 18\)/.test(landingScene) && /desktopViewHeight = Math\.min\(35, Math\.max\(22, 35 \/ aspect\)\)/.test(landingScene) && /viewHeight = mobile \? 28 : desktopViewHeight/.test(landingScene) && /renderer\.shadowMap\.enabled = !mobile/.test(landingScene));

const beamAngles = [-1.02, 0.02, 1.01, -1.02, 0.02, 1.01];
const beamDirections = beamAngles.map((angle) => {
  const beam = new THREE.Object3D();
  orientGroundBeam(beam, angle);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(beam.quaternion);
  const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(beam.quaternion);
  const expected = new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle));
  return { normal, direction, expected };
});
check("ground-beam rotations stay flat and produce three distinct directions per layout", beamDirections.every(({ normal, direction, expected }) => normal.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6 && direction.distanceTo(expected) < 1e-6) && [beamDirections.slice(0, 3), beamDirections.slice(3)].every((layout) => new Set(layout.map(({ direction }) => `${direction.x.toFixed(4)},${direction.z.toFixed(4)}`)).size === 3));
check("Grove lowers quality on mobile instead of disabling WebGL", /const lowQuality = window\.matchMedia/.test(groveLoader) && /quality: lowQuality \? "low" : "high"/.test(groveLoader) && /getContext\("webgl2"/.test(groveLoader) && /import\("\.\/scene\.js"\)/.test(groveLoader));
check("both scenes handle reduced motion, visibility, DPR, and context loss", [landingScene, groveScene].every((scene) => /reducedMotion/.test(scene) && /IntersectionObserver/.test(scene) && /devicePixelRatio/.test(scene) && /webglcontextlost/.test(scene)));
check("both scenes stop frame scheduling offscreen and resume from BFCache", [landingScene, groveScene].every((scene) => /function stopFrames\(\)/.test(scene) && /function scheduleFrame\(\)/.test(scene) && /if \(event\.persisted\) \{\s*stopFrames\(\)/.test(scene) && /addEventListener\("pageshow", onPageShow\)/.test(scene) && /addEventListener\("visibilitychange", onVisibilityChange\)/.test(scene) && (scene.match(/requestAnimationFrame\(tick\)/g) || []).length === 1));
check("home scene uses the supported shadow filter without console fallback", /renderer\.shadowMap\.type = THREE\.PCFShadowMap/.test(landingScene) && !/PCFSoftShadowMap/.test(landingScene));

check("network scene draws literal trees and one uncounted Elder", /CylinderGeometry/.test(groveScene) && /branchTransform/.test(groveScene) && /crownGeometry/.test(groveScene) && /elder-tree-uncounted/.test(groveScene));
check("announced trees grow with deterministic stagger", /growthCurve/.test(groveScene) && /groveBornAt/.test(groveScene) && /index \* \(lowQuality/.test(groveScene));
check("scene controller exposes the complete query lifecycle", /return \{[\s\S]*beginQuery,[\s\S]*failQuery,[\s\S]*finishQuery,[\s\S]*updateSnapshot: replaceSnapshot/.test(groveScene));
check("loader emits soft checks and strong new-census pulses", /sceneController\?\.beginQuery\(\)/.test(groveLoader) && /sceneController\?\.finishQuery\(snapshot, \{ freshCensus \}\)/.test(groveLoader) && /sceneController\?\.failQuery\(\)/.test(groveLoader) && /lastLiveObservedAt !== snapshot\.observedAt/.test(groveLoader));
check("Grove resumes signed-view polling after BFCache restore", /function onPageHide\(\)\s*\{\s*window\.clearTimeout\(pollTimer\)/.test(groveLoader) && /function onPageShow\(event\)\s*\{\s*if \(!event\.persisted\) return;\s*load\(\)/.test(groveLoader) && /addEventListener\("pageshow", onPageShow\)/.test(groveLoader));
check("Grove geometry is aggregate-only", /snapshot\.observedAt/.test(groveScene) && /snapshot\.nodes\.announced/.test(groveScene) && !/onion|pubkey|operator|wallet|region|location|asn/i.test(groveScene));

const headingIds = [...research.matchAll(/<h[1-6][^>]+id="([^"]+)"/g)].map((match) => match[1]);
check("legacy article bookmarks are forwarded", headingIds.length >= 15 && headingIds.every((id) => loader.includes(`"${id}"`)));
check("malformed and same-page article bookmarks remain safe", loader.includes('"title-block-header"') && loader.includes('"TOC"') && /try\s*\{[\s\S]*decodeURIComponent/.test(loader) && /addEventListener\("hashchange", forwardArticleBookmark\)/.test(loader));
check("clipboard fallback copies the command without its prompt", /helper\.value = command/.test(loader) && /execCommand\?\.\("copy"\)/.test(loader));
check("copy feedback is announced", /setAttribute\("aria-live", "polite"\)/.test(loader) && /Command copied to clipboard/.test(loader));
check("clipboard failure reveals and selects the requested copy target", /finally\s*\{\s*helper\.remove\(\)/.test(loader) && /document\.getElementById\(button\.dataset\.copyTarget\)/.test(loader) && /visibleCode\.closest\("details"\)\?\.setAttribute\("open", ""\)/.test(loader) && /range\.selectNodeContents\(visibleCode\)/.test(loader) && /Command selected\. Press Control\+C or Command\+C to copy\./.test(loader));
check("copyable commands remain inspectable", /\.command code\s*\{[\s\S]*?overflow-wrap:\s*anywhere/.test(landingCss) && !/\.command code\s*\{[\s\S]*?text-overflow:\s*ellipsis/.test(landingCss));
check("copy controls stack before mobile commands can clip", /@media \(max-width: 600px\)\s*\{[\s\S]*?\.command\s*\{\s*grid-template-columns:\s*1fr/.test(landingCss));

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
check("sitemap contains all public pages", ["/", "/research/", "/grove/", "/agent/", "/operator/"].every((path) => read("sitemap.xml").includes(`<loc>https://shade-tree-node.vercel.app${path}</loc>`)));

console.log(`PASS: site selftest (${checks.length} checks)`);
