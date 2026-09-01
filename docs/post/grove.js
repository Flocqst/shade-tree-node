/* global document, IntersectionObserver, ResizeObserver, window */

import * as THREE from "./vendor/three-0.185.1/three.module.min.js";

const NIGHT = 0x07100c;
const GROUND = 0x16261c;
const BARK = 0x5b4632;
const LEAF_COLORS = [0x294a37, 0x365b42, 0x456a4b, 0x55785a, 0x314f3b];
const STREAM = 0xe2ba5a;
const TRAIL = 0x71846d;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const FLAT_PLANE = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

export function orientGroundBeam(object, angle) {
  object.quaternion.setFromAxisAngle(UP, angle).multiply(FLAT_PLANE);
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
  const treeScale = mobile ? 1.08 : 1.07;
  const trees = [];

  for (let attempt = 0; attempt < 900 && trees.length < targetCount - 1; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random());
    const x = centerX + Math.cos(angle) * radiusX * radius + (random() - 0.5) * 0.8;
    const z = centerZ + Math.sin(angle) * radiusZ * radius + (random() - 0.5) * 0.8;

    const inCopyClearing = mobile ? z < -4.6 : x < -2.8 && Math.abs(z) < 4.2;
    const crowded = trees.some((tree) => Math.hypot(tree.x - x, tree.z - z) < minDistance);
    if (inCopyClearing || crowded) continue;

    const height = (2.5 + random() * 1.8) * treeScale;
    trees.push({
      x,
      z,
      height,
      crown: (1.05 + random() * 0.65) * treeScale,
      lean: (random() - 0.5) * 0.22,
      seed: Math.floor(random() * 100_000),
      selected: false,
    });
  }

  trees.push({
    x: mobile ? 0.2 : 13.2,
    z: mobile ? 9.2 : -4.6,
    height: (mobile ? 4.2 : 4.7) * treeScale,
    crown: (mobile ? 1.8 : 2.05) * treeScale,
    lean: 0.04,
    seed: 41_203,
    selected: true,
  });

  return trees;
}

