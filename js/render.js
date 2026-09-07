/* Meadowstead — Three.js renderer: seasonal homestead scene, semantic entity views,
   selection/ghost layers, quality tiers, deterministic decoration seed. */
(function (root) {
'use strict';

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_SELECT = 2, LAYER_FX = 3;

const PLOT_COLS = 4;
const PLOT_SPACING = 2.2;

const SEASON_TINT = {
  spring: { sky: 0xbfe3ff, ground: 0x7fbf5f, fog: 0xd6ecff },
  summer: { sky: 0xa8d8ff, ground: 0x6fb84e, fog: 0xcfe8ff },
  autumn: { sky: 0xf3d9a4, ground: 0xb99a4e, fog: 0xf0ddba },
};

const QUALITY = {
  low:    { dpr: 1,    shadows: false, particles: 0,  envDetail: 0.4, renderScale: 0.85 },
  medium: { dpr: 1.5,  shadows: true,  particles: 200, envDetail: 0.7, renderScale: 1 },
  high:   { dpr: 2,    shadows: true,  particles: 600, envDetail: 1,   renderScale: 1 },
};

function makeRenderer(THREE, canvas, opts) {
  const R = {
    THREE, canvas,
    scene: null, camera: null, renderer: null,
    plots: [], plotGroup: null,
    selectionRing: null, hoverRing: null, ghost: null,
    tweens: [], particles: [],
    quality: 'medium',
    reducedMotion: false,
    palette: 'default',
    selectedPlot: -1, hoveredPlot: -1,
    time: 0,
    decorationSeed: 'deco',
    pond: null, trees: [],
    ok: false,
  };

  try {
    R.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
  } catch (e) {
    return null;
  }
  R.ok = true;
  R_THREE = THREE; // palette adjustment needs it even if sync() has not run yet
  R.renderer.outputColorSpace = THREE.SRGBColorSpace;
  R.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  R.renderer.toneMappingExposure = 1.05;

  R.scene = new THREE.Scene();
  R.scene.background = new THREE.Color(SEASON_TINT.spring.sky);
  R.scene.fog = new THREE.Fog(SEASON_TINT.spring.fog, 30, 90);

  // Authored camera: low-distortion perspective, fixed framing constants.
  R.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  R.CAM_POS = new THREE.Vector3(0, 12.5, 15);
  R.CAM_LOOK = new THREE.Vector3(0, 0, -0.5);
  R.camera.position.copy(R.CAM_POS);
  R.camera.lookAt(R.CAM_LOOK);

  // Lighting: one dominant key + soft environment fill + grounding.
  const key = new THREE.DirectionalLight(0xfff3e0, 2.4);
  key.position.set(8, 14, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -14; key.shadow.camera.right = 14;
  key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
  R.scene.add(key);
  R.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5a7a4a, 0.9));
  R.keyLight = key;

  buildEnvironment(R);
  buildPlots(R, 12);
  buildSelection(R);
  applyQuality(R, R.quality);
  window.addEventListener('resize', () => resize(R));
  resize(R);
  return R;
}

function decoRand(R, i) {
  let h = 2166136261 >>> 0;
  const s = R.decorationSeed + '|' + i;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
  return h / 4294967296;
}

function buildEnvironment(R) {
  const { THREE, scene } = R;
  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: SEASON_TINT.spring.ground, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  ground.layers.set(LAYER_ENV);
  scene.add(ground);
  R.ground = ground;

  // Pond: layered discs, animated normals faked with opacity ripple rings
  const pondGroup = new THREE.Group();
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 40),
    new THREE.MeshStandardMaterial({ color: 0x3f7fbf, roughness: 0.15, metalness: 0.4 })
  );
  pond.rotation.x = -Math.PI / 2;
  pondGroup.add(pond);
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1 + i * 0.9, 1.15 + i * 0.9, 32),
      new THREE.MeshBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.userData.phase = i * 1.7;
    pondGroup.add(ring);
    (R.pondRings = R.pondRings || []).push(ring);
  }
  pondGroup.position.set(-7.5, 0.01, 3.5);
  scene.add(pondGroup);
  R.pond = pondGroup;

  // Trees: procedural trunk + foliage tiers, deterministic placement
  const treeSpots = [[-9, -4], [-8.5, -1], [8.5, -4.5], [9, -1.5], [7.8, 2.5], [-9.5, 6.5], [9.5, 6]];
  R.trees = treeSpots.map((spot, i) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.24, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 })
    );
    trunk.position.y = 0.7;
    trunk.castShadow = true;
    g.add(trunk);
    const tiers = 2 + Math.floor(decoRand(R, i) * 2);
    for (let t = 0; t < tiers; t++) {
      const r = 1.1 - t * 0.3;
      const fol = new THREE.Mesh(
        new THREE.ConeGeometry(r, 1.1, 9),
        new THREE.MeshStandardMaterial({ color: 0x3f8f3f, roughness: 0.85 })
      );
      fol.position.y = 1.5 + t * 0.75;
      fol.castShadow = true;
      g.add(fol);
    }
    const s = 0.8 + decoRand(R, i + 40) * 0.5;
    g.scale.setScalar(s);
    g.position.set(spot[0], 0, spot[1]);
    scene.add(g);
    return g;
  });

  // Farmhouse
  const house = new THREE.Group();
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 1.8, 2),
    new THREE.MeshStandardMaterial({ color: 0xd9c8a8, roughness: 0.9 })
  );
  walls.position.y = 0.9; walls.castShadow = true;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(2.1, 1.2, 4),
    new THREE.MeshStandardMaterial({ color: 0xa8543c, roughness: 0.8 })
  );
  roof.position.y = 2.4; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
  house.add(walls, roof);
  house.position.set(6.5, 0, -5.5);
  R.scene.add(house);

  // Fence around field
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x9a7b52, roughness: 0.95 });
  const fence = new THREE.Group();
  const w = PLOT_COLS * PLOT_SPACING + 1.2;
  const d = 5 * PLOT_SPACING + 1.2;
  for (let i = 0; i <= 8; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), fenceMat);
    post.position.set(-w / 2 + (w / 8) * i, 0.35, -d / 2 - 0.6);
    fence.add(post);
    const post2 = post.clone(); post2.position.z = d / 2 + 0.6; fence.add(post2);
  }
  const railN = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.08), fenceMat);
  railN.position.set(0, 0.5, -d / 2 - 0.6);
  const railS = railN.clone(); railS.position.z = d / 2 + 0.6;
  fence.add(railN, railS);
  R.scene.add(fence);
}

