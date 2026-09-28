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

// Post-render colour grade + vignette, applied to display-space colours (after OutputPass).
// Gentle S-curve that *adds* contrast, a touch of saturation, warm highlights / cool shadows.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette; varying vec2 vUv;',
    'void main() {',
    '  vec4 src = texture2D(tDiffuse, vUv);',
    '  vec3 c = clamp(src.rgb, 0.0, 1.0);',
    '  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);',
    '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
    '  s = mix(vec3(l), s, 1.07);',
    '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.035, 1.0, 0.965), smoothstep(0.2, 0.8, l));',
    '  c = mix(c, s, uAmount);',
    '  float d = length(vUv - 0.5);',
    '  c *= 1.0 - uVignette * smoothstep(0.38, 0.85, d);',
    '  gl_FragColor = vec4(c, src.a);',
    '}',
  ].join('\n'),
};

function makeRenderer(THREE, canvas, opts) {
  opts = opts || {};
  const R = {
    THREE, canvas,
    scene: null, camera: null, renderer: null,
    plots: [], plotGroup: null,
    selectionRing: null, hoverRing: null, ghost: null,
    tweens: [], particles: [],
    reducedMotion: false,
    palette: 'default',
    selectedPlot: -1, hoveredPlot: -1,
    time: 0,
    decorationSeed: 'deco',
    pond: null, trees: [],
    ok: false,
    gfx: opts.gfx,                // pure quality model (js/gfx.js)
    addons: opts.addons || null,  // post-processing + environment modules (arrive async)
    q: null, saved: {}, size: [0, 0], pixelRatio: 0, adaptiveScale: 1, frames: [], fps: 0,
    composer: null, postKey: null, postFailed: !!opts.postFailed, envTex: null,
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
  R.renderer.shadowMap.type = THREE.PCFShadowMap;
  R.gpu = gpuName(R.renderer);
  R.detected = R.gfx ? R.gfx.detectPreset(R.gpu, { mobile: !!opts.mobile }) : 'balanced';

  R.scene = new THREE.Scene();
  R.scene.background = new THREE.Color(SEASON_TINT.spring.sky);
  R.scene.fog = new THREE.Fog(SEASON_TINT.spring.fog, 30, 90);

  // Authored camera: low-distortion perspective, fixed framing constants.
  R.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  R.CAM_POS = new THREE.Vector3(0, 12.5, 15);
  R.CAM_LOOK = new THREE.Vector3(0, 0, -0.5);
  R.camera.position.copy(R.CAM_POS);
  R.camera.lookAt(R.CAM_LOOK);
  // The camera draws every layer; layers exist for raycasting (plots only), not visibility.
  for (const l of [LAYER_ENV, LAYER_GAME, LAYER_SELECT, LAYER_FX]) R.camera.layers.enable(l);

  // Lighting: one dominant warm key (PCF shadows, frustum fitted to the homestead) +
  // hemisphere sky/grass fill; image-based light is added when reflections are on.
  const key = new THREE.DirectionalLight(0xfff3e0, 2.4);
  key.position.set(8, 14, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -12.5; sc.right = 12.5; sc.top = 10.5; sc.bottom = -10.5; sc.near = 4; sc.far = 36;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  R.scene.add(key, key.target);
  R.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x5a7a4a, 0.9);
  R.scene.add(R.hemi);
  R.keyLight = key;

  buildEnvironment(R);
  buildPlots(R, 12);
  buildSelection(R);
  buildAmbientParticles(R);
  if (R.addons) buildEnvMap(R);
  setGraphics(R, {});
  return R;
}

function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch (e) { return ''; }
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
    new THREE.MeshPhysicalMaterial({ color: 0x3a78b8, roughness: 0.14, metalness: 0.15,
      clearcoat: 1, clearcoatRoughness: 0.06 })
  );
  pond.rotation.x = -Math.PI / 2;
  pond.receiveShadow = true;
  pondGroup.add(pond);
  R.pondMat = pond.material;
  R.rippleTex = makeRippleNormalMap(THREE);
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
  R.grassTex = makeGrassTexture(THREE);

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
    post.castShadow = true;
    post.position.set(-w / 2 + (w / 8) * i, 0.35, -d / 2 - 0.6);
    fence.add(post);
    const post2 = post.clone(); post2.position.z = d / 2 + 0.6; fence.add(post2);
  }
  const railN = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.08), fenceMat);
  railN.position.set(0, 0.5, -d / 2 - 0.6);
  const railS = railN.clone(); railS.position.z = d / 2 + 0.6;
  railN.castShadow = true; railS.castShadow = true;
  fence.add(railN, railS);
  R.scene.add(fence);
  walls.receiveShadow = true;

  buildDetail(R);
}

