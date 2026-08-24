/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "./vendor/three-0.185.1/three.module.min.js";

const NIGHT = 0x07100c;
const GROUND = 0x16261c;
const SHADE = 0x06100b;
const BARK = 0x5b4632;
const LEAF_COLORS = [0x294a37, 0x365b42, 0x456a4b, 0x55785a, 0x314f3b];
const STREAM = 0xe2ba5a;
const TRAIL = 0x71846d;
const UP = new THREE.Vector3(0, 1, 0);

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

function easeOutCubic(value) {
  return 1 - ((1 - value) ** 3);
}

function easeInOutCubic(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function branchTransform(dummy, start, end, radius) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  dummy.position.copy(start).add(end).multiplyScalar(0.5);
  dummy.quaternion.setFromUnitVectors(UP, direction.normalize());
  dummy.scale.set(radius, length, radius);
  dummy.updateMatrix();
}

function buildTreeLayout(mobile) {
  const random = seededRandom(mobile ? 617 : 911);
  const targetCount = mobile ? 18 : 29;
  const centerX = mobile ? 0 : 5.2;
  const centerZ = mobile ? 2.2 : -0.8;
  const radiusX = mobile ? 5.8 : 12.4;
  const radiusZ = mobile ? 9.4 : 8.1;
  const minDistance = mobile ? 1.55 : 1.65;
  const trees = [];

  for (let attempt = 0; attempt < 900 && trees.length < targetCount - 1; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random());
    const x = centerX + Math.cos(angle) * radiusX * radius + (random() - 0.5) * 0.8;
    const z = centerZ + Math.sin(angle) * radiusZ * radius + (random() - 0.5) * 0.8;

    const inCopyClearing = mobile ? z < -4.6 : x < -2.8 && Math.abs(z) < 4.2;
    const crowded = trees.some((tree) => Math.hypot(tree.x - x, tree.z - z) < minDistance);
    if (inCopyClearing || crowded) continue;

    const height = 2.5 + random() * 1.8;
    trees.push({
      x,
      z,
      height,
      crown: 1.05 + random() * 0.65,
      lean: (random() - 0.5) * 0.22,
      seed: Math.floor(random() * 100_000),
      selected: false,
    });
  }

  trees.push({
    x: mobile ? 0.2 : 13.2,
    z: mobile ? 9.2 : -4.6,
    height: mobile ? 4.2 : 4.7,
    crown: mobile ? 1.8 : 2.05,
    lean: 0.04,
    seed: 41_203,
    selected: true,
  });

  return trees;
}

function createShadePatch(scene, mobile) {
  const random = seededRandom(mobile ? 73 : 39);
  const centerX = mobile ? 0 : 5.1;
  const centerZ = mobile ? 2.1 : -0.7;
  const radiusX = mobile ? 7 : 14.1;
  const radiusZ = mobile ? 10.8 : 9.2;
  const shape = new THREE.Shape();

  for (let index = 0; index < 16; index += 1) {
    const angle = (index / 16) * Math.PI * 2;
    const wobble = 0.88 + random() * 0.2;
    const x = centerX + Math.cos(angle) * radiusX * wobble;
    const z = centerZ + Math.sin(angle) * radiusZ * wobble;
    if (index === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  }
  shape.closePath();

  const patch = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: SHADE, transparent: true, opacity: 0.78 }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.y = 0.018;
  scene.add(patch);

  const rayMaterial = new THREE.MeshBasicMaterial({
    color: STREAM,
    transparent: true,
    opacity: mobile ? 0.07 : 0.1,
    depthWrite: false,
  });
  const rayCount = mobile ? 3 : 5;
  for (let index = 0; index < rayCount; index += 1) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(0.055, mobile ? 8 : 12), rayMaterial);
    ray.rotation.set(-Math.PI / 2, 0, mobile ? -0.08 : -0.26);
    ray.position.set(
      mobile ? -3.7 + index * 2.1 : -13.5 + index * 2.25,
      0.026,
      mobile ? -7.2 + index * 0.7 : 5.7 - index * 0.75,
    );
    scene.add(ray);
  }
}