/* count defaults to the standard 12-plot field; journey stages use 8 or 16 plots
   and must be centred on their own row count or the field sits off-camera. */
function plotPosition(index, count) {
  const col = index % PLOT_COLS;
  const row = Math.floor(index / PLOT_COLS);
  const rows = Math.ceil((count || 12) / PLOT_COLS);
  return {
    x: (col - (PLOT_COLS - 1) / 2) * PLOT_SPACING,
    z: (row - (rows - 1) / 2) * PLOT_SPACING,
  };
}

function buildPlots(R, count) {
  const { THREE } = R;
  if (R.plotGroup) { R.scene.remove(R.plotGroup); disposeGroup(R.plotGroup); }
  R.plotGroup = new THREE.Group();
  R.plots = [];
  const soilMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 });
  const soilWetMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.7 });
  for (let i = 0; i < count; i++) {
    const pos = plotPosition(i, count);
    const g = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 1.8), soilMat.clone());
    soil.position.y = 0.15;
    soil.receiveShadow = true;
    soil.userData.plotIndex = i;
    soil.layers.enable(LAYER_GAME);
    g.add(soil);
    g.position.set(pos.x, 0, pos.z);
    R.plotGroup.add(g);
    R.plots.push({ group: g, soil: soil, cropMesh: null, soilMat, soilWetMat, index: i });
  }
  R.scene.add(R.plotGroup);
}