/* ---------- procedural textures (no downloads) ---------- */
function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

// Near-white grass luminance tile: the season hue stays on material.color, this only adds
// mottling and blade speckle so the meadow stops reading as a flat plane.
function makeGrassTexture(THREE) {
  try {
    const [c, g] = canvas2d(256);
    g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, 256, 256);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 70; i++) { // soft mottles, wrapped so the tile repeats seamlessly
      const x = rnd() * 256, y = rnd() * 256, r = 14 + rnd() * 34, v = 200 + Math.floor(rnd() * 55);
      for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, `rgba(${v},${v},${v},0.45)`);
        grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
        g.fillStyle = grd; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    for (let i = 0; i < 2600; i++) { // blades
      const x = rnd() * 256, y = rnd() * 256, v = (rnd() < 0.5 ? 170 + rnd() * 40 : 240 + rnd() * 15) | 0;
      g.strokeStyle = `rgba(${v},${v},${v},0.55)`;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4); g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(36, 36);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  } catch (e) { return null; }
}

// Tileable ripple normal map for the pond (sum of integer-frequency waves, so it is seamless).
function makeRippleNormalMap(THREE) {
  try {
    const N = 128;
    const [c, g] = canvas2d(N);
    const img = g.createImageData(N, N);
    const h = (x, y) => {
      const u = (x / N) * Math.PI * 2, v = (y / N) * Math.PI * 2;
      return Math.sin(u * 3 + v * 2) * 0.5 + Math.sin(u * -2 + v * 5 + 1.3) * 0.35 + Math.sin(u * 7 - v * 3 + 0.4) * 0.15;
    };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
      const nx = -dx * 2, ny = -dy * 2, nz = 1, l = Math.hypot(nx, ny, nz);
      const o = (y * N + x) * 4;
      img.data[o] = (nx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2.5, 2.5);
    return t;
  } catch (e) { return null; }
}

function softDotTexture(THREE) {
  try {
    const [c, g] = canvas2d(32);
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  } catch (e) { return null; }
}

/* ---------- scenery detail (grass tufts, wildflowers, pond stones, cottage trim) — `detail` ---------- */
function outsideField(x, z) {
  if (Math.abs(x) < 6 && Math.abs(z) < 6.2) return false;                 // fenced field
  if (Math.hypot(x + 7.5, z - 3.5) < 3.7) return false;                    // pond
  if (Math.abs(x - 6.5) < 2 && Math.abs(z + 5.5) < 1.8) return false;       // cottage
  return true;
}

