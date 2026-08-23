/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "../vendor/three-0.185.1/three.module.min.js";

const NIGHT = 0x101712;
const GROUND = 0x172219;
const BARK = 0x4b4235;
const LEAVES = [0x43543e, 0x56684a, 0x687858, 0x7e8965, 0x91a078];
const UP = new THREE.Vector3(0, 1, 0);
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

function branchTransform(dummy, start, end, radius) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  dummy.position.copy(start).add(end).multiplyScalar(0.5);
  dummy.quaternion.setFromUnitVectors(UP, direction.normalize());
  dummy.scale.set(radius, length, radius);
  dummy.updateMatrix();
}

function generatedTrees(snapshot) {
  const exact = snapshot.nodes.announced;
  const count = Math.min(exact, 48);
  const random = seededRandom(hashSeed(`${snapshot.observedAt}:${count}`));
  const trees = [];
  for (let index = 0; index < count; index += 1) {
    const angle = index * GOLDEN_ANGLE + random() * 0.65;
    const progress = Math.sqrt((index + 0.75) / Math.max(1, count));
    const reach = count <= 3 ? 2.45 : 2 + Math.min(5.4, Math.sqrt(count) * 0.78);
    const radius = count === 1 ? 2.2 : 1.55 + progress * reach;
    const crown = Math.max(0.74, Math.min(2.05, 2.45 - Math.sqrt(count) * 0.16 + random() * 0.32));
    trees.push({
      x: Math.cos(angle) * radius + (random() - 0.5) * 0.45,
      z: Math.sin(angle) * radius + (random() - 0.5) * 0.45,
      height: 2.8 + random() * 1.45,
      crown,
      seed: Math.floor(random() * 0xffffffff),
    });
  }
  return trees;
}

function addGrove(scene, snapshot) {
  const grove = new THREE.Group();
  const trees = generatedTrees(snapshot);
  const dummy = new THREE.Object3D();
  const branchGeometry = new THREE.CylinderGeometry(1, 1.18, 1, 5, 1, false);
  const branchMaterial = new THREE.MeshStandardMaterial({ color: BARK, flatShading: true, roughness: 1 });
  const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, Math.max(1, trees.length));
  branches.castShadow = true;

  const lobes = [];
  const rootPoints = [];
  trees.forEach((tree, index) => {
    const random = seededRandom(tree.seed);
    branchTransform(dummy, new THREE.Vector3(tree.x, 0, tree.z), new THREE.Vector3(tree.x, tree.height, tree.z), 0.16 + tree.crown * 0.03);
    branches.setMatrixAt(index, dummy.matrix);
    const lobeCount = trees.length > 24 ? 7 : 11;
    for (let lobe = 0; lobe < lobeCount; lobe += 1) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * tree.crown * 0.76;
      const size = tree.crown * (0.42 + random() * 0.2);
      lobes.push({
        x: tree.x + Math.cos(angle) * distance,
        y: tree.height + (1 - distance / tree.crown) * 0.6 + (random() - 0.5) * 0.4,
        z: tree.z + Math.sin(angle) * distance,
        size,
        sy: size * (0.6 + random() * 0.2),
        color: LEAVES[Math.floor(random() * LEAVES.length)],
        rx: random() * Math.PI,
        ry: random() * Math.PI,
      });
    }

    let previous = new THREE.Vector3(0, 0.022, 0);
    for (let segment = 1; segment <= 6; segment += 1) {
      const progress = segment / 6;
      const bend = Math.sin(progress * Math.PI) * ((index % 2 ? 1 : -1) * 0.22 + (random() - 0.5) * 0.2);
      const next = new THREE.Vector3(
        tree.x * progress - tree.z * bend,
        0.022,
        tree.z * progress + tree.x * bend,
      );
      rootPoints.push(previous, next);
      previous = next;
    }
  });

  if (trees.length) {
    branches.instanceMatrix.needsUpdate = true;
    grove.add(branches);
  }

  const canopyGeometry = new THREE.IcosahedronGeometry(1, 1);
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.92 });
  const canopy = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, Math.max(1, lobes.length));
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  lobes.forEach((lobe, index) => {
    dummy.position.set(lobe.x, lobe.y, lobe.z);
    dummy.rotation.set(lobe.rx, lobe.ry, 0);
    dummy.scale.set(lobe.size, lobe.sy, lobe.size);
    dummy.updateMatrix();
    canopy.setMatrixAt(index, dummy.matrix);
    canopy.setColorAt(index, new THREE.Color(lobe.color));
  });
  if (lobes.length) {
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    grove.add(canopy);
  }

  const roots = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(rootPoints),
    new THREE.LineBasicMaterial({ color: 0xd1bd83, transparent: true, opacity: 0.22 }),
  );
  grove.add(roots);

  const clearing = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 48),
    new THREE.MeshBasicMaterial({ color: 0xd1bd83, transparent: true, opacity: 0.78, side: THREE.DoubleSide }),
  );
  clearing.rotation.x = -Math.PI / 2;
  clearing.position.y = 0.025;
  grove.add(clearing);
  scene.add(grove);
  return { grove, roots, extent: trees.length <= 3 ? 6.8 : Math.min(12, 7 + Math.sqrt(trees.length) * 0.65) };
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => material.dispose());
  });
}