function buildCropMesh(R, crop, stage) {
  // stage: 0 seedling, 1 growing, 2 ready
  const { THREE } = R;
  const g = new THREE.Group();
  const h = [0.35, 0.7, 1.0][stage];
  if (crop === 'pumpkin') {
    if (stage < 2) {
      const sprout = new THREE.Mesh(new THREE.ConeGeometry(0.16, h, 6),
        new THREE.MeshStandardMaterial({ color: 0x5fae4f, roughness: 0.8 }));
      sprout.position.y = h / 2 + 0.3; g.add(sprout);
    } else {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0xe07820, roughness: 0.55 }));
      body.position.y = 0.75; body.scale.y = 0.8; body.castShadow = true; g.add(body);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 6),
        new THREE.MeshStandardMaterial({ color: 0x4a7a3a }));
      stem.position.y = 1.25; g.add(stem);
    }
  } else {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, h, 6),
      new THREE.MeshStandardMaterial({ color: 0x4f9a3f, roughness: 0.8 }));
    stem.position.y = h / 2 + 0.3; stem.castShadow = true; g.add(stem);
    const leaves = 3 + stage * 2;
    for (let i = 0; i < leaves; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.1 + stage * 0.03, 0.35, 5),
        new THREE.MeshStandardMaterial({ color: 0x63b34d, roughness: 0.8 }));
      const a = (i / leaves) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.18, h + 0.25, Math.sin(a) * 0.18);
      leaf.rotation.set(Math.cos(a) * 0.7, 0, -Math.sin(a) * 0.7);
      g.add(leaf);
    }
    if (stage === 2) {
      const color = crop === 'carrot' ? 0xe87f2e : 0xc9a0dc;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
      bulb.position.y = 0.42; g.add(bulb);
    }
  }
  return g;
}

function buildSelection(R) {
  const { THREE } = R;
  const ringGeo = new THREE.RingGeometry(1.0, 1.15, 32);
  R.selectionRing = new THREE.Mesh(ringGeo,
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
  R.selectionRing.rotation.x = -Math.PI / 2;
  R.selectionRing.position.y = 0.34;
  R.selectionRing.visible = false;
  R.selectionRing.layers.set(LAYER_SELECT);
  R.scene.add(R.selectionRing);
  R.hoverRing = new THREE.Mesh(ringGeo.clone(),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
  R.hoverRing.rotation.x = -Math.PI / 2;
  R.hoverRing.position.y = 0.33;
  R.hoverRing.visible = false;
  R.hoverRing.layers.set(LAYER_SELECT);
  R.scene.add(R.hoverRing);
}

function setGhost(R, plot, kind, valid) {
  const { THREE } = R;
  if (R.ghost) { R.scene.remove(R.ghost); disposeGroup(R.ghost); R.ghost = null; }
  if (plot < 0 || !kind) return;
  const color = valid ? 0x7fe07f : 0xe05f5f;
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.7, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45 }));
  m.rotation.x = -Math.PI / 2;
  const pos = plotPosition(plot, R.plots.length);
  m.position.set(pos.x, 0.36, pos.z);
  m.layers.set(LAYER_SELECT);
  R.scene.add(m);
  R.ghost = m;
}