function buildDetail(R) {
  const { THREE } = R;
  const grp = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), sv = new THREE.Vector3(), col = new THREE.Color();
  const place = (count, salt, fn) => {
    let n = 0;
    for (let i = 0; n < count && i < count * 6; i++) {
      const x = (decoRand(R, salt + i * 3) - 0.5) * 30, z = (decoRand(R, salt + i * 3 + 1) - 0.5) * 22 + 1;
      if (!outsideField(x, z)) continue;
      fn(n++, x, z, decoRand(R, salt + i * 3 + 2));
    }
    return n;
  };

  // Grass tufts: three-blade cones, colour-varied per instance.
  const tuftGeo = new THREE.ConeGeometry(0.07, 0.42, 4);
  tuftGeo.translate(0, 0.21, 0);
  const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), 420);
  let k = 0;
  place(140, 1000, (n, x, z, r) => {
    for (let b = 0; b < 3; b++) {
      p.set(x + (b - 1) * 0.08, 0, z + (((b * 7) % 3) - 1) * 0.06);
      e.set((b - 1) * 0.35, r * 6, (b - 1) * 0.25); q.setFromEuler(e);
      sv.setScalar(0.7 + r * 0.6);
      tufts.setMatrixAt(k, m4.compose(p, q, sv));
      tufts.setColorAt(k, col.setHSL(0.27 + r * 0.06, 0.45, 0.32 + r * 0.12));
      k++;
    }
  });
  tufts.count = k;
  grp.add(tufts);

  // Wildflowers: small bright heads on the meadow (white, butter yellow, pink, lavender).
  const petals = [0xfafaf0, 0xffe27a, 0xf4a6c6, 0xc6b3ff];
  const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.075, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.6 }), 90);
  flowers.count = place(90, 5000, (n, x, z, r) => {
    p.set(x, 0.16 + r * 0.08, z); q.identity(); sv.set(1, 0.7, 1);
    flowers.setMatrixAt(n, m4.compose(p, q, sv));
    flowers.setColorAt(n, col.setHex(petals[Math.floor(r * petals.length) % petals.length]));
  });
  grp.add(flowers);

  // Pond-edge stones.
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.3, 0),
    new THREE.MeshStandardMaterial({ color: 0x9a978c, roughness: 0.8 }), 18);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + decoRand(R, 9000 + i) * 0.2;
    const r = 3.3 + decoRand(R, 9100 + i) * 0.25;
    p.set(-7.5 + Math.cos(a) * r, 0.02, 3.5 + Math.sin(a) * r);
    e.set(0, decoRand(R, 9200 + i) * 6, 0); q.setFromEuler(e);
    const s = 0.6 + decoRand(R, 9300 + i) * 0.6;
    sv.set(s * 1.2, s * 0.55, s);
    stones.setMatrixAt(i, m4.compose(p, q, sv));
  }
  stones.castShadow = true; stones.receiveShadow = true;
  grp.add(stones);

  // Cottage trim: chimney, door and two warm windows (bright enough to glow under bloom).
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, 0.35), new THREE.MeshStandardMaterial({ color: 0x8c6f5a, roughness: 0.9 }));
  chimney.position.set(7.1, 2.55, -5.9); chimney.castShadow = true;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.04), new THREE.MeshStandardMaterial({ color: 0x6d4a2f, roughness: 0.8 }));
  door.position.set(6.5, 0.45, -4.48);
  const winMat = new THREE.MeshStandardMaterial({ color: 0xffe6a8, emissive: 0xffc766, emissiveIntensity: 0.9, roughness: 0.3 });
  const w1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.04), winMat);
  w1.position.set(5.75, 1.05, -4.48);
  const w2 = w1.clone(); w2.position.x = 7.25;
  grp.add(chimney, door, w1, w2);

  grp.visible = false;
  R.scene.add(grp);
  R.detailGroup = grp;
}

/* ---------- ambient pollen motes — `particles: high`, stopped by reduced motion ---------- */
function buildAmbientParticles(R) {
  const { THREE } = R;
  const N = 70;
  const pos = new Float32Array(N * 3);
  R.moteBase = [];
  for (let i = 0; i < N; i++) {
    const x = (decoRand(R, 20000 + i) - 0.5) * 24, y = 0.4 + decoRand(R, 20100 + i) * 3, z = (decoRand(R, 20200 + i) - 0.5) * 16;
    pos.set([x, y, z], i * 3);
    R.moteBase.push([x, y, z, decoRand(R, 20300 + i) * 6.28]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: 0.11, map: softDotTexture(THREE), transparent: true, depthWrite: false,
    color: new THREE.Color(1.5, 1.4, 1.0), toneMapped: false, opacity: 0.85 });
  R.motes = new THREE.Points(geo, mat);
  R.motes.layers.set(LAYER_FX);
  R.motes.visible = false;
  R.scene.add(R.motes);
}

