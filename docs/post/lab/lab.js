/* global CustomEvent, document, history, navigator, URL, window */

const scenarios = {
  "invited-success": {
    kind: "Invited passage",
    title: "One proof. No name.",
    failAt: null,
    resultState: "Passage opened",
    resultTitle: "First passage under the Shade Tree",
    facts: [
      "Hidden-leaf membership verified",
      "Node reached through a Tor onion service",
      "Proof-gated CONNECT opened",
    ],
  },
  "staked-success": {
    kind: "Staked passage",
    title: "Reputation becomes a private root.",
    failAt: null,
    resultState: "Passage opened",
    resultTitle: "Stake admitted without naming its leaf",
    facts: [
      "Finalized staked root selected",
      "Groth16 proof hid the member commitment",
      "Local tunnel budget accepted the slot",
    ],
  },
  "paid-success": {
    kind: "Paid passage",
    title: "Access issued. Payment stays off the path.",
    failAt: null,
    resultState: "Passage opened",
    resultTitle: "Issued access crossed the Grove",
    facts: [
      "Paid access root selected",
      "The node saw a proof, not a payment receipt",
      "The destination saw the Shade Tree node IP",
    ],
  },
  "outsider-denied": {
    kind: "Unknown leaf",
    title: "No admitted root. No passage.",
    failAt: 3,
    resultState: "Proof rejected",
    resultTitle: "The outsider stops at the gate",
    facts: [
      "Canopy verification completed",
      "Membership proof matched no admitted root",
      "No Tor tunnel or destination connection opened",
    ],
  },
  "budget-exhausted": {
    kind: "Budget exhausted",
    title: "Membership passes. The slot does not.",
    failAt: 5,
    resultState: "Tunnel denied",
    resultTitle: "The local budget closes the path",
    facts: [
      "Hidden-leaf membership verified",
      "Tor delivered the sealed request to the node",
      "The epoch-scoped tunnel budget refused the slot",
    ],
  },
};

const stageDetails = [
  ["Proxy", "The local Proxy binds the requested destination into a fresh protocol signal."],
  ["Canopy", "The Proxy verifies the Elder Tree signature, protocol range, node capabilities, and admitted roots."],
  ["Hidden leaf", "Groth16 RLN proves one rate-commitment leaf belongs to an admitted root without revealing which leaf."],
  ["Tor onion", "The request travels to the selected node's onion service. The Elder Tree stays off this traffic path."],
  ["Shade Tree", "The node verifies the proof and epoch-scoped budget before opening an opaque CONNECT tunnel."],
];

const form = document.querySelector(".scenario-selector");
const map = document.querySelector("[data-passage-map]");
const steps = [...document.querySelectorAll("[data-step]")];
const result = document.querySelector("[data-result]");
const kind = document.querySelector("[data-trace-kind]");
const title = document.querySelector("[data-trace-title]");
const clock = document.querySelector("[data-trace-clock]");
const detailLabel = document.querySelector("[data-detail-label]");
const detailCopy = document.querySelector("[data-detail-copy]");
const resultState = document.querySelector("[data-result-state]");
const resultTitle = document.querySelector("[data-result-title]");
const resultFacts = document.querySelector("[data-result-facts]");
const shareButton = document.querySelector("[data-share]");
const copyButton = document.querySelector("[data-copy-link]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let runToken = 0;
const canonicalLabUrl = "https://shade-tree-node.vercel.app/lab/";

function selectedScenario() {
  return form?.elements.scenario.value || "invited-success";
}

function fixtureUrl(name = selectedScenario()) {
  const url = new URL(canonicalLabUrl);
  url.searchParams.set("scenario", name);
  return url.toString();
}

function announceEvent(event, scenario) {
  document.dispatchEvent(new CustomEvent("shade-tree-lab", {
    detail: { event, scenario },
  }));
}

function resetTrace(name) {
  const scenario = scenarios[name] || scenarios["invited-success"];
  runToken += 1;
  kind.textContent = scenario.kind;
  title.textContent = scenario.title;
  clock.textContent = "Ready";
  detailLabel.textContent = "Route ready";
  detailCopy.textContent = "Select a trace, then walk the recorded protocol path.";
  map.style.setProperty("--route-progress", "0");
  map.dataset.progress = "0";
  delete map.dataset.result;
  for (const step of steps) delete step.dataset.state;
  result.hidden = true;
  result.removeAttribute("data-outcome");
  history.replaceState(null, "", `?scenario=${encodeURIComponent(name)}`);
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(token === runToken), ms);
  });
}