/* ---------- state sync ---------- */
function syncState(R, state, season, opts) {
  opts = opts || {};
  // plots count can differ per session
  if (R.plots.length !== state.plots.length) buildPlots(R, state.plots.length);
  for (let i = 0; i < state.plots.length; i++) {
    const p = R.plots[i];
    const c = state.plots[i].crop;
    const wantStage = c ? (c.ready ? 2 : (c.age > 0 ? 1 : 0)) : -1;
    const cur = p.cropMesh ? p.cropMesh.userData.key : null;
    const key = c ? c.type + ':' + wantStage : null;
    if (key !== cur) {
      if (p.cropMesh) { p.group.remove(p.cropMesh); disposeGroup(p.cropMesh); p.cropMesh = null; }
      if (c) {
        const m = buildCropMesh(R, c.type, wantStage);
        m.userData.key = key;
        p.group.add(m);
        p.cropMesh = m;
        if (!opts.instant && !R.reducedMotion) {
          m.scale.setScalar(0.01);
          addTween(R, m, { scale: 1, dur: 0.35 });
        }
      }
    }
    p.soil.material.color.setHex(c && c.watered ? 0x4a3018 : 0x6b4a2e);
    // ready pulse marker
    if (c && c.ready && !p.readyMark) {
      const mark = new R.THREE.Mesh(new R.THREE.RingGeometry(0.5, 0.62, 20),
        new R.THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.8, side: R.THREE.DoubleSide }));
      mark.rotation.x = -Math.PI / 2; mark.position.y = 0.36;
      p.group.add(mark);
      p.readyMark = mark;
    } else if ((!c || !c.ready) && p.readyMark) {
      p.group.remove(p.readyMark); disposeGroup(p.readyMark); p.readyMark = null;
    }
  }
  const tint = SEASON_TINT[season] || SEASON_TINT.spring;
  R.scene.background.setHex(adjustForPalette(tint.sky, R.palette));
  R.scene.fog.color.setHex(adjustForPalette(tint.fog, R.palette));
  R.ground.material.color.setHex(adjustForPalette(tint.ground, R.palette));
}

function adjustForPalette(hex, palette) {
  if (palette === 'default') return hex;
  const c = new R_THREE.Color(hex);
  function hueShift(deg) {
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL((hsl.h + deg / 360 + 1) % 1, hsl.s, hsl.l);
  }
  if (palette === 'deuteranopia') hueShift(30);
  else if (palette === 'protanopia') hueShift(-25);
  else if (palette === 'tritanopia') hueShift(60);
  else if (palette === 'high-contrast') {
    const hsl = {}; c.getHSL(hsl);
    c.setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l > 0.5 ? Math.min(0.9, hsl.l * 1.15) : hsl.l * 0.8);
  }
  return c.getHex();
}
let R_THREE = null; // set on first sync

/* ---------- particles (pooled, bounded, seeded) ---------- */
function burst(R, plot, color, n) {
  if (R.reducedMotion || !n) return;
  const { THREE } = R;
  const pos = plotPosition(plot, R.plots.length);
  for (let i = 0; i < n && R.particles.length < 80; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4),
      new THREE.MeshBasicMaterial({ color }));
    m.position.set(pos.x, 0.8, pos.z);
    const a = (i / n) * Math.PI * 2;
    m.userData.vel = { x: Math.cos(a) * 1.6, y: 2.4 + (i % 3), z: Math.sin(a) * 1.6 };
    m.userData.life = 0.7;
    m.layers.set(LAYER_FX);
    R.scene.add(m);
    R.particles.push(m);
  }
}

function addTween(R, obj, tw) {
  tw.obj = obj; tw.t = 0; tw.from = obj.scale.x;
  R.tweens.push(tw);
}

/* ---------- camera / main loop ---------- */
function resize(R) {
  const w = R.canvas.clientWidth || R.canvas.parentElement.clientWidth || 800;
  const h = R.canvas.clientHeight || R.canvas.parentElement.clientHeight || 600;
  const q = QUALITY[R.quality];
  R.renderer.setSize(Math.floor(w * q.renderScale), Math.floor(h * q.renderScale), false);
  R.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
  R.camera.aspect = w / h;
  R.camera.updateProjectionMatrix();
}

function applyQuality(R, tier) {
  R.quality = QUALITY[tier] ? tier : 'medium';
  const q = QUALITY[R.quality];
  R.renderer.shadowMap.enabled = q.shadows;
  R.keyLight.castShadow = q.shadows;
  resize(R);
}

