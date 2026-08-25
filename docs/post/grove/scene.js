/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "../vendor/three-0.185.1/three.module.min.js";
import { groveArcCount, grovePatchCount } from "./visual-model.js";

const NIGHT = 0x07100c;
const CORE = 0x102219;
const BARK = 0x5a4934;
const LEAF = 0x68805c;
const LEAF_DARK = 0x405b43;
const LICHEN = 0xb9c5a3;
const SIGNAL = 0xe2be67;
const ALERT = 0xc47f58;
const UP = new THREE.Vector3(0, 1, 0);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SPHERE_RADIUS = 3.02;

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(value) {
  return 1 - ((1 - value) ** 3);
}

function fibonacciPoint(index, total, phase = 0) {
  const vertical = 1 - (2 * (index + 0.5)) / total;
  const radius = Math.sqrt(1 - vertical * vertical);
  const turn = index * GOLDEN_ANGLE + phase;
  return new THREE.Vector3(Math.cos(turn) * radius, vertical, Math.sin(turn) * radius);
}

function tangentBasis(normal) {
  const tangent = new THREE.Vector3(-normal.z, 0, normal.x);
  if (tangent.lengthSq() < 0.01) tangent.set(1, 0, 0);
  tangent.normalize();
  return [tangent, new THREE.Vector3().crossVectors(normal, tangent).normalize()];
}

function createCanopyField(snapshot, quality) {
  const lowQuality = quality === "low";
  const announced = snapshot.nodes.announced;
  const patchCount = grovePatchCount(announced, quality);
  const treesPerPatch = lowQuality ? 2 : 3;
  const treeCount = patchCount * treesPerPatch;
  const phase = seededRandom(hashSeed(`${snapshot.observedAt}:${announced}`))() * Math.PI * 2;
  const random = seededRandom(hashSeed(`${announced}:${snapshot.observedAt}:canopy`));
  const normals = Array.from({ length: patchCount }, (_, index) => fibonacciPoint(index, patchCount, phase));

  const group = new THREE.Group();
  group.name = "aggregate-canopy-field";
  const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, lowQuality ? 4 : 6, 1, false);
  const crownGeometry = new THREE.IcosahedronGeometry(1, lowQuality ? 0 : 1);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: BARK, flatShading: true, roughness: 1 });
  const crownMaterial = new THREE.MeshStandardMaterial({
    color: LEAF,
    emissive: LEAF_DARK,
    emissiveIntensity: 0.42,
    flatShading: true,
    roughness: 0.9,
  });
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, treeCount);
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, treeCount);
  trunks.frustumCulled = false;
  crowns.frustumCulled = false;

  const trunkMatrix = new THREE.Matrix4();
  const crownMatrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  let treeIndex = 0;

  normals.forEach((normal, patchIndex) => {
    const [tangent, bitangent] = tangentBasis(normal);
    for (let localIndex = 0; localIndex < treesPerPatch; localIndex += 1) {
      const spread = localIndex === 0 ? 0 : 0.12 + random() * 0.07;
      const turn = localIndex * GOLDEN_ANGLE + random() * 0.25;
      const offset = tangent.clone().multiplyScalar(Math.cos(turn) * spread)
        .add(bitangent.clone().multiplyScalar(Math.sin(turn) * spread));
      const base = normal.clone().multiplyScalar(SPHERE_RADIUS + 0.015).add(offset);
      const height = (lowQuality ? 0.25 : 0.29) + random() * 0.15;
      const trunkRadius = 0.025 + random() * 0.012;
      const crownSize = (lowQuality ? 0.115 : 0.13) + random() * 0.05;
      quaternion.setFromUnitVectors(UP, normal);

      scale.set(trunkRadius, height, trunkRadius);
      trunkMatrix.compose(base.clone().addScaledVector(normal, height * 0.5), quaternion, scale);
      trunks.setMatrixAt(treeIndex, trunkMatrix);

      scale.set(crownSize, crownSize * (0.86 + random() * 0.2), crownSize);
      crownMatrix.compose(base.clone().addScaledVector(normal, height + crownSize * 0.25), quaternion, scale);
      crowns.setMatrixAt(treeIndex, crownMatrix);
      color.setHex((patchIndex + localIndex) % 3 === 0 ? LEAF_DARK : LEAF).offsetHSL(0, 0, (random() - 0.5) * 0.09);
      crowns.setColorAt(treeIndex, color);
      treeIndex += 1;
    }
  });

  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  group.add(trunks, crowns);
  return { group, normals, patchCount };
}