function renderResult(scenario) {
  const denied = Boolean(scenario.failAt);
  resultState.textContent = scenario.resultState;
  resultTitle.textContent = scenario.resultTitle;
  resultFacts.replaceChildren(...scenario.facts.map((fact) => {
    const item = document.createElement("li");
    item.textContent = fact;
    return item;
  }));
  result.dataset.outcome = denied ? "denied" : "opened";
  result.hidden = false;
  clock.textContent = denied ? "Closed" : "Complete";
  map.dataset.result = denied ? "denied" : "opened";
  announceEvent(denied ? "trace_denied" : "trace_completed", selectedScenario());
}

async function walkTrace() {
  const name = selectedScenario();
  const scenario = scenarios[name];
  resetTrace(name);
  const token = runToken;
  announceEvent("lab_started", name);

  for (let index = 0; index < steps.length; index += 1) {
    if (token !== runToken) return;
    const stepNumber = index + 1;
    const step = steps[index];
    step.dataset.state = "active";
    clock.textContent = `Step ${stepNumber} / 5`;
    detailLabel.textContent = stageDetails[index][0];
    detailCopy.textContent = stageDetails[index][1];
    map.style.setProperty("--route-progress", String(stepNumber * 20));
    map.dataset.progress = String(stepNumber);

    if (!reducedMotion && !(await sleep(620, token))) return;

    if (scenario.failAt === stepNumber) {
      step.dataset.state = "denied";
      renderResult(scenario);
      return;
    }
    step.dataset.state = "passed";
  }

  renderResult(scenario);
}

async function copyRoute() {
  const link = fixtureUrl();
  try {
    await navigator.clipboard.writeText(link);
    copyButton.textContent = "Route copied";
  } catch {
    const helper = document.createElement("textarea");
    helper.value = link;
    helper.readOnly = true;
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    document.body.append(helper);
    helper.select();
    document.execCommand?.("copy");
    helper.remove();
    copyButton.textContent = "Route selected";
  }
  announceEvent("route_copied", selectedScenario());
  window.setTimeout(() => { copyButton.textContent = "Copy route link"; }, 1800);
}

async function shareRoute() {
  const name = selectedScenario();
  const scenario = scenarios[name];
  const data = {
    title: "Shade Tree Protocol Lab",
    text: `${scenario.resultTitle}. Walk the recorded v4 protocol fixture:`,
    url: fixtureUrl(name),
  };

  if (navigator.share) {
    try {
      await navigator.share(data);
      announceEvent("route_shared", name);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  const intent = new URL("https://twitter.com/intent/tweet");
  intent.searchParams.set("text", `${data.text} ${data.url}`);
  window.open(intent, "_blank", "noopener,noreferrer");
  announceEvent("route_shared", name);
}

const requested = new URL(window.location.href).searchParams.get("scenario");
const initial = Object.hasOwn(scenarios, requested) ? requested : "invited-success";
const initialInput = form?.querySelector(`input[value="${initial}"]`);
if (initialInput) initialInput.checked = true;
resetTrace(initial);

form?.addEventListener("change", () => resetTrace(selectedScenario()));
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  walkTrace();
});
shareButton?.addEventListener("click", shareRoute);
copyButton?.addEventListener("click", copyRoute);
