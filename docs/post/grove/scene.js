/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "../vendor/three-0.185.1/three.module.min.js";

const NIGHT = 0x08100b;
const GROUND = 0x101a12;
const BARK = 0x4a3d2f;
const ELDER_BARK = 0x6a5940;
const LEAVES = [0x344634, 0x40543a, 0x506244, 0x637452, 0x788564];
const ELDER_LEAVES = [0x5f7151, 0x74815d, 0x89936b];
const LICHEN = 0xb9c5a3;
const SIGNAL = 0xd7b766;
const ALERT = 0xc47f58;
const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3(0, 0.08, 0);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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

function growthCurve(value) {
  const progress = clamp(value);
  const overshoot = 1.25;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * (shifted ** 3) + overshoot * (shifted ** 2);
}

function branchTransform(mesh, start, end, radius) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  mesh.scale.set(radius, length, radius);
}

function createTreeAssets(quality, { elder = false } = {}) {
  const low = quality === "low";
  const leafColors = elder ? ELDER_LEAVES : LEAVES;
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: elder ? ELDER_BARK : BARK,
    flatShading: true,
    roughness: 1,
  });
  const leafMaterials = leafColors.map((color) => new THREE.MeshStandardMaterial({
    color,
    emissive: SIGNAL,
    emissiveIntensity: 0,
    flatShading: true,
    roughness: 0.94,
  }));
  const trunkGeometry = new THREE.CylinderGeometry(0.72, 1, 1, low ? 5 : 7, 1, false);
  const branchGeometry = new THREE.CylinderGeometry(0.7, 1, 1, 5, 1, false);
  const crownGeometry = new THREE.IcosahedronGeometry(1, low ? 0 : 1);
  return {
    branchGeometry,
    crownGeometry,
    leafMaterials,
    resources: [trunkGeometry, branchGeometry, crownGeometry, trunkMaterial, ...leafMaterials],
    trunkGeometry,
    trunkMaterial,
  };
}

function generatedTrees(snapshot, quality) {
  const announced = snapshot.nodes.announced;
  const visibleCount = Math.min(announced, quality === "low" ? 24 : 48);
  const random = seededRandom(hashSeed(`${snapshot.observedAt}:${announced}`));
  const trees = [];
  for (let index = 0; index < visibleCount; index += 1) {
    const progress = Math.sqrt((index + 0.8) / Math.max(1, visibleCount));
    const angle = index * GOLDEN_ANGLE + random() * 0.52;
    const reach = visibleCount <= 3 ? 2 : 2.1 + Math.min(5.2, Math.sqrt(visibleCount) * 0.72);
    const radius = 2.65 + progress * reach;
    const crown = Math.max(0.72, Math.min(1.35, 1.42 - Math.sqrt(visibleCount) * 0.055 + random() * 0.2));
    trees.push({
      crown,
      height: 2.45 + random() * 1.25,
      index,
      leaf: Math.floor(random() * LEAVES.length),
      seed: Math.floor(random() * 0xffffffff),
      x: Math.cos(angle) * radius * 1.08 + (random() - 0.5) * 0.35,
      z: Math.sin(angle) * radius * 0.9 + (random() - 0.5) * 0.35,
    });
  }
  return trees;
}