function createArc(start, end, lift, lowQuality) {
  const midpoint = start.clone().add(end);
  if (midpoint.lengthSq() < 0.01) midpoint.copy(start).cross(new THREE.Vector3(0.2, 1, 0)).normalize();
  else midpoint.normalize();
  midpoint.multiplyScalar(SPHERE_RADIUS + lift);
  const curve = new THREE.QuadraticBezierCurve3(
    start.clone().multiplyScalar(SPHERE_RADIUS + 0.1),
    midpoint,
    end.clone().multiplyScalar(SPHERE_RADIUS + 0.1),
  );
  const geometry = new THREE.TubeGeometry(curve, lowQuality ? 18 : 34, lowQuality ? 0.012 : 0.016, 5, false);
  const material = new THREE.MeshBasicMaterial({
    color: SIGNAL,
    transparent: true,
    opacity: 0.2,
    depthTest: false,
    depthWrite: false,
  });
  return { curve, mesh: new THREE.Mesh(geometry, material) };
}

function createDataLayer(snapshot, quality) {
  const lowQuality = quality === "low";
  const field = createCanopyField(snapshot, quality);
  const group = new THREE.Group();
  group.name = "signed-aggregate-layer";
  group.add(field.group);

  const arcCount = groveArcCount(field.patchCount, quality);
  const arcs = [];
  const signals = [];
  const signalGeometry = new THREE.IcosahedronGeometry(lowQuality ? 0.045 : 0.06, 0);
  for (let index = 0; index < arcCount; index += 1) {
    const startIndex = (index * 5 + 1) % field.normals.length;
    const endIndex = (index * 9 + Math.floor(field.normals.length / 2) + 3) % field.normals.length;
    const record = createArc(field.normals[startIndex], field.normals[endIndex], 0.55 + (index % 3) * 0.18, lowQuality);
    record.mesh.material.color.setHex(index % 2 ? LEAF : SIGNAL);
    record.mesh.name = "census-arc";
    group.add(record.mesh);
    arcs.push(record);

    const material = new THREE.MeshBasicMaterial({ color: index % 2 ? LICHEN : SIGNAL, transparent: true, opacity: 0.82, depthTest: false });
    const signal = new THREE.Mesh(signalGeometry, material);
    signal.name = "aggregate-observation-signal";
    group.add(signal);
    signals.push({ mesh: signal, curve: record.curve, phase: (index / arcCount + 0.13) % 1 });
  }
  return { arcs, group, patchCount: field.patchCount, signals };
}

function createCanopySphere(quality) {
  const lowQuality = quality === "low";
  const group = new THREE.Group();
  group.name = "non-geographic-canopy-sphere";

  const glow = new THREE.Mesh(
    new THREE.IcosahedronGeometry(SPHERE_RADIUS * 1.055, lowQuality ? 2 : 3),
    new THREE.MeshBasicMaterial({ color: 0x446648, transparent: true, opacity: 0.055, side: THREE.BackSide, depthWrite: false }),
  );
  const coreGeometry = new THREE.IcosahedronGeometry(SPHERE_RADIUS, lowQuality ? 2 : 4);
  const core = new THREE.Mesh(coreGeometry, new THREE.MeshStandardMaterial({
    color: CORE,
    emissive: 0x162c1c,
    emissiveIntensity: 0.3,
    flatShading: true,
    metalness: 0.05,
    opacity: 0.8,
    roughness: 0.94,
    transparent: true,
  }));
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(SPHERE_RADIUS * 1.012, lowQuality ? 1 : 2)),
    new THREE.LineBasicMaterial({ color: LICHEN, transparent: true, opacity: lowQuality ? 0.07 : 0.085, depthWrite: false }),
  );

  const pointTotal = lowQuality ? 90 : 180;
  const pointPositions = new Float32Array(pointTotal * 3);
  for (let index = 0; index < pointTotal; index += 1) {
    const point = fibonacciPoint(index, pointTotal, 0.4).multiplyScalar(SPHERE_RADIUS * 1.025);
    point.toArray(pointPositions, index * 3);
  }
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
  const points = new THREE.Points(
    pointGeometry,
    new THREE.PointsMaterial({ color: LICHEN, size: lowQuality ? 0.028 : 0.038, transparent: true, opacity: 0.34, depthWrite: false }),
  );
  group.add(glow, core, wire, points);
  return group;
}

