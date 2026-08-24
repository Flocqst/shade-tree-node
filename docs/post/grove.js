/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "./vendor/three-0.185.1/three.module.min.js";

const NIGHT = 0x070c09;
const GROUND = 0x111913;
const BARK = 0x4a3d2f;
const LEAF_COLORS = [0x40543a, 0x506244, 0x637452, 0x788564, 0x344634];
const STREAM = 0xd1b66e;
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
  const rowCounts = mobile ? [5, 4, 5, 4] : [7, 6, 7, 6, 6];
  const xMin = mobile ? -4.4 : -12.2;
  const xMax = mobile ? 4.4 : 7.4;
  const zMin = mobile ? -2.7 : -3.6;
  const zStep = mobile ? 1.7 : 1.65;
  const trees = [];

  rowCounts.forEach((count, row) => {
    for (let index = 0; index < count; index += 1) {
      const progress = count === 1 ? 0.5 : index / (count - 1);
      const stagger = row % 2 === 0 ? 0 : (xMax - xMin) / count / 2;
      const height = (mobile ? 2.35 : 2.55) + random() * (mobile ? 1.75 : 2.25);
      trees.push({
        x: xMin + (xMax - xMin) * progress + stagger + (random() - 0.5) * 0.38,
        z: zMin + row * zStep + (random() - 0.5) * 0.38,
        height,
        crown: 0.72 + height * 0.2 + random() * 0.24,
        seed: Math.floor(random() * 100_000),
      });
    }
  });

  return trees;
}

function createGrove(scene, mobile) {
  const trees = buildTreeLayout(mobile);

  const branchCount = trees.length * 3;
  const branchGeometry = new THREE.CylinderGeometry(1, 1.24, 1, 5, 1, false);
  const branchMaterial = new THREE.MeshStandardMaterial({
    color: BARK,
    flatShading: true,
    roughness: 0.96,
  });
  const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, branchCount);
  branches.castShadow = !mobile;
  branches.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const canopyRecords = [];
  const rootPoints = [];
  let branchIndex = 0;

  for (const tree of trees) {
    const base = new THREE.Vector3(tree.x, 0, tree.z);
    const trunkTop = new THREE.Vector3(tree.x, tree.height, tree.z);
    branchTransform(dummy, base, trunkTop, 0.2 + tree.height * 0.014);
    branches.setMatrixAt(branchIndex++, dummy.matrix);

    const random = seededRandom(tree.seed);
    for (const side of [-1, 1]) {
      const start = new THREE.Vector3(tree.x, tree.height * (0.64 + random() * 0.1), tree.z);
      const end = new THREE.Vector3(
        tree.x + side * tree.crown * (0.48 + random() * 0.15),
        tree.height + tree.crown * (0.08 + random() * 0.18),
        tree.z + (random() - 0.5) * tree.crown * 0.55,
      );
      branchTransform(dummy, start, end, 0.105 + tree.crown * 0.012);
      branches.setMatrixAt(branchIndex++, dummy.matrix);
    }

    const lobeCount = mobile ? 6 : 8;
    for (let index = 0; index < lobeCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * tree.crown;
      const size = tree.crown * (0.42 + random() * 0.22);
      canopyRecords.push({
        x: tree.x + Math.cos(angle) * radius * 0.74,
        y: tree.height + 0.2 + (1 - radius / tree.crown) * 0.7 + (random() - 0.5) * 0.55,
        z: tree.z + Math.sin(angle) * radius * 0.62,
        sx: size * (0.88 + random() * 0.24),
        sy: size * (0.62 + random() * 0.2),
        sz: size * (0.84 + random() * 0.28),
        rx: random() * Math.PI,
        ry: random() * Math.PI,
        color: LEAF_COLORS[Math.floor(random() * LEAF_COLORS.length)],
      });
    }

    for (let root = 0; root < 2; root += 1) {
      const angle = random() * Math.PI * 2;
      const reach = 0.7 + random() * 0.85;
      let previous = new THREE.Vector3(tree.x, 0.018, tree.z);
      for (let segment = 1; segment <= 3; segment += 1) {
        const progress = segment / 3;
        const next = new THREE.Vector3(
          tree.x + Math.cos(angle) * reach * progress + (random() - 0.5) * 0.14,
          0.018,
          tree.z + Math.sin(angle) * reach * progress + (random() - 0.5) * 0.14,
        );
        rootPoints.push(previous, next);
        previous = next;
      }
    }
  }

  branches.instanceMatrix.needsUpdate = true;
  scene.add(branches);

  const canopyGeometry = new THREE.IcosahedronGeometry(1, 0);
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  });
  const canopy = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, canopyRecords.length);
  canopy.castShadow = !mobile;
  canopy.receiveShadow = true;

  for (let index = 0; index < canopyRecords.length; index += 1) {
    const lobe = canopyRecords[index];
    dummy.position.set(lobe.x, lobe.y, lobe.z);
    dummy.rotation.set(lobe.rx, lobe.ry, 0);
    dummy.scale.set(lobe.sx, lobe.sy, lobe.sz);
    dummy.updateMatrix();
    canopy.setMatrixAt(index, dummy.matrix);
    canopy.setColorAt(index, new THREE.Color(lobe.color));
  }
  canopy.instanceMatrix.needsUpdate = true;
  if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
  scene.add(canopy);

  const rootGeometry = new THREE.BufferGeometry().setFromPoints(rootPoints);
  const rootMaterial = new THREE.LineBasicMaterial({
    color: 0xd1b66e,
    transparent: true,
    opacity: 0.14,
  });
  scene.add(new THREE.LineSegments(rootGeometry, rootMaterial));
}