function buildTree(spec, assets, quality, { elder = false } = {}) {
  const group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);
  group.userData.index = spec.index;

  const trunk = new THREE.Mesh(assets.trunkGeometry, assets.trunkMaterial);
  trunk.position.y = spec.height * 0.5;
  trunk.scale.set(elder ? 0.36 : 0.2, spec.height, elder ? 0.36 : 0.2);
  trunk.castShadow = quality !== "low";
  trunk.receiveShadow = true;
  group.add(trunk);

  const random = elder ? null : seededRandom(spec.seed);
  const branchCount = elder ? 8 : quality === "low" ? 3 : 5;
  for (let index = 0; index < branchCount; index += 1) {
    const turn = elder
      ? index * GOLDEN_ANGLE + 0.25
      : random() * Math.PI * 2;
    const lift = elder
      ? spec.height * (0.48 + (index % 4) * 0.075)
      : spec.height * (0.54 + random() * 0.26);
    const reach = spec.crown * (elder ? 0.78 + (index % 3) * 0.13 : 0.58 + random() * 0.35);
    const start = new THREE.Vector3(0, lift, 0);
    const end = new THREE.Vector3(
      Math.cos(turn) * reach,
      lift + spec.crown * (0.38 + (elder ? (index % 2) * 0.09 : random() * 0.2)),
      Math.sin(turn) * reach,
    );
    const branch = new THREE.Mesh(assets.branchGeometry, assets.trunkMaterial);
    branchTransform(branch, start, end, elder ? 0.12 : 0.075);
    branch.castShadow = quality !== "low";
    group.add(branch);
  }

  const lobeCount = elder ? (quality === "low" ? 7 : 11) : (quality === "low" ? 3 : 5);
  for (let index = 0; index < lobeCount; index += 1) {
    const turn = elder
      ? index * GOLDEN_ANGLE
      : random() * Math.PI * 2;
    const ring = index === 0 ? 0 : Math.sqrt(index / Math.max(1, lobeCount - 1));
    const distance = spec.crown * ring * (elder ? 0.9 : 0.72);
    const sizeNoise = elder ? ((index % 3) * 0.045) : random() * 0.15;
    const lobe = new THREE.Mesh(
      assets.crownGeometry,
      assets.leafMaterials[(spec.leaf + index) % assets.leafMaterials.length],
    );
    lobe.position.set(
      Math.cos(turn) * distance,
      spec.height + spec.crown * (0.32 + (1 - ring) * 0.52),
      Math.sin(turn) * distance,
    );
    lobe.rotation.set(index * 0.29, turn * 0.37, index * 0.17);
    const size = spec.crown * (elder ? 0.62 : 0.56) + sizeNoise;
    lobe.scale.set(size, size * (elder ? 0.76 : 0.9), size);
    lobe.castShadow = quality !== "low";
    lobe.receiveShadow = true;
    group.add(lobe);
  }

  return group;
}

function addElderTree(scene, quality) {
  const assets = createTreeAssets(quality, { elder: true });
  const elder = buildTree({
    crown: 1.72,
    height: 5.35,
    index: -1,
    leaf: 0,
    x: 0,
    z: 0,
  }, assets, quality, { elder: true });
  elder.name = "elder-tree-uncounted";
  scene.add(elder);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.63, quality === "low" ? 32 : 64),
    new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.42, side: THREE.DoubleSide }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.035;
  elder.add(marker);
  return { assets, elder };
}

function addAnnouncedGrove(scene, snapshot, quality) {
  const assets = createTreeAssets(quality);
  const group = new THREE.Group();
  group.name = "announced-trees";
  const treeSpecs = generatedTrees(snapshot, quality);
  const trees = treeSpecs.map((spec) => {
    const tree = buildTree(spec, assets, quality);
    tree.scale.setScalar(0.001);
    group.add(tree);
    return tree;
  });

  const rootPoints = [];
  treeSpecs.forEach((tree, index) => {
    const bend = (index % 2 ? 1 : -1) * (0.12 + (index % 4) * 0.035);
    const middle = new THREE.Vector3(tree.x * 0.48 - tree.z * bend, 0.06, tree.z * 0.48 + tree.x * bend);
    const end = new THREE.Vector3(tree.x, 0.06, tree.z);
    rootPoints.push(ORIGIN, middle, middle, end);
  });
  const rootGeometry = new THREE.BufferGeometry().setFromPoints(rootPoints);
  const rootMaterial = new THREE.LineDashedMaterial({ color: SIGNAL, transparent: true, opacity: 0.2, dashSize: 0.18, gapSize: 0.12 });
  const roots = new THREE.LineSegments(rootGeometry, rootMaterial);
  roots.computeLineDistances();
  group.add(roots);
  scene.add(group);

  const maxRadius = treeSpecs.reduce((maximum, tree) => Math.max(maximum, Math.hypot(tree.x, tree.z)), 3.4);
  return {
    assets,
    extent: Math.max(10.5, Math.min(15, maxRadius * 2.05 + 2.2)),
    group,
    resources: [rootGeometry, rootMaterial],
    roots,
    specs: treeSpecs,
    trees,
  };
}