/* ---------- image-based lighting (RoomEnvironment → PMREM) — `reflections` ---------- */
function buildEnvMap(R) {
  if (R.envTex || !R.addons || !R.addons.RoomEnvironment) return;
  try {
    const pm = new R.THREE.PMREMGenerator(R.renderer);
    const room = new R.addons.RoomEnvironment();
    R.envTex = pm.fromScene(room, 0.04).texture;
    room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    pm.dispose();
  } catch (e) { R.envTex = null; }
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
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x8f6b45, roughness: 0.85 });
  const frameGeoA = new THREE.BoxGeometry(2.0, 0.32, 0.12);
  const frameGeoB = new THREE.BoxGeometry(0.12, 0.32, 1.76);
  for (let i = 0; i < count; i++) {
    const pos = plotPosition(i, count);
    const g = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 1.8), soilMat.clone());
    soil.position.y = 0.15;
    soil.receiveShadow = true;
    soil.userData.plotIndex = i;
    soil.layers.enable(LAYER_GAME);
    g.add(soil);
    // Timber bed frame (scenery detail): top sits just under the selection ring (0.33).
    const frame = new THREE.Group();
    for (let side = 0; side < 4; side++) {
      const along = side < 2;
      const m = new THREE.Mesh(along ? frameGeoA : frameGeoB, frameMat);
      m.position.set(along ? 0 : (side === 2 ? -0.94 : 0.94), 0.16, along ? (side === 0 ? -0.94 : 0.94) : 0);
      m.castShadow = true; m.receiveShadow = true;
      frame.add(m);
    }
    frame.visible = !!(R.q && R.q.detail === 'detailed');
    g.add(frame);
    g.position.set(pos.x, 0, pos.z);
    R.plotGroup.add(g);
    R.plots.push({ group: g, soil: soil, frame: frame, cropMesh: null, soilMat, soilWetMat, index: i });
  }
  R.scene.add(R.plotGroup);
  // Authored topsoil texture, applied only once it decodes; the flat colours
  // above stay as the fallback so plots always read as soil.
  loadSoilTexture(R);
}

let soilTexture; // shared across renderer rebuilds (context loss) — decoded once
function loadSoilTexture(R) {
  // Plot soil materials are per-plot clones (tint tracks watered state), so the
  // decoded map is pushed onto each live plot material rather than a prototype.
  const apply = (tex) => {
    tex.wrapS = tex.wrapT = R.THREE.RepeatWrapping;
    tex.colorSpace = R.THREE.SRGBColorSpace;
    for (const p of R.plots) {
      p.soil.material.map = tex;
      p.soil.material.needsUpdate = true;
    }
  };
  if (soilTexture) { apply(soilTexture); return; }
  try {
    new R.THREE.TextureLoader().load('assets/soil-tile.webp', (tex) => {
      soilTexture = tex;
      apply(tex);
    }, undefined, () => {}); // decode failure: keep the flat-colour fallback
  } catch (e) { /* no texture support: flat colours */ }
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
      sprout.position.y = h / 2 + 0.3; sprout.castShadow = true; g.add(sprout);
    } else {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14),
        new THREE.MeshPhysicalMaterial({ color: 0xe07820, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.35 }));
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
      leaf.castShadow = true;
      g.add(leaf);
    }
    if (stage === 2) {
      const color = crop === 'carrot' ? 0xe87f2e : 0xc9a0dc;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10),
        new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 }));
      bulb.position.y = 0.42; bulb.castShadow = true; g.add(bulb);
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
    // Watered soil darkens. With the authored map the tint is a near-white
    // multiplier (the texture carries the colour); untextured it is the flat soil hue.
    const wet = !!(c && c.watered);
    p.soil.material.color.setHex(p.soil.material.map ? (wet ? 0x8a8a8a : 0xdcdcdc)
                                                     : (wet ? 0x4a3018 : 0x6b4a2e));
    // ready pulse marker
    if (c && c.ready && !p.readyMark) {
      // Slightly over-bright (toneMapped: false) so the bloom pass gives ready crops a halo.
      const mark = new R.THREE.Mesh(new R.THREE.RingGeometry(0.5, 0.62, 24),
        new R.THREE.MeshBasicMaterial({ color: new R.THREE.Color(1.35, 1.1, 0.3), toneMapped: false,
          transparent: true, opacity: 0.85, side: R.THREE.DoubleSide }));
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
  if (R.q && R.q.particles === 'high') n = Math.round(n * 1.5);
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

/* ---------- camera / graphics settings / main loop ---------- */
// Forces a size + pixel-ratio recompute on the next frame (window resize, layout change).
function resize(R) { R.size = [0, 0]; }

/** Apply saved graphics settings (`settings.gfx`; `{}` = Auto). Live — no reload needed. */
function setGraphics(R, saved) {
  if (!R.gfx) return;
  R.saved = saved || {};
  const g = R.gfx.resolve(R.saved, R.detected);
  R.q = g;
  const size = R.gfx.SHADOW_MAP[g.shadows];
  const shadowsWere = R.renderer.shadowMap.enabled;
  R.renderer.shadowMap.enabled = size > 0;
  R.keyLight.castShadow = size > 0;
  if (size > 0 && R.keyLight.shadow.mapSize.x !== size) {
    R.keyLight.shadow.mapSize.set(size, size);
    if (R.keyLight.shadow.map) { R.keyLight.shadow.map.dispose(); R.keyLight.shadow.map = null; }
  }
  // Scenery detail: meadow texture, tufts/flowers/stones, bed frames.
  const detailed = g.detail === 'detailed';
  R.detailGroup.visible = detailed;
  for (const p of R.plots) p.frame.visible = detailed;
  const gm = R.ground.material;
  const wantMap = detailed ? R.grassTex : null;
  if (gm.map !== wantMap) { gm.map = wantMap; gm.needsUpdate = true; }
  // Pond: rippled clear-coat normals with scenery detail (they scroll when water is animated).
  const wantRipple = detailed ? R.rippleTex : null;
  if (R.pondMat.normalMap !== wantRipple) {
    R.pondMat.normalMap = wantRipple;
    R.pondMat.normalScale.set(0.35, 0.35);
    R.pondMat.needsUpdate = true;
  }
  applyEnvironment(R);
  R.adaptiveScale = 1;
  R.frames = [];
  R.postKey = null; // rebuild the post chain on the next frame
  R.size = [0, 0];
  fpsVisible(R, g.showFps);
  R.canvas.dataset.gfxPreset = g.preset;
  document.body.dataset.gfxPreset = g.preset;
  if (shadowsWere !== R.renderer.shadowMap.enabled) {
    // Materials pick up shadow-map changes on recompile.
    R.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  }
}

// IBL on: RoomEnvironment reflections on the pond, crops and roof, with the hemisphere fill
// eased back so the meadow does not wash out. Off: the original hemisphere-only look.
function applyEnvironment(R) {
  const on = R.q && R.q.reflections === 'on' && !!R.envTex;
  R.scene.environment = on ? R.envTex : null;
  R.scene.environmentIntensity = 0.28;
  R.hemi.intensity = on ? 0.7 : 0.9;
}

function setAddons(R, addons) {
  if (!addons) { R.postFailed = true; return; }
  R.addons = addons;
  buildEnvMap(R);
  applyEnvironment(R);
  R.postKey = null;
}

/** What the Settings panel shows: GPU, auto choice, resolved tiers, drawing-buffer size. */
function graphicsInfo(R) {
  return {
    gpu: R.gpu,
    detected: R.detected,
    resolved: R.q,
    pixels: [R.renderer.domElement.width, R.renderer.domElement.height],
    fps: Math.round(R.fps || 0),
    adaptiveScale: Math.round(R.adaptiveScale * 100) / 100,
    postFailed: !!R.postFailed && !!(R.q && R.q.post),
    postActive: !!R.composer,
  };
}

function fpsVisible(R, on) {
  let el = document.getElementById('fps-meter');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'fps-meter';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = '… fps';
    (document.getElementById('playfield') || document.body).append(el);
  }
  if (el) el.hidden = !on;
}