export function mountNetworkGrove({ stage, canvas, snapshot, reducedMotion }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: true,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.Fog(NIGHT, 13, 30);

  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 50);
  camera.position.set(0, 15.5, 4.8);
  camera.lookAt(0, 0.4, 0);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 30),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new THREE.HemisphereLight(0xc0c9a7, 0x070b08, 1.9));
  const sun = new THREE.DirectionalLight(0xe8d49a, 4.4);
  const sunBase = new THREE.Vector3(-6, 12, 7);
  sun.position.copy(sunBase);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 35;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  let { grove, roots, extent } = addGrove(scene, snapshot);
  let stageVisible = true;
  let frameId = 0;
  let lastFrame = 0;
  let pointerX = 0;
  let pointerZ = 0;
  let smoothX = 0;
  let smoothZ = 0;
  let disposed = false;
  let pulseStartedAt = window.performance.now();

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const aspect = width / height;
    const viewHeight = extent;
    camera.left = -(viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function render(time = window.performance.now()) {
    smoothX += (pointerX - smoothX) * 0.045;
    smoothZ += (pointerZ - smoothZ) * 0.045;
    const idle = reducedMotion ? 0 : Math.sin(time * 0.00017) * 0.5;
    sun.position.x = sunBase.x + smoothX * 3 + idle;
    sun.position.z = sunBase.z + smoothZ * 2;
    // One load pulse marks a new aggregate snapshot; it settles into a quiet root layer and is
    // never tied to traffic or heartbeat events.
    roots.material.opacity = reducedMotion ? 0.2 : 0.2 + Math.max(0, 0.58 * (1 - (time - pulseStartedAt) / 4200));
    renderer.render(scene, camera);
  }

  function tick(time) {
    if (disposed) return;
    frameId = window.requestAnimationFrame(tick);
    if (!stageVisible || document.hidden || time - lastFrame < 42) return;
    lastFrame = time;
    render(time);
  }

  function onPointerMove(event) {
    if (event.pointerType === "touch") return;
    const bounds = stage.getBoundingClientRect();
    pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointerZ = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
  }

  function onContextLost(event) {
    event.preventDefault();
    disposed = true;
    stage.classList.remove("is-live");
    window.cancelAnimationFrame(frameId);
  }

  function updateSnapshot(nextSnapshot) {
    if (disposed) return;
    scene.remove(grove);
    disposeObject(grove);
    ({ grove, roots, extent } = addGrove(scene, nextSnapshot));
    pulseStartedAt = window.performance.now();
    resize();
    render();
  }

  resize();
  render();
  stage.classList.add("is-live");
  const resizer = "ResizeObserver" in window ? new ResizeObserver(() => { resize(); if (reducedMotion) render(); }) : null;
  resizer?.observe(stage);
  const visibility = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    stageVisible = entries.some((entry) => entry.isIntersecting);
  }) : null;
  visibility?.observe(stage);
  canvas.addEventListener("webglcontextlost", onContextLost, { once: true });

  if (!reducedMotion) {
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", () => { pointerX = 0; pointerZ = 0; }, { passive: true });
    frameId = window.requestAnimationFrame(tick);
  }

  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    disposed = true;
    window.cancelAnimationFrame(frameId);
    resizer?.disconnect();
    visibility?.disconnect();
    disposeObject(scene);
    renderer.dispose();
  }, { once: true });

  return { updateSnapshot };
}