function createGrove(scene, mobile) {
  const trees = buildTreeLayout(mobile);
  const branchGeometry = new THREE.CylinderGeometry(1, 1.28, 1, 5, 1, false);
  const branchMaterial = new THREE.MeshStandardMaterial({
    color: BARK,
    flatShading: true,
    roughness: 0.96,
  });
  const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, trees.length * 3);
  branches.castShadow = !mobile;
  branches.receiveShadow = true;

  const crownRecords = [];
  const dummy = new THREE.Object3D();
  let branchIndex = 0;

  for (const tree of trees) {
    const random = seededRandom(tree.seed);
    const base = new THREE.Vector3(tree.x, 0, tree.z);
    const top = new THREE.Vector3(tree.x + tree.lean, tree.height, tree.z - tree.lean * 0.4);
    branchTransform(dummy, base, top, 0.18 + tree.height * 0.015);
    branches.setMatrixAt(branchIndex++, dummy.matrix);

    for (const side of [-1, 1]) {
      const branchStart = new THREE.Vector3(
        tree.x + tree.lean * 0.65,
        tree.height * (0.64 + random() * 0.08),
        tree.z,
      );
      const branchEnd = new THREE.Vector3(
        tree.x + side * tree.crown * (0.48 + random() * 0.12),
        tree.height + tree.crown * (0.06 + random() * 0.11),
        tree.z + (random() - 0.5) * tree.crown * 0.42,
      );
      branchTransform(dummy, branchStart, branchEnd, 0.09 + tree.crown * 0.012);
      branches.setMatrixAt(branchIndex++, dummy.matrix);
    }

    const centerColor = tree.selected ? 0x648467 : LEAF_COLORS[Math.floor(random() * LEAF_COLORS.length)];
    crownRecords.push({
      x: tree.x + tree.lean,
      y: tree.height + tree.crown * 0.34,
      z: tree.z,
      sx: tree.crown,
      sy: tree.crown * 0.58,
      sz: tree.crown * 0.94,
      color: centerColor,
      rotation: random() * Math.PI,
    });

    for (const side of [-1, 1]) {
      crownRecords.push({
        x: tree.x + side * tree.crown * (0.54 + random() * 0.08),
        y: tree.height + tree.crown * (0.12 + random() * 0.13),
        z: tree.z + (random() - 0.5) * tree.crown * 0.42,
        sx: tree.crown * (0.7 + random() * 0.08),
        sy: tree.crown * (0.43 + random() * 0.07),
        sz: tree.crown * (0.65 + random() * 0.1),
        color: tree.selected ? 0x55785a : LEAF_COLORS[Math.floor(random() * LEAF_COLORS.length)],
        rotation: random() * Math.PI,
      });
    }
  }

  branches.instanceMatrix.needsUpdate = true;

  const crownGeometry = new THREE.SphereGeometry(1, 7, 5);
  const crownMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: true,
    roughness: 0.88,
    metalness: 0,
  });
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, crownRecords.length);
  crowns.castShadow = !mobile;
  crowns.receiveShadow = true;

  for (let index = 0; index < crownRecords.length; index += 1) {
    const crown = crownRecords[index];
    dummy.position.set(crown.x, crown.y, crown.z);
    dummy.rotation.set(0, crown.rotation, 0);
    dummy.scale.set(crown.sx, crown.sy, crown.sz);
    dummy.updateMatrix();
    crowns.setMatrixAt(index, dummy.matrix);
    crowns.setColorAt(index, new THREE.Color(crown.color));
  }
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

  const grove = new THREE.Group();
  grove.add(branches, crowns);
  grove.scale.y = 0.02;
  scene.add(grove);

  const selectedTree = trees.at(-1);
  const selection = new THREE.Mesh(
    new THREE.RingGeometry(selectedTree.crown * 0.72, selectedTree.crown * 0.84, 24),
    new THREE.MeshBasicMaterial({
      color: STREAM,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
    }),
  );
  selection.rotation.x = -Math.PI / 2;
  selection.position.set(selectedTree.x, 0.08, selectedTree.z);
  scene.add(selection);

  return grove;
}