function createShadePatch(scene, mobile) {
  const centerX = mobile ? 0 : 5.1;
  const centerZ = mobile ? 2.1 : -0.7;
  const vertexShader = `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const shadeFragmentShader = `
    varying vec2 vUv;

    void main() {
      vec2 point = (vUv - 0.5) * 2.0;
      float angle = atan(point.y, point.x);
      float edge = 0.055 * sin(angle * 3.0 + 0.8) + 0.03 * sin(angle * 7.0 - 1.4);
      float mask = 1.0 - smoothstep(0.56 + edge, 0.99 + edge, length(point));
      gl_FragColor = vec4(vec3(0.039, 0.094, 0.067), mask * 0.44);
    }
  `;
  const beamFragmentShader = `
    uniform float beamStrength;
    uniform float coreStrength;
    uniform float beamPhase;
    varying vec2 vUv;

    void main() {
      float distanceFromCenter = abs(vUv.x - 0.5) * 2.0;
      float feather = 1.0 - smoothstep(0.12, 1.0, distanceFromCenter);
      float core = 1.0 - smoothstep(0.0, 0.13, distanceFromCenter);
      float ends = smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.86, 1.0, vUv.y));
      float dapple = 0.72 + 0.28 * sin(vUv.y * 48.0 + beamPhase) * sin(vUv.y * 17.0 - beamPhase);
      float alpha = (feather * beamStrength + core * coreStrength) * ends * dapple;
      gl_FragColor = vec4(vec3(0.886, 0.729, 0.353), alpha);
    }
  `;

  const patch = new THREE.Mesh(
    new THREE.PlaneGeometry(mobile ? 17 : 34, mobile ? 27 : 23),
    new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: shadeFragmentShader,
      transparent: true,
      depthWrite: false,
    }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(centerX, 0.012, centerZ);
  scene.add(patch);

  const beamSpecs = mobile ? [
    { width: 1.65, length: 48, angle: -1.02, x: centerX + 0.8, z: centerZ - 1.4, strength: 0.14, core: 0.046 },
    { width: 1.24, length: 48, angle: 0.02, x: centerX - 3.2, z: centerZ + 2.4, strength: 0.12, core: 0.039 },
    { width: 1.02, length: 46, angle: 1.01, x: centerX + 3.9, z: centerZ + 0.5, strength: 0.1, core: 0.032 },
  ] : [
    { width: 2.2, length: 66, angle: -1.02, x: centerX + 1.8, z: centerZ - 1.4, strength: 0.15, core: 0.05 },
    { width: 1.6, length: 64, angle: 0.02, x: centerX - 4.5, z: centerZ + 2.2, strength: 0.12, core: 0.04 },
    { width: 1.3, length: 62, angle: 1.01, x: centerX + 6, z: centerZ - 0.2, strength: 0.1, core: 0.034 },
  ];

  beamSpecs.forEach((spec, index) => {
    const beam = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.width, spec.length),
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: beamFragmentShader,
        uniforms: {
          beamStrength: { value: spec.strength },
          coreStrength: { value: spec.core },
          beamPhase: { value: index * 1.73 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    orientGroundBeam(beam, spec.angle);
    beam.position.set(spec.x, 0.026 + index * 0.001, spec.z);
    beam.renderOrder = 2;
    scene.add(beam);
  });
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
  grove.scale.y = 1;
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
    new THREE.Vector3(-0.7, 0.34, 13.5),
  ] : [
    new THREE.Vector3(-15.2, 0.34, 5.7),
    new THREE.Vector3(-10.4, 0.36, 4.3),
    new THREE.Vector3(-5.4, 0.34, 2.8),
    new THREE.Vector3(-0.8, 0.36, 1.25),
    new THREE.Vector3(3.8, 0.34, -0.1),
    new THREE.Vector3(7.8, 0.36, -1.8),
    new THREE.Vector3(10.7, 0.34, -3.1),
    new THREE.Vector3(13.2, 0.38, -4.6),
    new THREE.Vector3(18.0, 0.34, -7.4),
  ];
  const curve = new THREE.CatmullRomCurve3(knots, false, "centripetal");
  const segmentCount = mobile ? 36 : 52;
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

  const destination = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.46, 4),
    new THREE.MeshBasicMaterial({ color: TRAIL, transparent: true, opacity: 0.62, side: THREE.DoubleSide }),
  );
  destination.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
  destination.position.copy(knots.at(-1));
  destination.position.y = 0.08;
  scene.add(destination);

  function makePacket({ color, scale = 1, opacity = 1, light = 1, direction = 1 }) {
    const headSize = (mobile ? 0.42 : 0.36) * scale;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(headSize, headSize, headSize),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    scene.add(head);

    const trail = [];
    for (let index = 0; index < 6; index += 1) {
      const size = segmentSize * 1.22 * scale;
      const segment = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: (0.52 - index * 0.07) * opacity,
          toneMapped: false,
        }),
      );
      trail.push(segment);
      scene.add(segment);
    }

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry((mobile ? 0.62 : 0.54) * scale, 8, 6),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2 * opacity,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    scene.add(halo);

    const packetLight = new THREE.PointLight(color, (mobile ? 0.55 : 0.9) * light, 3.4, 2);
    scene.add(packetLight);
    return { head, trail, halo, packetLight, direction };
  }

  const outbound = makePacket({ color: STREAM });
  const inbound = makePacket({ color: 0xdde5d5, scale: 0.82, opacity: 0.82, light: 0.66, direction: -1 });

  function positionPacket(packet, progress) {
    const point = curve.getPointAt(progress);
    packet.head.position.copy(point);
    packet.halo.position.copy(point);
    packet.packetLight.position.copy(point);
    packet.packetLight.position.y += 0.4;

    const pulse = 0.88 + Math.sin(progress * Math.PI * 10) * 0.08;
    packet.head.scale.setScalar(pulse);
    packet.halo.scale.setScalar(0.92 + pulse * 0.16);

    packet.trail.forEach((segment, index) => {
      const offset = (index + 1) * (mobile ? 0.022 : 0.014);
      const trailProgress = THREE.MathUtils.clamp(progress - packet.direction * offset, 0, 1);
      segment.position.copy(curve.getPointAt(trailProgress));
      segment.visible = packet.direction > 0 ? progress > offset * 0.4 : progress < 1 - offset * 0.4;
    });
  }

  return function updateDataStream(time, staticProgress = null) {
    if (staticProgress !== null) {
      positionPacket(outbound, staticProgress);
      positionPacket(inbound, 1 - staticProgress);
      return;
    }

    const outboundProgress = easeInOutCubic((time % 6200) / 6200);
    positionPacket(outbound, outboundProgress);
    positionPacket(inbound, 1 - outboundProgress);
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
    powerPreference: "default",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFShadowMap;

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
  ground.receiveShadow = false;
  scene.add(ground);

  createShadePatch(scene, mobile);
  createGrove(scene, mobile);
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
    const tabletClearing = mobile && width > 600;
    // Stack the grove below the hero actions; tablets lift the full footprint clear of the fade
    // and bias it right, while phones keep their wider established crop plus the CSS lowering.
    const desktopViewHeight = Math.min(35, Math.max(22, 35 / aspect));
    const viewHeight = mobile ? (tabletClearing ? 34 : 36) : desktopViewHeight;
    const horizontalOffset = tabletClearing ? -2.25 : 0;
    const verticalOffset = mobile ? (tabletClearing ? 7 : 8.5) : 0;
    camera.left = -(viewHeight * aspect) / 2 + horizontalOffset;
    camera.right = (viewHeight * aspect) / 2 + horizontalOffset;
    camera.top = viewHeight / 2 + verticalOffset;
    camera.bottom = -viewHeight / 2 + verticalOffset;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function render(time = startedAt) {
    if (disposed) return;
    const elapsed = Math.max(0, time - startedAt);

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
    if (time - lastFrame >= 42) {
      lastFrame = time;
      render(time);
    }
    scheduleFrame();
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
    if (stageVisible) {
      lastFrame = 0;
      scheduleFrame();
    } else {
      stopFrames();
    }
  }) : null;

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
    breakpoint.removeEventListener?.("change", onBreakpointChange);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    renderer.dispose();
  }

  resize();
  render();
  stage.classList.add("is-live");
  resizer?.observe(stage);
  visibility?.observe(stage);
  canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
  breakpoint.addEventListener?.("change", onBreakpointChange, { once: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  if (!reducedMotion) {
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", onPointerLeave, { passive: true });
    scheduleFrame();
  }

  return cleanup;
}