function createDataStream(scene, mobile) {
  const knots = (mobile ? [
    new THREE.Vector3(4.7, 0.55, 2.4),
    new THREE.Vector3(2.9, 0.38, 0.5),
    new THREE.Vector3(1.1, 0.72, -1.4),
    new THREE.Vector3(-0.8, 0.45, 0.4),
    new THREE.Vector3(-2.8, 0.65, 1.8),
    new THREE.Vector3(-4.7, 0.42, -1.1),
  ] : [
    new THREE.Vector3(8.4, 0.58, 2.7),
    new THREE.Vector3(5.2, 0.4, 0.2),
    new THREE.Vector3(1.8, 0.75, -1.7),
    new THREE.Vector3(-2.1, 0.42, 0.8),
    new THREE.Vector3(-6.1, 0.68, 2.2),
    new THREE.Vector3(-9.2, 0.38, -1.4),
    new THREE.Vector3(-12.8, 0.6, 0.4),
  ]);
  const curve = new THREE.CatmullRomCurve3(knots, false, "centripetal");
  const pixelCount = mobile ? 54 : 92;
  const pixelGeometry = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const pixelMaterial = new THREE.MeshBasicMaterial({
    color: STREAM,
    transparent: true,
    opacity: 0.68,
    toneMapped: false,
  });
  const pixels = new THREE.InstancedMesh(pixelGeometry, pixelMaterial, pixelCount);
  const dummy = new THREE.Object3D();

  for (let index = 0; index < pixelCount; index += 1) {
    const point = curve.getPointAt(index / (pixelCount - 1));
    const quiet = index % 7 === 0 ? 1.45 : 1;
    dummy.position.copy(point);
    dummy.scale.setScalar(quiet);
    dummy.updateMatrix();
    pixels.setMatrixAt(index, dummy.matrix);
  }
  pixels.instanceMatrix.needsUpdate = true;
  scene.add(pixels);

  const packetCount = mobile ? 2 : 4;
  const packetGeometry = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  const packetMaterial = new THREE.MeshBasicMaterial({ color: 0xf0d98b, toneMapped: false });
  const packets = new THREE.InstancedMesh(packetGeometry, packetMaterial, packetCount);
  scene.add(packets);

  return function updateDataStream(time) {
    for (let index = 0; index < packetCount; index += 1) {
      const progress = ((time * 0.000035) + index / packetCount) % 1;
      dummy.position.copy(curve.getPointAt(progress));
      const pulse = 0.82 + Math.sin(time * 0.004 + index) * 0.14;
      dummy.scale.setScalar(pulse);
      dummy.updateMatrix();
      packets.setMatrixAt(index, dummy.matrix);
    }
    packets.instanceMatrix.needsUpdate = true;
  };
}

export function mountGrove({ stage, canvas, reducedMotion }) {
  const mobile = window.matchMedia("(max-width: 860px)").matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: !mobile,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.Fog(NIGHT, 15, 34);

  const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, 0.1, 70);
  camera.position.set(mobile ? 7.6 : 12.5, mobile ? 7.4 : 8.7, mobile ? 15 : 19);
  camera.lookAt(mobile ? -0.1 : -2.3, 2.1, 0);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(54, 34),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  const sky = new THREE.HemisphereLight(0xdde5d5, 0x040805, 2.05);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xd1b66e, 4.2);
  const sunBase = new THREE.Vector3(-5.5, 11, 7.5);
  sun.position.copy(sunBase);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 512 : 1024, mobile ? 512 : 1024);
  sun.shadow.camera.left = -15;
  sun.shadow.camera.right = 15;
  sun.shadow.camera.top = 13;
  sun.shadow.camera.bottom = -5;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 32;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.025;
  sun.target.position.set(-2.2, 0, -0.2);
  scene.add(sun, sun.target);

  createGrove(scene, mobile);
  const updateDataStream = createDataStream(scene, mobile);

  let stageVisible = true;
  let frameId = 0;
  let lastFrame = 0;
  let pointerX = 0;
  let pointerZ = 0;
  let smoothX = 0;
  let smoothZ = 0;
  let disposed = false;

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const aspect = width / height;
    const viewHeight = mobile ? 11.6 : 12.4;
    camera.left = -(viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function render(time = 0) {
    if (disposed) return;
    smoothX += (pointerX - smoothX) * 0.045;
    smoothZ += (pointerZ - smoothZ) * 0.045;
    const idle = reducedMotion ? 0 : Math.sin(time * 0.00018) * 0.55;
    sun.position.x = sunBase.x + smoothX * 2.6 + idle;
    sun.position.z = sunBase.z + smoothZ * 1.8;
    updateDataStream(reducedMotion ? 0 : time);
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

  function onPointerLeave() {
    pointerX = 0;
    pointerZ = 0;
  }

  function onContextLost(event) {
    event.preventDefault();
    disposed = true;
    stage.classList.remove("is-live");
    window.cancelAnimationFrame(frameId);
  }

  resize();
  render(0);
  stage.classList.add("is-live");

  const resizer = "ResizeObserver" in window ? new ResizeObserver(() => {
    resize();
    if (reducedMotion) render(0);
  }) : null;
  resizer?.observe(stage);

  const visibility = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    stageVisible = entries.some((entry) => entry.isIntersecting);
  }) : null;
  visibility?.observe(stage);

  canvas.addEventListener("webglcontextlost", onContextLost, { once: true });

  if (!reducedMotion) {
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", onPointerLeave, { passive: true });
    frameId = window.requestAnimationFrame(tick);
  }

  window.addEventListener("pagehide", () => {
    disposed = true;
    window.cancelAnimationFrame(frameId);
    resizer?.disconnect();
    visibility?.disconnect();
    renderer.dispose();
  }, { once: true });
}