function addCensusSignal(scene, specs, quality) {
  const group = new THREE.Group();
  group.name = "census-pulse";
  const dotGeometry = new THREE.IcosahedronGeometry(quality === "low" ? 0.075 : 0.095, 0);
  const dotMaterial = new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.92 });
  const dots = new THREE.InstancedMesh(dotGeometry, dotMaterial, Math.max(1, specs.length));
  dots.count = specs.length;
  dots.frustumCulled = false;
  dots.visible = false;
  group.add(dots);
  scene.add(group);
  return { dotGeometry, dotMaterial, dots, group, specs };
}

function disposeResources(resources) {
  const disposed = new Set();
  resources.flat().forEach((resource) => {
    if (!resource || disposed.has(resource)) return;
    disposed.add(resource);
    resource.dispose?.();
  });
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
    alpha: false,
    antialias: !lowQuality,
    canvas,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "default",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowQuality ? 1 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = !lowQuality;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.Fog(NIGHT, 14, 31);

  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 60);
  camera.position.set(10.5, 10.8, 12.5);
  camera.lookAt(0, 1.55, 0);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(21, lowQuality ? 48 : 96),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new THREE.HemisphereLight(0xb9c5a3, 0x040805, lowQuality ? 2.1 : 1.8));
  const sun = new THREE.DirectionalLight(0xe6d6aa, lowQuality ? 3 : 4.1);
  const sunBase = new THREE.Vector3(-7, 13, 8);
  sun.position.copy(sunBase);
  sun.castShadow = !lowQuality;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 38;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.target.position.set(0, 1.2, 0);
  scene.add(sun, sun.target);

  const elderRecord = addElderTree(scene, quality);
  let groveRecord = addAnnouncedGrove(scene, snapshot, quality);
  let censusSignal = addCensusSignal(scene, groveRecord.specs, quality);
  let currentSeed = `${snapshot.observedAt}:${snapshot.nodes.announced}`;
  let groveBornAt = reducedMotion ? -Infinity : window.performance.now();

  const queryRing = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.79, lowQuality ? 36 : 72),
    new THREE.MeshBasicMaterial({ color: LICHEN, transparent: true, opacity: 0, side: THREE.DoubleSide }),
  );
  queryRing.rotation.x = -Math.PI / 2;
  queryRing.position.y = 0.065;
  queryRing.visible = false;
  scene.add(queryRing);

  const signalLight = new THREE.PointLight(SIGNAL, 0, 7, 2);
  signalLight.position.set(0, 0.7, 0);
  scene.add(signalLight);

  let stageVisible = true;
  let frameId = 0;
  let lastFrame = 0;
  let pointerX = 0;
  let pointerZ = 0;
  let smoothX = 0;
  let smoothZ = 0;
  let disposed = false;
  let softStartedAt = -Infinity;
  let softOutcome = "idle";
  let strongStartedAt = -Infinity;
  const dummy = new THREE.Object3D();

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const aspect = width / height;
    const viewHeight = aspect < 1
      ? groveRecord.extent / Math.max(0.34, aspect)
      : groveRecord.extent;
    camera.left = -(viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function updateTreeGrowth(time) {
    groveRecord.trees.forEach((tree, index) => {
      const delay = index * (lowQuality ? 54 : 42);
      const progress = reducedMotion ? 1 : (time - groveBornAt - delay) / 720;
      let scale = growthCurve(progress);
      if (Number.isFinite(strongStartedAt)) {
        const arrival = 510 + index * (lowQuality ? 22 : 16);
        const echo = clamp((time - strongStartedAt - arrival) / 620);
        scale *= 1 + Math.sin(echo * Math.PI) * 0.055;
      }
      tree.scale.setScalar(Math.max(0.001, scale));
    });
  }

  function updateSoftPulse(time) {
    if (!Number.isFinite(softStartedAt)) {
      queryRing.visible = false;
      return;
    }
    if (reducedMotion) {
      queryRing.visible = softOutcome === "pending";
      queryRing.scale.setScalar(1);
      queryRing.material.opacity = softOutcome === "pending" ? 0.28 : 0;
      return;
    }
    const duration = softOutcome === "pending" ? 1450 : 1050;
    const progress = clamp((time - softStartedAt) / duration);
    queryRing.visible = progress < 1;
    queryRing.scale.setScalar(0.82 + easeOutCubic(progress) * 3.4);
    queryRing.material.opacity = Math.sin(progress * Math.PI) * (softOutcome === "error" ? 0.48 : 0.34);
    queryRing.material.color.setHex(softOutcome === "error" ? ALERT : LICHEN);
    if (progress >= 1) softStartedAt = -Infinity;
  }

  function updateStrongPulse(time) {
    if (!Number.isFinite(strongStartedAt)) {
      censusSignal.dots.visible = false;
      groveRecord.roots.material.opacity = 0.2;
      signalLight.intensity = 0;
      return;
    }
    if (reducedMotion) {
      censusSignal.dots.visible = false;
      groveRecord.roots.material.opacity = 0.25;
      signalLight.intensity = 0;
      return;
    }
    const elapsed = time - strongStartedAt;
    const total = 1500 + censusSignal.specs.length * 18;
    const envelope = Math.sin(clamp(elapsed / total) * Math.PI);
    groveRecord.roots.material.opacity = 0.2 + envelope * 0.6;
    signalLight.intensity = envelope * 2.2;
    censusSignal.dots.visible = elapsed >= 0 && elapsed < total;
    censusSignal.specs.forEach((spec, index) => {
      const delay = index * (lowQuality ? 22 : 16);
      const progress = clamp((elapsed - delay) / 720);
      dummy.position.set(
        ORIGIN.x + (spec.x - ORIGIN.x) * easeOutCubic(progress),
        0.11 + Math.sin(progress * Math.PI) * 0.16,
        ORIGIN.z + (spec.z - ORIGIN.z) * easeOutCubic(progress),
      );
      const scale = progress <= 0 || progress >= 1 ? 0.001 : Math.sin(progress * Math.PI);
      dummy.scale.setScalar(scale);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      censusSignal.dots.setMatrixAt(index, dummy.matrix);
    });
    censusSignal.dots.instanceMatrix.needsUpdate = true;
    elderRecord.assets.leafMaterials.forEach((material) => {
      material.emissiveIntensity = envelope * 0.2;
    });
    groveRecord.assets.leafMaterials.forEach((material) => {
      material.emissiveIntensity = envelope * 0.12;
    });
    if (elapsed >= total) {
      strongStartedAt = -Infinity;
      censusSignal.dots.visible = false;
      groveRecord.roots.material.opacity = 0.2;
      signalLight.intensity = 0;
      elderRecord.assets.leafMaterials.forEach((material) => { material.emissiveIntensity = 0; });
      groveRecord.assets.leafMaterials.forEach((material) => { material.emissiveIntensity = 0; });
    }
  }

  function render(time = window.performance.now()) {
    smoothX += (pointerX - smoothX) * 0.045;
    smoothZ += (pointerZ - smoothZ) * 0.045;
    const idle = reducedMotion ? 0 : Math.sin(time * 0.00017) * 0.42;
    sun.position.x = sunBase.x + smoothX * 2.6 + idle;
    sun.position.z = sunBase.z + smoothZ * 2;
    updateTreeGrowth(time);
    updateSoftPulse(time);
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
    pointerZ = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
  }

  function onPointerLeave() {
    pointerX = 0;
    pointerZ = 0;
  }

  function onContextLost(event) {
    event.preventDefault();
    cleanup();
    stage.classList.remove("is-live");
  }

  function replaceSnapshot(nextSnapshot) {
    const nextSeed = `${nextSnapshot.observedAt}:${nextSnapshot.nodes.announced}`;
    if (disposed || nextSeed === currentSeed) return;
    scene.remove(groveRecord.group, censusSignal.group);
    disposeResources([
      groveRecord.assets.resources,
      groveRecord.resources,
      censusSignal.dotGeometry,
      censusSignal.dotMaterial,
    ]);
    groveRecord = addAnnouncedGrove(scene, nextSnapshot, quality);
    censusSignal = addCensusSignal(scene, groveRecord.specs, quality);
    currentSeed = nextSeed;
    groveBornAt = reducedMotion ? -Infinity : window.performance.now();
    strongStartedAt = -Infinity;
    resize();
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
  if (reducedMotion) groveRecord.trees.forEach((tree) => tree.scale.setScalar(1));
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