function createDataStream(scene, mobile) {
  const knots = mobile ? [
    new THREE.Vector3(3.0, 0.34, -10.5),
    new THREE.Vector3(3.5, 0.36, -7.1),
    new THREE.Vector3(2.2, 0.34, -4.2),
    new THREE.Vector3(2.8, 0.36, -1.2),
    new THREE.Vector3(1.0, 0.34, 2.0),
    new THREE.Vector3(1.2, 0.36, 5.2),
    new THREE.Vector3(0.2, 0.38, 9.2),
  ] : [
    new THREE.Vector3(-15.2, 0.34, 5.7),
    new THREE.Vector3(-10.4, 0.36, 4.3),
    new THREE.Vector3(-5.4, 0.34, 2.8),
    new THREE.Vector3(-0.8, 0.36, 1.25),
    new THREE.Vector3(3.8, 0.34, -0.1),
    new THREE.Vector3(7.8, 0.36, -1.8),
    new THREE.Vector3(10.7, 0.34, -3.1),
    new THREE.Vector3(13.2, 0.38, -4.6),
  ];
  const curve = new THREE.CatmullRomCurve3(knots, false, "centripetal");
  const segmentCount = mobile ? 30 : 44;
  const segmentSize = mobile ? 0.23 : 0.2;
  const segmentGeometry = new THREE.BoxGeometry(segmentSize, segmentSize, segmentSize);
  const segmentMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.58,
    toneMapped: false,
  });
  const route = new THREE.InstancedMesh(segmentGeometry, segmentMaterial, segmentCount);
  const dummy = new THREE.Object3D();

  for (let index = 0; index < segmentCount; index += 1) {
    const point = curve.getPointAt(index / (segmentCount - 1));
    dummy.position.copy(point);
    dummy.scale.setScalar(index % 6 === 0 ? 1.18 : 0.86);
    dummy.updateMatrix();
    route.setMatrixAt(index, dummy.matrix);
    route.setColorAt(index, new THREE.Color(index % 6 === 0 ? 0xb69755 : TRAIL));
  }
  route.instanceMatrix.needsUpdate = true;
  if (route.instanceColor) route.instanceColor.needsUpdate = true;
  scene.add(route);

  const portal = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.54, 18),
    new THREE.MeshBasicMaterial({ color: 0x93a486, transparent: true, opacity: 0.62, side: THREE.DoubleSide }),
  );
  portal.rotation.x = -Math.PI / 2;
  portal.position.copy(knots[0]);
  portal.position.y = 0.08;
  scene.add(portal);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(mobile ? 0.42 : 0.36, mobile ? 0.42 : 0.36, mobile ? 0.42 : 0.36),
    new THREE.MeshBasicMaterial({ color: STREAM, toneMapped: false }),
  );
  scene.add(head);

  const trail = [];
  for (let index = 0; index < 6; index += 1) {
    const segment = new THREE.Mesh(
      new THREE.BoxGeometry(segmentSize * 1.22, segmentSize * 1.22, segmentSize * 1.22),
      new THREE.MeshBasicMaterial({
        color: STREAM,
        transparent: true,
        opacity: 0.52 - index * 0.07,
        toneMapped: false,
      }),
    );
    trail.push(segment);
    scene.add(segment);
  }

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(mobile ? 0.62 : 0.54, 8, 6),
    new THREE.MeshBasicMaterial({
      color: STREAM,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  scene.add(halo);

  const packetLight = new THREE.PointLight(STREAM, mobile ? 0.55 : 0.9, 3.4, 2);
  scene.add(packetLight);

  function positionPacket(progress) {
    const point = curve.getPointAt(progress);
    head.position.copy(point);
    halo.position.copy(point);
    packetLight.position.copy(point);
    packetLight.position.y += 0.4;

    const pulse = 0.88 + Math.sin(progress * Math.PI * 10) * 0.08;
    head.scale.setScalar(pulse);
    halo.scale.setScalar(0.92 + pulse * 0.16);

    trail.forEach((segment, index) => {
      const trailProgress = Math.max(0, progress - (index + 1) * (mobile ? 0.022 : 0.014));
      segment.position.copy(curve.getPointAt(trailProgress));
      segment.visible = progress > (index + 1) * 0.008;
    });
  }

  return function updateDataStream(time, staticProgress = null) {
    if (staticProgress !== null) {
      positionPacket(staticProgress);
      return;
    }

    const cycle = time % 6100;
    const progress = cycle < 3600 ? easeInOutCubic(cycle / 3600) : 1;
    positionPacket(progress);
  };
}

export function mountGrove({ stage, canvas, reducedMotion }) {
  const breakpoint = window.matchMedia("(max-width: 900px)");
  const mobile = breakpoint.matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: !mobile,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(GROUND);
  scene.fog = new THREE.Fog(NIGHT, 35, 60);

  const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.1, 100);
  const cameraBase = new THREE.Vector3(mobile ? 8 : 14, mobile ? 31 : 28, mobile ? 18 : 18);
  const cameraTarget = new THREE.Vector3(mobile ? 0 : 2.5, 0, mobile ? 1 : -0.8);
  camera.position.copy(cameraBase);
  camera.lookAt(cameraTarget);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(82, 58),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  createShadePatch(scene, mobile);
  const grove = createGrove(scene, mobile);
  const updateDataStream = createDataStream(scene, mobile);

  scene.add(new THREE.HemisphereLight(0xb8cab6, 0x07100c, 1.1));

  const sun = new THREE.DirectionalLight(0xf0d79d, 3.05);
  sun.position.set(-14, 22, 8);
  sun.castShadow = !mobile;
  sun.shadow.mapSize.set(mobile ? 512 : 1024, mobile ? 512 : 1024);
  sun.shadow.camera.left = -24;
  sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 55;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.028;
  sun.target.position.set(mobile ? 0 : 4, 0, -1);
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(0x315848, 0.48);
  fill.position.set(16, 10, -12);
  scene.add(fill);

  let stageVisible = true;
  let frameId = 0;
  let lastFrame = 0;
  let pointerX = 0;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let disposed = false;
  const startedAt = window.performance.now();

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const aspect = width / height;
    const viewHeight = mobile ? 28 : 22;
    camera.left = -(viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function render(time = startedAt) {
    if (disposed) return;
    const elapsed = Math.max(0, time - startedAt);
    const growth = reducedMotion ? 1 : easeOutCubic(Math.min(1, elapsed / 900));
    grove.scale.y = Math.max(0.02, growth);

    smoothX += (pointerX - smoothX) * 0.04;
    smoothY += (pointerY - smoothY) * 0.04;
    camera.position.set(
      cameraBase.x + smoothX * 0.35,
      cameraBase.y,
      cameraBase.z + smoothY * 0.28,
    );
    camera.lookAt(cameraTarget.x + smoothX * 0.18, 0, cameraTarget.z + smoothY * 0.12);
    updateDataStream(reducedMotion ? 0 : elapsed, reducedMotion ? 0.55 : null);
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
    pointerY = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
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

  function onBreakpointChange() {
    cleanup();
    window.requestAnimationFrame(() => mountGrove({ stage, canvas, reducedMotion }));
  }

  const resizer = "ResizeObserver" in window ? new ResizeObserver(() => {
    resize();
    if (reducedMotion) render();
  }) : null;
  const visibility = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    stageVisible = entries.some((entry) => entry.isIntersecting);
  }) : null;

  function cleanup() {
    if (disposed) return;
    disposed = true;
    window.cancelAnimationFrame(frameId);
    resizer?.disconnect();
    visibility?.disconnect();
    breakpoint.removeEventListener?.("change", onBreakpointChange);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    window.removeEventListener("pagehide", cleanup);
    renderer.dispose();
  }

  resize();
  render();
  stage.classList.add("is-live");
  resizer?.observe(stage);
  visibility?.observe(stage);
  canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
  breakpoint.addEventListener?.("change", onBreakpointChange, { once: true });
  window.addEventListener("pagehide", cleanup, { once: true });

  if (!reducedMotion) {
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", onPointerLeave, { passive: true });
    frameId = window.requestAnimationFrame(tick);
  }

  return cleanup;
}
