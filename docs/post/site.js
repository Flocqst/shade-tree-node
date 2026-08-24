/* global document, IntersectionObserver, navigator, window */

const ARTICLE_ANCHORS = new Set([
  "title-block-header",
  "TOC",
  "access-gated-onion-egress",
  "tor-exit-ips-are-a-public-blocklist",
  "gating-on-membership-not-identity",
  "an-onion-service-instead-of-an-exit-node",
  "a-membership-proof-rate-limited-with-rln",
  "the-wire-protocol",
  "deployment-and-results",
  "discussion",
  "the-design-space",
  "topology",
  "payment",
  "addendum-zk-payment-channels",
  "how-it-would-work",
  "what-it-costs",
  "references",
  "further-reading",
]);

function forwardArticleBookmark() {
  let articleAnchor = "";
  try {
    articleAnchor = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    // A malformed escape sequence is not an article bookmark. Leave it alone.
  }

  if (ARTICLE_ANCHORS.has(articleAnchor)) {
    window.location.replace(`/research/#${encodeURIComponent(articleAnchor)}`);
  }
}

forwardArticleBookmark();
window.addEventListener("hashchange", forwardArticleBookmark);

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const command = button.dataset.copy;
    if (!command) return;

    const idleLabel = button.textContent;
    let resetDelay = 1800;
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "copied";
    } catch {
      const helper = document.createElement("textarea");
      helper.value = command;
      helper.readOnly = true;
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      document.body.append(helper);
      helper.select();

      if (document.execCommand("copy")) {
        helper.remove();
        button.textContent = "copied";
      } else {
        button.textContent = "press copy";
        resetDelay = 4000;
        window.setTimeout(() => helper.remove(), resetDelay);
      }
    }

    window.setTimeout(() => {
      button.textContent = idleLabel;
    }, resetDelay);
  });
}

const stage = document.querySelector("#grove-stage");
const canvas = document.querySelector("#grove-canvas");
const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function supportsWebGL2() {
  const probe = document.createElement("canvas");
  let context = null;

  try {
    context = probe.getContext("webgl2", {
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
    });
  } catch {
    return false;
  }

  if (!context) return false;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

async function loadGrove() {
  if (!stage || !canvas || connection?.saveData || !supportsWebGL2()) return;

  try {
    const { mountGrove } = await import("./grove.js");
    mountGrove({ stage, canvas, reducedMotion });
  } catch (error) {
    stage.classList.remove("is-live");
    console.warn("Shade Tree grove fell back to its still image.", error);
  }
}

if (stage && "IntersectionObserver" in window) {
  const loader = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    loader.disconnect();
    loadGrove();
  }, { rootMargin: "160px" });
  loader.observe(stage);
} else {
  loadGrove();
}