function buildPost(R, w, h) {
  const g = R.q, A = R.addons, THREE = R.THREE;
  if (R.composer) { try { R.composer.dispose(); } catch (e) { /* already gone */ } }
  R.composer = null;
  if (!g.post || !A || R.postFailed) return;
  try {
    const pr = R.pixelRatio;
    const target = new THREE.WebGLRenderTarget(w * pr, h * pr, {
      type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
    });
    const composer = new A.EffectComposer(R.renderer, target);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    composer.addPass(new A.RenderPass(R.scene, R.camera));
    if (g.ao !== 'off') {
      const ao = new A.GTAOPass(R.scene, R.camera, w * pr, h * pr);
      ao.output = A.GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.7;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
      composer.addPass(ao);
    }
    // High threshold: only ready-crop halos, cottage windows, pollen and water glints bloom.
    if (g.bloom === 'on') composer.addPass(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.4, 0.92));
    composer.addPass(new A.OutputPass());
    if (g.grade === 'on') composer.addPass(new A.ShaderPass(GradeShader));
    if (g.antialias === 'smaa') composer.addPass(new A.SMAAPass());
    if (g.antialias === 'fxaa') composer.addPass(new A.FXAAPass());
    R.composer = composer;
  } catch (e) {
    // Post-processing is an enhancement: render directly (the panel says so).
    R.postFailed = true;
    R.composer = null;
  }
}