let lastT = 0;
function frame(R, state, season, t) {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
  lastT = t;
  R.time += dt;
  // tweens: deterministic settle, interruptible
  for (let i = R.tweens.length - 1; i >= 0; i--) {
    const tw = R.tweens[i];
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    const e = 1 - Math.pow(1 - k, 3);
    const s = tw.from + (tw.scale - tw.from) * e;
    tw.obj.scale.setScalar(s);
    if (k >= 1) { tw.obj.scale.setScalar(tw.scale); R.tweens.splice(i, 1); }
  }
  // particles
  for (let i = R.particles.length - 1; i >= 0; i--) {
    const m = R.particles[i];
    m.userData.life -= dt;
    m.position.x += m.userData.vel.x * dt;
    m.position.y += m.userData.vel.y * dt;
    m.position.z += m.userData.vel.z * dt;
    m.userData.vel.y -= 6 * dt;
    if (m.userData.life <= 0) { R.scene.remove(m); disposeGroup(m); R.particles.splice(i, 1); }
  }
  // pond ripples & gentle tree sway (paused when hidden; reduced motion honored)
  if (!document.hidden && !R.reducedMotion) {
    (R.pondRings || []).forEach((r) => {
      const s = 1 + Math.sin(R.time * 0.8 + r.userData.phase) * 0.06;
      r.scale.setScalar(s);
      r.material.opacity = 0.25 + Math.sin(R.time * 0.8 + r.userData.phase) * 0.12;
    });
    R.trees.forEach((tr, i) => { tr.rotation.z = Math.sin(R.time * 0.5 + i) * 0.015; });
  }
  // selection ring pulse
  if (R.selectionRing.visible && !R.reducedMotion) {
    R.selectionRing.material.opacity = 0.7 + Math.sin(R.time * 4) * 0.25;
  }
  if (state) syncState(R, state, season, {});
  R.renderer.render(R.scene, R.camera);
}

function setSelected(R, i) {
  R.selectedPlot = i;
  if (i >= 0 && R.plots[i]) {
    const pos = plotPosition(i, R.plots.length);
    R.selectionRing.position.set(pos.x, 0.34, pos.z);
    R.selectionRing.visible = true;
  } else R.selectionRing.visible = false;
}
function setHovered(R, i) {
  R.hoveredPlot = i;
  if (i >= 0 && R.plots[i]) {
    const pos = plotPosition(i, R.plots.length);
    R.hoverRing.position.set(pos.x, 0.33, pos.z);
    R.hoverRing.visible = true;
  } else R.hoverRing.visible = false;
}

function raycastPlot(R, clientX, clientY) {
  const { THREE } = R;
  const rect = R.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const rc = new THREE.Raycaster();
  rc.layers.set(LAYER_GAME);
  rc.setFromCamera(ndc, R.camera);
  const soils = R.plots.map(p => p.soil);
  const hits = rc.intersectObjects(soils, false);
  return hits.length ? hits[0].object.userData.plotIndex : -1;
}

function disposeGroup(obj) {
  obj.traverse ? obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }
  }) : null;
}

function dispose(R) {
  if (!R.ok) return;
  disposeGroup(R.scene);
  R.renderer.dispose();
  R.ok = false;
}

root.MeadowRender = {
  create: makeRenderer,
  sync: (R, state, season, opts) => { R_THREE = R.THREE; syncState(R, state, season, opts); },
  frame: (R, state, season, t) => frame(R, state, season, t),
  setSelected, setHovered, setGhost, raycastPlot, burst, applyQuality, resize, dispose,
  plotPosition,
  setReducedMotion: (R, v) => { R.reducedMotion = v; },
  setPalette: (R, p) => { R.palette = p; R_THREE = R.THREE; },
  setDecorationSeed: (R, s) => { R.decorationSeed = String(s); },
};
})(typeof self !== 'undefined' ? self : globalThis);