function createElderSatellite(quality) {
  const lowQuality = quality === "low";
  const group = new THREE.Group();
  group.name = "elder-discovery-satellite";
  group.position.set(4.05, -1.35, 0.25);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.9 });
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(lowQuality ? 0.12 : 0.15, 0), markerMaterial);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.3, lowQuality ? 24 : 48),
    new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -0.28;
  group.add(marker, ring);
  return { group, marker, markerMaterial, ring };
}

function disposeObject(object) {
  const geometries = new Set();
  const materials = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    const list = Array.isArray(child.material) ? child.material : [child.material];
    list.filter(Boolean).forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

export function mountNetworkGrove({ stage, canvas, snapshot, reducedMotion, quality = "high" }) {
  const lowQuality = quality === "low";
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: !lowQuality,
    canvas,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "default",
  });
  renderer.setClearColor(NIGHT, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowQuality ? 1 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
  camera.position.set(0.15, 0.05, 10.8);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xb9c5a3, 0x030705, lowQuality ? 1.8 : 2.15));
  const rimLight = new THREE.DirectionalLight(0xadcaa2, lowQuality ? 2.4 : 3.3);
  rimLight.position.set(-4, 6, 5);
  scene.add(rimLight);
  const amberLight = new THREE.PointLight(SIGNAL, lowQuality ? 5 : 7, 13, 2);
  amberLight.position.set(4, -1, 4);
  scene.add(amberLight);

  const networkObject = createCanopySphere(quality);
  let dataLayer = createDataLayer(snapshot, quality);
  networkObject.add(dataLayer.group);
  scene.add(networkObject);
  const elder = createElderSatellite(quality);
  scene.add(elder.group);

  const queryHalo = new THREE.Mesh(
    new THREE.RingGeometry(3.48, 3.52, lowQuality ? 64 : 128),
    new THREE.MeshBasicMaterial({ color: LICHEN, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  queryHalo.visible = false;
  scene.add(queryHalo);

  let currentSeed = `${snapshot.observedAt}:${snapshot.nodes.announced}`;
  let bornAt = reducedMotion ? -Infinity : window.performance.now();
  let stageVisible = true;
  let frameId = 0;
  let lastFrame = 0;
  let pointerX = 0;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let disposed = false;
  let softStartedAt = window.performance.now();
  let softOutcome = "ok";
  let strongStartedAt = -Infinity;

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const aspect = width / height;
    camera.aspect = aspect;
    camera.fov = aspect < 0.82 ? 43 : 38;
    camera.position.z = aspect < 0.82 ? 11.8 : 10.8;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function updateSignals(time) {
    const speed = reducedMotion ? 0 : time * 0.000035;
    dataLayer.signals.forEach((signal, index) => {
      const rawProgress = reducedMotion ? signal.phase : signal.phase + speed * (index % 2 ? -1 : 1);
      const progress = ((rawProgress % 1) + 1) % 1;
      signal.mesh.position.copy(signal.curve.getPoint(progress));
      const shimmer = reducedMotion ? 0.72 : 0.62 + Math.sin(time * 0.0013 + index * 1.7) * 0.26;
      signal.mesh.material.opacity = shimmer;
    });
  }

  function updateQueryPulse(time) {
    if (!Number.isFinite(softStartedAt)) {
      queryHalo.visible = false;
      return;
    }
    if (reducedMotion) {
      queryHalo.visible = softOutcome === "pending";
      queryHalo.material.opacity = softOutcome === "pending" ? 0.24 : 0;
      return;
    }
    const duration = softOutcome === "pending" ? 1450 : 1100;
    const progress = clamp((time - softStartedAt) / duration);
    queryHalo.visible = progress < 1;
    queryHalo.scale.setScalar(0.88 + easeOutCubic(progress) * 0.24);
    queryHalo.material.color.setHex(softOutcome === "error" ? ALERT : LICHEN);
    queryHalo.material.opacity = Math.sin(progress * Math.PI) * (softOutcome === "error" ? 0.5 : 0.3);
    elder.ring.scale.setScalar(1 + Math.sin(progress * Math.PI) * 0.5);
    if (progress >= 1) softStartedAt = -Infinity;
  }

  function updateStrongPulse(time) {
    const elapsed = time - strongStartedAt;
    const active = Number.isFinite(strongStartedAt) && elapsed >= 0 && elapsed < 1900;
    const envelope = active ? Math.sin((elapsed / 1900) * Math.PI) : 0;
    dataLayer.arcs.forEach((arc, index) => {
      arc.mesh.material.opacity = 0.19 + envelope * (0.32 + (index % 2) * 0.1);
    });
    elder.markerMaterial.opacity = 0.82 + envelope * 0.18;
    elder.marker.scale.setScalar(1 + envelope * 0.34);
    if (Number.isFinite(strongStartedAt) && !active && elapsed >= 1900) strongStartedAt = -Infinity;
  }

  function render(time = window.performance.now()) {
    smoothX += (pointerX - smoothX) * 0.045;
    smoothY += (pointerY - smoothY) * 0.045;
    const idleTurn = reducedMotion ? 0.28 : time * 0.000035;
    networkObject.rotation.y = idleTurn + smoothX * 0.2;
    networkObject.rotation.x = -0.08 + smoothY * 0.12;
    elder.group.rotation.z = reducedMotion ? 0 : Math.sin(time * 0.00055) * 0.08;
    const entrance = reducedMotion ? 1 : easeOutCubic(clamp((time - bornAt) / 900));
    networkObject.scale.setScalar(0.92 + entrance * 0.08);
    updateSignals(time);
    updateQueryPulse(time);
    updateStrongPulse(time);
    renderer.render(scene, camera);
  }

  function stopFrames() {
    if (!frameId) return;
    window.cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function scheduleFrame() {
    if (disposed || reducedMotion || frameId || !stageVisible || document.hidden) return;
    frameId = window.requestAnimationFrame(tick);
  }

  function tick(time) {
    frameId = 0;
    if (disposed || !stageVisible || document.hidden) return;
    const minimumFrame = lowQuality ? 50 : 34;
    if (time - lastFrame >= minimumFrame) {
      lastFrame = time;
      render(time);
    }
    scheduleFrame();
  }

  function onPointerMove(event) {
    if (event.pointerType === "touch") return;
    const bounds = stage.getBoundingClientRect();
    pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointerY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
  }

  function onPointerLeave() {
    pointerX = 0;
    pointerY = 0;
  }

  function onContextLost(event) {
    event.preventDefault();
    cleanup();
    stage.classList.remove("is-live");
  }

  function replaceSnapshot(nextSnapshot) {
    const nextSeed = `${nextSnapshot.observedAt}:${nextSnapshot.nodes.announced}`;
    if (disposed || nextSeed === currentSeed) return;
    networkObject.remove(dataLayer.group);
    disposeObject(dataLayer.group);
    dataLayer = createDataLayer(nextSnapshot, quality);
    networkObject.add(dataLayer.group);
    currentSeed = nextSeed;
    bornAt = reducedMotion ? -Infinity : window.performance.now();
    render();
  }

  function beginQuery() {
    if (disposed) return;
    softStartedAt = window.performance.now();
    softOutcome = "pending";
    if (reducedMotion) render();
  }

  function finishQuery(nextSnapshot, { freshCensus = false } = {}) {
    if (disposed) return;
    replaceSnapshot(nextSnapshot);
    if (!Number.isFinite(softStartedAt)) softStartedAt = window.performance.now();
    softOutcome = "ok";
    if (freshCensus) strongStartedAt = window.performance.now();
    if (reducedMotion) render();
  }

  function failQuery() {
    if (disposed) return;
    if (!Number.isFinite(softStartedAt)) softStartedAt = window.performance.now();
    softOutcome = "error";
    if (reducedMotion) render();
  }

  resize();
  render();
  stage.classList.add("is-live");
  const resizer = "ResizeObserver" in window ? new ResizeObserver(() => { resize(); if (reducedMotion) render(); }) : null;
  resizer?.observe(stage);
  const visibility = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    stageVisible = entries.some((entry) => entry.isIntersecting);
    if (stageVisible) {
      lastFrame = 0;
      scheduleFrame();
    } else {
      stopFrames();
    }
  }) : null;
  visibility?.observe(stage);
  canvas.addEventListener("webglcontextlost", onContextLost, { once: true });

  function onVisibilityChange() {
    if (document.hidden) {
      stopFrames();
      return;
    }
    lastFrame = 0;
    scheduleFrame();
  }

  function onPageHide(event) {
    if (event.persisted) {
      stopFrames();
      return;
    }
    cleanup();
  }

  function onPageShow(event) {
    if (!event.persisted) return;
    lastFrame = 0;
    scheduleFrame();
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    stopFrames();
    resizer?.disconnect();
    visibility?.disconnect();
    canvas.removeEventListener("webglcontextlost", onContextLost);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerleave", onPointerLeave);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    disposeObject(scene);
    renderer.dispose();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  if (!reducedMotion) {
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", onPointerLeave, { passive: true });
    scheduleFrame();
  }

  return {
    beginQuery,
    failQuery,
    finishQuery,
    updateSnapshot: replaceSnapshot,
  };
}