// Adaptive resolution: average ~90 frames; step down 0.1 when slow (min 0.6), up 0.05 when fast.
function adapt(R, dtMs) {
  const f = R.frames;
  f.push(dtMs);
  if (f.length < 90) return false;
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  f.length = 0;
  R.fps = 1000 / avg;
  const el = document.getElementById('fps-meter');
  if (el && !el.hidden) el.textContent = `${Math.round(R.fps)} fps · ${Math.round(R.pixelRatio * 100) / 100}×`;
  if (!R.q.adaptive) return false;
  const before = R.adaptiveScale;
  if (avg > 26) R.adaptiveScale = Math.max(0.6, R.adaptiveScale - 0.1);
  else if (avg < 14 && R.adaptiveScale < 1) R.adaptiveScale = Math.min(1, R.adaptiveScale + 0.05);
  return before !== R.adaptiveScale;
}

function renderScene(R, dt) {
  const rescale = adapt(R, dt * 1000);
  const w = R.canvas.clientWidth || R.canvas.parentElement.clientWidth || 800;
  const h = R.canvas.clientHeight || R.canvas.parentElement.clientHeight || 600;
  const ratio = Math.min(window.devicePixelRatio || 1, R.q.dpr) * R.q.scale * R.adaptiveScale;
  if (w !== R.size[0] || h !== R.size[1] || ratio !== R.pixelRatio || rescale) {
    R.size = [w, h];
    R.pixelRatio = ratio;
    R.renderer.setPixelRatio(ratio);
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
  }
  const key = R.q.post && R.addons && !R.postFailed ? [R.q.ao, R.q.bloom, R.q.grade, R.q.antialias, w, h, ratio].join('|') : 'none';
  if (key !== R.postKey) { R.postKey = key; buildPost(R, w, h); }
  if (R.composer) {
    try { R.composer.render(dt); return; } catch (e) { R.postFailed = true; R.composer = null; R.postKey = null; }
  }
  R.renderer.render(R.scene, R.camera);
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
  // Ambient motion (paused when hidden; reduced motion stops all of it).
  const moving = !document.hidden && !R.reducedMotion;
  const q = R.q || {};
  if (moving && q.water === 'animated') {
    (R.pondRings || []).forEach((r) => {
      const s = 1 + Math.sin(R.time * 0.8 + r.userData.phase) * 0.06;
      r.scale.setScalar(s);
      r.material.opacity = 0.25 + Math.sin(R.time * 0.8 + r.userData.phase) * 0.12;
    });
    if (R.rippleTex) { R.rippleTex.offset.x = R.time * 0.018; R.rippleTex.offset.y = R.time * 0.011; }
  }
  if (moving && q.wind === 'on') {
    R.trees.forEach((tr, i) => { tr.rotation.z = Math.sin(R.time * 0.5 + i) * 0.015; });
    for (const p of R.plots) {
      if (p.cropMesh) p.cropMesh.rotation.z = Math.sin(R.time * 1.1 + p.index * 0.9) * 0.035;
    }
  }
  // Pollen motes drift on slow, looping paths.
  const motesOn = moving && q.particles === 'high';
  R.motes.visible = motesOn;
  if (motesOn) {
    const arr = R.motes.geometry.attributes.position.array;
    for (let i = 0; i < R.moteBase.length; i++) {
      const b = R.moteBase[i], ph = b[3] + R.time * 0.35;
      arr[i * 3] = b[0] + Math.sin(ph) * 0.8;
      arr[i * 3 + 1] = b[1] + Math.sin(ph * 1.7) * 0.25;
      arr[i * 3 + 2] = b[2] + Math.cos(ph * 0.8) * 0.6;
    }
    R.motes.geometry.attributes.position.needsUpdate = true;
  }
  // selection ring pulse
  if (R.selectionRing.visible && !R.reducedMotion) {
    R.selectionRing.material.opacity = 0.7 + Math.sin(R.time * 4) * 0.25;
  }
  if (state) syncState(R, state, season, {});
  renderScene(R, dt);
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
  setSelected, setHovered, setGhost, raycastPlot, burst, resize, dispose,
  setGraphics, graphicsInfo, setAddons,
  plotPosition,
  setReducedMotion: (R, v) => { R.reducedMotion = v; },
  setPalette: (R, p) => { R.palette = p; R_THREE = R.THREE; },
  setDecorationSeed: (R, s) => { R.decorationSeed = String(s); },
};
})(typeof self !== 'undefined' ? self : globalThis);
