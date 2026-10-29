// The homestead on starhermit:scene, as the browser build's js/render.js drew
// it with three.js r185: the seasonal meadow (sky, fog and grass tinted per
// season and colour palette), the pond with its pulsing rings and rippled
// clear-coat water, seven seeded trees, the farmhouse and fence, the scenery
// detail (meadow texture, grass tufts, wildflowers, pond stones, cottage trim,
// timber bed frames), the plots with their authored topsoil (darker when
// watered), crops per growth stage (seedling, growing, ready with a glowing
// ring), the selection and hover rings, the legal-target ghost, burst particles
// on plant / water / harvest, pollen motes, wind sway and the authored camera
// (drag to orbit within bounds, C resets). Rendering reads rules state and never
// writes it.
//
// From three.js r185 (engine.minor 26): light intensities and shadow box as the page set them;
// RoomEnvironment(renderer), lowered as r183+, + PMREM give the reflections at the old
// environmentIntensity 0.28; the post chain (GTAO, UnrealBloom threshold 0.92,
// the GradeShader in display space, FXAA / SMAA / MSAA) is renderer.ao / bloom /
// grade / antialias; the procedural meadow and ripple textures are baked
// (tools/bake-textures.mjs). The playfield sits between the HUD, rails and tray
// as the old <canvas> did: the camera keeps the playfield's aspect and is
// offset into its rectangle with setViewOffset, so picking takes window
// coordinates. Adaptive resolution, the pixel-ratio cap and the frame-rate
// readout are the runtime's.
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, ConeGeometry,
  CylinderGeometry, DirectionalLight, DodecahedronGeometry, DoubleSide, Euler, Fog, Group, HemisphereLight, IcosahedronGeometry,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera,
  OrthographicCamera, PlaneGeometry, PMREMGenerator, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment,
  SphereGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { frame } from "starhermit:engine";
import type { State } from "./classic.ts";
import type { Look } from "./quality.ts";

const LAYER_GAME = 1;
const PLOT_COLS = 4;
const PLOT_SPACING = 2.2;
const PI = Math.PI;
const SEASON_TINT: Record<string, { sky: number; ground: number; fog: number }> = {
  spring: { sky: 0xbfe3ff, ground: 0x7fbf5f, fog: 0xd6ecff },
  summer: { sky: 0xa8d8ff, ground: 0x6fb84e, fog: 0xcfe8ff },
  autumn: { sky: 0xf3d9a4, ground: 0xb99a4e, fog: 0xf0ddba },
};

renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// Authored camera: low-distortion perspective, fixed framing constants.
const camera = new PerspectiveCamera(38, 1, 0.1, 200);
renderer.camera = camera;
export const CAM_POS = new Vector3(0, 12.5, 15);
const CAM_LOOK = new Vector3(0, 0, -0.5);
camera.position.copy(CAM_POS);
camera.lookAt(CAM_LOOK);
scene.background = new Color(SEASON_TINT.spring!.sky);
scene.fog = new Fog(SEASON_TINT.spring!.fog, 30, 90);

let look: Look | null = null;
let reducedMotion = false;
let palette = "default";
let decorationSeed = "deco";
let time = 0;

function decoRand(i: number): number {
  let h = 2166136261 >>> 0;
  const s = decorationSeed + "|" + i;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
  return h / 4294967296;
}

// -- lights: one dominant warm key (PCF shadows fitted to the homestead) + hemisphere sky/grass fill --------------
const keyLight = new DirectionalLight(0xfff3e0, 2.4);
keyLight.position.set(8, 14, 6);
keyLight.shadow.mapSize = 1024;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.03;
{
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = -12.5; sc.right = 12.5; sc.top = 10.5; sc.bottom = -10.5; sc.near = 4; sc.far = 36;
  sc.updateProjectionMatrix();
}
scene.add(keyLight, keyLight.target);
const hemi = new HemisphereLight(0xcfe8ff, 0x5a7a4a, 0.9);
scene.add(hemi);

// -- textures -----------------------------------------------------------------------------------
const loader = new TextureLoader();
const textures = new Map<string, Texture>();
const pending = new Set<string>();
/** A baked texture (assets/textures/…), applied by `cb` once it has loaded; until then (or on a failure) the
 * flat colours stay. */
function withTexture(path: string, setup: (t: Texture) => void, cb: (t: Texture) => void): void {
  const have = textures.get(path);
  if (have) { cb(have); return; }
  if (pending.has(path)) { waiters.push([path, cb]); return; }
  pending.add(path);
  waiters.push([path, cb]);
  loader.load(path, (tex) => {
    setup(tex);
    textures.set(path, tex);
    pending.delete(path);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]![0] === path) { const [, fn] = waiters.splice(i, 1)[0]!; fn(tex); }
  }, undefined, (e) => { pending.delete(path); console.warn(`${path}: ${e.message}`); });
}
const waiters: [string, (t: Texture) => void][] = [];

/** Soft round sprite for the pollen motes. */
const dotCanvas = new OffscreenCanvas(32, 32);
{
  const g = dotCanvas.getContext("2d");
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
}
const softDot = new CanvasTexture(dotCanvas);

// -- the environment ----------------------------------------------------------------------------
const ground = new Mesh(new PlaneGeometry(120, 120), new MeshStandardMaterial({ color: SEASON_TINT.spring!.ground, roughness: 1 }));
ground.rotation.x = -PI / 2;
ground.position.y = -0.05;
ground.receiveShadow = true;
scene.add(ground);

// Pond: layered discs, animated normals faked with opacity ripple rings.
const pondGroup = new Group();
const pondMesh = new Mesh(new CircleGeometry(3.2, 40), new MeshPhysicalMaterial({
  color: 0x3a78b8, roughness: 0.14, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.06,
}));
pondMesh.rotation.x = -PI / 2;
pondMesh.receiveShadow = true;
pondGroup.add(pondMesh);
const pondRings: Mesh[] = [];
for (let i = 0; i < 2; i++) {
  const ring = new Mesh(new RingGeometry(1 + i * 0.9, 1.15 + i * 0.9, 32),
    new MeshBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.35, side: DoubleSide }));
  ring.rotation.x = -PI / 2;
  ring.position.y = 0.02;
  ring.userData.phase = i * 1.7;
  pondGroup.add(ring);
  pondRings.push(ring);
}
pondGroup.position.set(-7.5, 0.01, 3.5);
scene.add(pondGroup);

// Trees: procedural trunk + foliage tiers, deterministic placement (rebuilt with the decoration seed).
const treeSpots: [number, number][] = [[-9, -4], [-8.5, -1], [8.5, -4.5], [9, -1.5], [7.8, 2.5], [-9.5, 6.5], [9.5, 6]];
let trees: Group[] = [];
const trunkGeo = new CylinderGeometry(0.16, 0.24, 1.4, 8);
const trunkMat = new MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
const foliageMat = new MeshStandardMaterial({ color: 0x3f8f3f, roughness: 0.85 });
function buildTrees(): void {
  for (const t of trees) { scene.remove(t); t.traverse((o) => { if (o instanceof Mesh && o !== t) (o as Mesh).geometry !== trunkGeo && (o as Mesh).geometry.dispose(); }); }
  trees = treeSpots.map((spot, i) => {
    const g = new Group();
    const trunk = new Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.7;
    trunk.castShadow = true;
    g.add(trunk);
    const tiers = 2 + Math.floor(decoRand(i) * 2);
    for (let t = 0; t < tiers; t++) {
      const r = 1.1 - t * 0.3;
      const fol = new Mesh(new ConeGeometry(r, 1.1, 9), foliageMat);
      fol.position.y = 1.5 + t * 0.75;
      fol.castShadow = true;
      g.add(fol);
    }
    g.scale.setScalar(0.8 + decoRand(i + 40) * 0.5);
    g.position.set(spot[0], 0, spot[1]);
    scene.add(g);
    return g;
  });
  if (look) applyMaterialTier(scene);
}
buildTrees();

// Farmhouse.
const house = new Group();
const walls = new Mesh(new BoxGeometry(2.6, 1.8, 2), new MeshStandardMaterial({ color: 0xd9c8a8, roughness: 0.9 }));
walls.position.y = 0.9; walls.castShadow = true; walls.receiveShadow = true;
const roof = new Mesh(new ConeGeometry(2.1, 1.2, 4), new MeshStandardMaterial({ color: 0xa8543c, roughness: 0.8 }));
roof.position.y = 2.4; roof.rotation.y = PI / 4; roof.castShadow = true;
house.add(walls, roof);
house.position.set(6.5, 0, -5.5);
scene.add(house);

// Fence around the field.
{
  const fenceMat = new MeshStandardMaterial({ color: 0x9a7b52, roughness: 0.95 });
  const fence = new Group();
  const w = PLOT_COLS * PLOT_SPACING + 1.2;
  const d = 5 * PLOT_SPACING + 1.2;
  const postGeo = new BoxGeometry(0.12, 0.7, 0.12);
  for (let i = 0; i <= 8; i++) {
    for (const z of [-d / 2 - 0.6, d / 2 + 0.6]) {
      const post = new Mesh(postGeo, fenceMat);
      post.castShadow = true;
      post.position.set(-w / 2 + (w / 8) * i, 0.35, z);
      fence.add(post);
    }
  }
  const railGeo = new BoxGeometry(w, 0.08, 0.08);
  for (const z of [-d / 2 - 0.6, d / 2 + 0.6]) {
    const rail = new Mesh(railGeo, fenceMat);
    rail.position.set(0, 0.5, z);
    rail.castShadow = true;
    fence.add(rail);
  }
  scene.add(fence);
}

/* Scenery detail (grass tufts, wildflowers, pond stones, cottage trim) — `detailed`. */
function outsideField(x: number, z: number): boolean {
  if (Math.abs(x) < 6 && Math.abs(z) < 6.2) return false; // fenced field
  if (Math.hypot(x + 7.5, z - 3.5) < 3.7) return false; // pond
  if (Math.abs(x - 6.5) < 2 && Math.abs(z + 5.5) < 1.8) return false; // cottage
  return true;
}
const TUFT_MAX = 280;
const detailGroup = new Group();
let tufts: InstancedMesh;
let tuftsBuilt = 0;
let flowers: InstancedMesh;
function buildDetail(): void {
  for (const c of [...detailGroup.children]) detailGroup.remove(c);
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler();
  const p = new Vector3(), sv = new Vector3(), col = new Color();
  const place = (count: number, salt: number, fn: (n: number, x: number, z: number, r: number) => void): number => {
    let n = 0;
    for (let i = 0; n < count && i < count * 6; i++) {
      const x = (decoRand(salt + i * 3) - 0.5) * 30, z = (decoRand(salt + i * 3 + 1) - 0.5) * 22 + 1;
      if (!outsideField(x, z)) continue;
      fn(n++, x, z, decoRand(salt + i * 3 + 2));
    }
    return n;
  };
  // Grass tufts: three-blade cones, colour-varied per instance; built at the largest budget, the preset draws
  // its share (budget.tufts clumps × 3 blades).
  const tuftGeo = new ConeGeometry(0.07, 0.42, 4);
  tuftGeo.translate(0, 0.21, 0);
  tufts = new InstancedMesh(tuftGeo, new MeshStandardMaterial({ roughness: 0.85 }), TUFT_MAX * 3);
  let k = 0;
  place(TUFT_MAX, 1000, (_n, x, z, r) => {
    for (let b = 0; b < 3; b++) {
      p.set(x + (b - 1) * 0.08, 0, z + (((b * 7) % 3) - 1) * 0.06);
      e.set((b - 1) * 0.35, r * 6, (b - 1) * 0.25); q.setFromEuler(e);
      sv.setScalar(0.7 + r * 0.6);
      tufts.setMatrixAt(k, m4.compose(p, q, sv));
      tufts.setColorAt(k, col.setHSL(0.27 + r * 0.06, 0.45, 0.32 + r * 0.12));
      k++;
    }
  });
  tuftsBuilt = k;
  tufts.count = k;
  detailGroup.add(tufts);
  // Wildflowers: small bright heads on the meadow (white, butter yellow, pink, lavender).
  const petals = [0xfafaf0, 0xffe27a, 0xf4a6c6, 0xc6b3ff];
  flowers = new InstancedMesh(new IcosahedronGeometry(0.075, 0), new MeshStandardMaterial({ roughness: 0.6 }), 90);
  flowers.count = place(90, 5000, (n, x, z, r) => {
    p.set(x, 0.16 + r * 0.08, z); q.identity(); sv.set(1, 0.7, 1);
    flowers.setMatrixAt(n, m4.compose(p, q, sv));
    flowers.setColorAt(n, col.setHex(petals[Math.floor(r * petals.length) % petals.length]!));
  });
  detailGroup.add(flowers);
  // Pond-edge stones.
  const stones = new InstancedMesh(new DodecahedronGeometry(0.3, 0), new MeshStandardMaterial({ color: 0x9a978c, roughness: 0.8 }), 18);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * PI * 2 + decoRand(9000 + i) * 0.2;
    const r = 3.3 + decoRand(9100 + i) * 0.25;
    p.set(-7.5 + Math.cos(a) * r, 0.02, 3.5 + Math.sin(a) * r);
    e.set(0, decoRand(9200 + i) * 6, 0); q.setFromEuler(e);
    const s = 0.6 + decoRand(9300 + i) * 0.6;
    sv.set(s * 1.2, s * 0.55, s);
    stones.setMatrixAt(i, m4.compose(p, q, sv));
  }
  stones.castShadow = true; stones.receiveShadow = true;
  detailGroup.add(stones);
  // Cottage trim: chimney, door and two warm windows (bright enough to glow under bloom).
  const chimney = new Mesh(new BoxGeometry(0.35, 0.9, 0.35), new MeshStandardMaterial({ color: 0x8c6f5a, roughness: 0.9 }));
  chimney.position.set(7.1, 2.55, -5.9); chimney.castShadow = true;
  const door = new Mesh(new BoxGeometry(0.5, 0.9, 0.04), new MeshStandardMaterial({ color: 0x6d4a2f, roughness: 0.8 }));
  door.position.set(6.5, 0.45, -4.48);
  const winMat = new MeshStandardMaterial({ color: 0xffe6a8, emissive: 0xffc766, emissiveIntensity: 0.9, roughness: 0.3 });
  const winGeo = new BoxGeometry(0.42, 0.38, 0.04);
  const w1 = new Mesh(winGeo, winMat);
  w1.position.set(5.75, 1.05, -4.48);
  const w2 = new Mesh(winGeo, winMat);
  w2.position.set(7.25, 1.05, -4.48);
  detailGroup.add(chimney, door, w1, w2);
  if (look) {
    tufts.count = Math.min(tuftsBuilt, look.budget.tufts * 3);
    applyMaterialTier(detailGroup);
  }
}
detailGroup.visible = false;
scene.add(detailGroup);
buildDetail();

/* Ambient pollen motes — `particles: high`, stopped by reduced motion. */
const MOTE_MAX = 240;
const motePos = new Float32Array(MOTE_MAX * 3);
let moteBase: [number, number, number, number][] = [];
let moteCount = 70;
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const motes = new Points(moteGeo, new PointsMaterial({
  size: 0.11, map: softDot, transparent: true, depthWrite: false, color: new Color(1.5, 1.4, 1.0), toneMapped: false, opacity: 0.85,
}));
motes.visible = false;
scene.add(motes);
function buildMotes(): void {
  moteBase = [];
  for (let i = 0; i < MOTE_MAX; i++) {
    const x = (decoRand(20000 + i) - 0.5) * 24, y = 0.4 + decoRand(20100 + i) * 3, z = (decoRand(20200 + i) - 0.5) * 16;
    motePos.set([x, y, z], i * 3);
    moteBase.push([x, y, z, decoRand(20300 + i) * 6.28]);
  }
  (moteGeo.attributes.position as BufferAttribute).needsUpdate = true;
}
buildMotes();

// -- plots ----------------------------------------------------------------------------------------
interface PlotView { group: Group; soil: Mesh; frame: Group; cropMesh: Group | null; readyMark: Mesh | null; index: number }
let plots: PlotView[] = [];
const plotGroup = new Group();
scene.add(plotGroup);
const frameMat = new MeshStandardMaterial({ color: 0x8f6b45, roughness: 0.85 });
const frameGeoA = new BoxGeometry(2.0, 0.32, 0.12);
const frameGeoB = new BoxGeometry(0.12, 0.32, 1.76);
const soilGeo = new BoxGeometry(1.8, 0.3, 1.8);
let soilTexture: Texture | null = null;

/** Count defaults to the standard 12-plot field; journey stages use 8 or 16 plots, centred on their own rows. */
export function plotPosition(index: number, count: number): { x: number; z: number } {
  const col = index % PLOT_COLS;
  const row = Math.floor(index / PLOT_COLS);
  const rows = Math.ceil((count || 12) / PLOT_COLS);
  return { x: (col - (PLOT_COLS - 1) / 2) * PLOT_SPACING, z: (row - (rows - 1) / 2) * PLOT_SPACING };
}
function buildPlots(count: number): void {
  for (const p of plots) { plotGroup.remove(p.group); disposeTree(p.group, true); }
  plots = [];
  for (let i = 0; i < count; i++) {
    const pos = plotPosition(i, count);
    const g = new Group();
    const soil = new Mesh(soilGeo, new MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1, map: soilTexture }));
    soil.position.y = 0.15;
    soil.receiveShadow = true;
    soil.userData.plotIndex = i;
    soil.layers.enable(LAYER_GAME);
    g.add(soil);
    // Timber bed frame (scenery detail): its top sits just under the selection ring (0.33).
    const fr = new Group();
    for (let side = 0; side < 4; side++) {
      const along = side < 2;
      const m = new Mesh(along ? frameGeoA : frameGeoB, frameMat);
      m.position.set(along ? 0 : (side === 2 ? -0.94 : 0.94), 0.16, along ? (side === 0 ? -0.94 : 0.94) : 0);
      m.castShadow = true; m.receiveShadow = true;
      fr.add(m);
    }
    fr.visible = !!look?.detailed;
    g.add(fr);
    g.position.set(pos.x, 0, pos.z);
    plotGroup.add(g);
    plots.push({ group: g, soil, frame: fr, cropMesh: null, readyMark: null, index: i });
  }
  if (look) applyMaterialTier(plotGroup);
  // Authored topsoil texture, applied once it decodes; the flat colours stay as the fallback.
  withTexture("assets/soil-tile.webp", (tex) => { tex.wrapS = tex.wrapT = RepeatWrapping; tex.colorSpace = SRGBColorSpace; }, (tex) => {
    soilTexture = tex;
    for (const p of plots) { const m = p.soil.material as MeshStandardMaterial; if (m.map !== tex) { m.map = tex; } }
    if (currentState) syncState(currentState, currentSeason, true);
  });
}
buildPlots(12);

const sproutMat = new MeshStandardMaterial({ color: 0x5fae4f, roughness: 0.8 });
const stemMat = new MeshStandardMaterial({ color: 0x4f9a3f, roughness: 0.8 });
const leafMat = new MeshStandardMaterial({ color: 0x63b34d, roughness: 0.8 });
const pumpkinStemMat = new MeshStandardMaterial({ color: 0x4a7a3a });
/** stage: 0 seedling, 1 growing, 2 ready. */
function buildCropMesh(crop: string, stage: number): Group {
  const g = new Group();
  const h = [0.35, 0.7, 1.0][stage]!;
  if (crop === "pumpkin") {
    if (stage < 2) {
      const sprout = new Mesh(new ConeGeometry(0.16, h, 6), sproutMat);
      sprout.position.y = h / 2 + 0.3; sprout.castShadow = true; g.add(sprout);
    } else {
      const body = new Mesh(new SphereGeometry(0.55, 20, 14),
        new MeshPhysicalMaterial({ color: 0xe07820, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.35 }));
      body.position.y = 0.75; body.scale.y = 0.8; body.castShadow = true; g.add(body);
      const stem = new Mesh(new CylinderGeometry(0.05, 0.07, 0.3, 6), pumpkinStemMat);
      stem.position.y = 1.25; g.add(stem);
    }
  } else {
    const stem = new Mesh(new CylinderGeometry(0.04, 0.06, h, 6), stemMat);
    stem.position.y = h / 2 + 0.3; stem.castShadow = true; g.add(stem);
    const leaves = 3 + stage * 2;
    const leafGeo = new ConeGeometry(0.1 + stage * 0.03, 0.35, 5);
    for (let i = 0; i < leaves; i++) {
      const leaf = new Mesh(leafGeo, leafMat);
      const a = (i / leaves) * PI * 2;
      leaf.position.set(Math.cos(a) * 0.18, h + 0.25, Math.sin(a) * 0.18);
      leaf.rotation.set(Math.cos(a) * 0.7, 0, -Math.sin(a) * 0.7);
      leaf.castShadow = true;
      g.add(leaf);
    }
    if (stage === 2) {
      const color = crop === "carrot" ? 0xe87f2e : 0xc9a0dc;
      const bulb = new Mesh(new SphereGeometry(0.22, 14, 10),
        new MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 }));
      bulb.position.y = 0.42; bulb.castShadow = true; g.add(bulb);
    }
  }
  return g;
}
const SHARED = new Set<Material>([sproutMat, stemMat, leafMat, pumpkinStemMat, frameMat, trunkMat, foliageMat]);

// -- selection, hover and the legal-target ghost --------------------------------------------------------------
const ringGeo = new RingGeometry(1.0, 1.15, 32);
const selectionRing = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, side: DoubleSide }));
selectionRing.rotation.x = -PI / 2;
selectionRing.position.y = 0.34;
selectionRing.visible = false;
scene.add(selectionRing);
const hoverRing = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: DoubleSide }));
hoverRing.rotation.x = -PI / 2;
hoverRing.position.y = 0.33;
hoverRing.visible = false;
scene.add(hoverRing);
const ghostMat = new MeshBasicMaterial({ color: 0x7fe07f, transparent: true, opacity: 0.45 });
const ghost = new Mesh(new CircleGeometry(0.7, 24), ghostMat);
ghost.rotation.x = -PI / 2;
ghost.visible = false;
scene.add(ghost);

export function setSelected(i: number): void {
  if (i >= 0 && plots[i]) {
    const pos = plotPosition(i, plots.length);
    selectionRing.position.set(pos.x, 0.34, pos.z);
    selectionRing.visible = true;
  } else selectionRing.visible = false;
}
export function setHovered(i: number): void {
  if (i >= 0 && plots[i]) {
    const pos = plotPosition(i, plots.length);
    hoverRing.position.set(pos.x, 0.33, pos.z);
    hoverRing.visible = true;
  } else hoverRing.visible = false;
}
/** The legal-target preview on a plot: green when the tool may act there, red when not; -1 hides it. */
export function setGhost(plot: number, valid: boolean): void {
  if (plot < 0 || !plots[plot]) { ghost.visible = false; return; }
  ghostMat.color.setHex(valid ? 0x7fe07f : 0xe05f5f);
  const pos = plotPosition(plot, plots.length);
  ghost.position.set(pos.x, 0.36, pos.z);
  ghost.visible = true;
}

// -- state sync ------------------------------------------------------------------------------------
interface Tween { obj: Object3D; t: number; from: number; scale: number; dur: number }
const tweens: Tween[] = [];
let currentState: State | null = null;
let currentSeason = "spring";
function syncState(state: State, season: string, instant: boolean): void {
  if (plots.length !== state.plots.length) buildPlots(state.plots.length);
  for (let i = 0; i < state.plots.length; i++) {
    const p = plots[i]!;
    const c = state.plots[i]!.crop;
    const wantStage = c ? (c.ready ? 2 : (c.age > 0 ? 1 : 0)) : -1;
    const cur = p.cropMesh ? p.cropMesh.userData.key as string : null;
    const key = c ? c.type + ":" + wantStage : null;
    if (key !== cur) {
      if (p.cropMesh) { p.group.remove(p.cropMesh); disposeTree(p.cropMesh, false); p.cropMesh = null; }
      if (c) {
        const m = buildCropMesh(c.type, wantStage);
        if (look) applyMaterialTier(m);
        m.userData.key = key;
        p.group.add(m);
        p.cropMesh = m;
        if (!instant && !reducedMotion) {
          m.scale.setScalar(0.01);
          tweens.push({ obj: m, t: 0, from: 0.01, scale: 1, dur: 0.35 });
        }
      }
    }
    // Watered soil darkens. With the authored map the tint is a near-white multiplier (the texture carries the
    // colour); untextured it is the flat soil hue.
    const wet = !!(c && c.watered);
    const sm = p.soil.material as MeshStandardMaterial | MeshLambertMaterial;
    sm.color.setHex(sm.map ? (wet ? 0x8a8a8a : 0xdcdcdc) : (wet ? 0x4a3018 : 0x6b4a2e));
    // Ready pulse marker: slightly over-bright (toneMapped false) so the bloom pass gives ready crops a halo.
    if (c && c.ready && !p.readyMark) {
      const mark = new Mesh(new RingGeometry(0.5, 0.62, 24),
        new MeshBasicMaterial({ color: new Color(1.35, 1.1, 0.3), toneMapped: false, transparent: true, opacity: 0.85, side: DoubleSide }));
      mark.rotation.x = -PI / 2; mark.position.y = 0.36;
      p.group.add(mark);
      p.readyMark = mark;
    } else if ((!c || !c.ready) && p.readyMark) {
      p.group.remove(p.readyMark); disposeTree(p.readyMark, false); p.readyMark = null;
    }
  }
  const tint = SEASON_TINT[season] ?? SEASON_TINT.spring!;
  (scene.background as Color).setHex(adjustForPalette(tint.sky));
  scene.fog!.color.setHex(adjustForPalette(tint.fog));
  (ground.material as MeshStandardMaterial).color.setHex(adjustForPalette(tint.ground));
}
const hsl = { h: 0, s: 0, l: 0 };
function adjustForPalette(hex: number): number {
  if (palette === "default") return hex;
  const c = new Color(hex);
  const hueShift = (deg: number): void => { c.getHSL(hsl); c.setHSL((hsl.h + deg / 360 + 1) % 1, hsl.s, hsl.l); };
  if (palette === "deuteranopia") hueShift(30);
  else if (palette === "protanopia") hueShift(-25);
  else if (palette === "tritanopia") hueShift(60);
  else if (palette === "high-contrast") {
    c.getHSL(hsl);
    c.setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l > 0.5 ? Math.min(0.9, hsl.l * 1.15) : hsl.l * 0.8);
  }
  return c.getHex();
}

/** Shows a state (render.js sync): crops per stage, wet soil, ready rings, the season's tints. */
export function sync(state: State | null, season: string, instant = false): void {
  currentState = state;
  currentSeason = season;
  if (state) syncState(state, season, instant);
}

// -- particles (pooled, bounded) ------------------------------------------------------------------
interface Particle { mesh: Mesh; vel: Vector3; life: number }
const particles: Particle[] = [];
const burstGeo = new SphereGeometry(0.06, 6, 4);
const pool: Mesh[] = [];
/** render.js burst: n coloured specks thrown up from a plot (×1.5 at Particles high), within the preset's cap. */
export function burst(plot: number, color: number, nIn: number): void {
  if (reducedMotion || !nIn || !plots[plot]) return;
  let n = nIn;
  if (look?.particles === "high") n = Math.round(n * 1.5);
  const pos = plotPosition(plot, plots.length);
  const cap = look?.budget.burst ?? 80;
  for (let i = 0; i < n && particles.length < cap; i++) {
    const m = pool.pop() ?? new Mesh(burstGeo, new MeshBasicMaterial({ color }));
    (m.material as MeshBasicMaterial).color.setHex(color);
    m.position.set(pos.x, 0.8, pos.z);
    m.visible = true;
    const a = (i / n) * PI * 2;
    scene.add(m);
    particles.push({ mesh: m, vel: new Vector3(Math.cos(a) * 1.6, 2.4 + (i % 3), Math.sin(a) * 1.6), life: 0.7 });
  }
}

// -- materials per budget ----------------------------------------------------------------------------
/* Shading-model variants (budget.material): Lambert on Low, Standard on Balanced, the authored
   Standard/Physical (clear-coated pond and ripe crops) on High/Ultra. Variants are cached on the authored
   material, so shared materials stay shared; the live colour/map/normal map carry over on a switch. */
type Lit = MeshStandardMaterial | MeshPhysicalMaterial | MeshLambertMaterial;
const variants = new WeakMap<Material, Record<string, Lit>>();
function materialVariant(a: MeshStandardMaterial, tier: string): Lit {
  const kind = a instanceof MeshPhysicalMaterial ? "physical" : "standard";
  const want = tier === "lambert" ? "lambert" : (tier === "standard" && kind === "physical") ? "standard" : kind;
  if (want === kind) return a;
  let cache = variants.get(a);
  if (!cache) { cache = {}; variants.set(a, cache); }
  if (cache[want]) return cache[want]!;
  const common = {
    color: a.color.clone(), map: a.map, emissive: a.emissive.clone(), emissiveIntensity: a.emissiveIntensity,
    transparent: a.transparent, opacity: a.opacity, side: a.side,
  };
  const m: Lit = want === "lambert" ? new MeshLambertMaterial(common)
    : new MeshStandardMaterial({ ...common, roughness: a.roughness, metalness: a.metalness, normalMap: a.normalMap });
  if (want !== "lambert" && a.normalMap) (m as MeshStandardMaterial).normalScale.copy(a.normalScale);
  cache[want] = m;
  return m;
}
function applyMaterialTier(root: Object3D): void {
  const tier = look?.budget.material ?? "physical";
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!(mesh instanceof Mesh) || !mesh.material || Array.isArray(mesh.material)) return;
    const authored = (mesh.userData.matAuthored as MeshStandardMaterial | undefined) ?? mesh.material as MeshStandardMaterial;
    if (!(authored instanceof MeshStandardMaterial)) return; // basic / points stay as they are
    mesh.userData.matAuthored = authored;
    const cur = mesh.material as Lit, next = materialVariant(authored, tier);
    if (next === cur) return;
    next.color.copy(cur.color);
    if (next.map !== cur.map) { next.map = cur.map; }
    mesh.material = next;
  });
}
function disposeTree(root: Object3D, keepGeometry: boolean): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!(m instanceof Mesh)) return;
    if (!keepGeometry && m.geometry !== burstGeo && m.geometry !== soilGeo && m.geometry !== frameGeoA && m.geometry !== frameGeoB) m.geometry.dispose();
    const authored = m.userData.matAuthored as Material | undefined;
    for (const mat of [m.material as Material, authored]) {
      if (!mat || SHARED.has(mat)) continue;
      mat.dispose();
      for (const v of Object.values(variants.get(mat) ?? {})) v.dispose();
    }
  });
}

// -- graphics level -------------------------------------------------------------------------------
let envMap: Texture | null = null;
/** IBL on: RoomEnvironment reflections on the pond, crops and roof, with the hemisphere fill eased back so the
 * meadow does not wash out. Off: the hemisphere-only look. */
function applyEnvironment(): void {
  const on = !!look?.reflections;
  if (on && !envMap) {
    try {
      const room = new RoomEnvironment(renderer);
      room.position.y = -3.5; // three.js r183+ lowers the room
      envMap = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  scene.environment = on ? envMap : null;
  scene.environmentIntensity = 0.28;
  hemi.intensity = on && envMap ? 0.7 : 0.9;
}
/** The graphics level's look (quality.ts): post effects, shadows, shading model, textures, detail and budgets. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only ready-crop halos, cottage windows, pollen and water glints bloom.
  renderer.bloom = next.bloom ? { strength: 0.4, radius: 0.4, threshold: 0.92, resolution: b.bloomRes } : null;
  // render.js GradeShader (display space, after the output): a gentle S-curve that adds contrast, +7 % saturation,
  // warm highlights / cool shadows, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.18, saturation: 1.07,
    shadows: [0.97, 0.99, 1.04], highlights: [1.035, 1.0, 0.965], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.85, scale: [1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  const on = next.shadows > 0;
  renderer.shadowMap.enabled = on;
  keyLight.castShadow = on;
  if (on) keyLight.shadow.mapSize = next.shadows;
  // Scenery detail: meadow texture, tufts/flowers/stones/trim, bed frames, the rippled pond.
  detailGroup.visible = next.detailed;
  for (const p of plots) p.frame.visible = next.detailed;
  tufts.count = Math.min(tuftsBuilt, b.tufts * 3);
  moteCount = Math.min(MOTE_MAX, b.motes);
  moteGeo.setDrawRange(0, moteCount);
  applyMaterialTier(scene);
  const gm = ground.material as MeshStandardMaterial;
  const pm = pondMesh.material as MeshStandardMaterial;
  const grassPath = `assets/textures/grass-${Math.max(256, b.texture)}.png`;
  const ripplePath = `assets/textures/ripple-${Math.max(128, b.texture / 2)}.png`;
  if (next.detailed) {
    withTexture(grassPath, (t) => { t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(36, 36); t.colorSpace = SRGBColorSpace; t.anisotropy = 4; }, (t) => {
      const m = ground.material as MeshStandardMaterial;
      if (look?.detailed && m.map !== t && grassPath === `assets/textures/grass-${Math.max(256, look.budget.texture)}.png`) { m.map = t; }
    });
    withTexture(ripplePath, (t) => { t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(2.5, 2.5); }, (t) => {
      const m = pondMesh.material as MeshStandardMaterial;
      if (look?.detailed && m.normalMap !== t && ripplePath === `assets/textures/ripple-${Math.max(128, look.budget.texture / 2)}.png`) {
        m.normalMap = t; m.normalScale.set(0.35, 0.35);
      }
    });
  } else {
    if (gm.map) { gm.map = null; }
    if (pm.normalMap) { pm.normalMap = null; }
  }
  applyEnvironment();
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) {
    for (const tw of tweens) tw.obj.scale.setScalar(tw.scale);
    tweens.length = 0;
    for (const p of particles) { scene.remove(p.mesh); pool.push(p.mesh); }
    particles.length = 0;
  }
}
export function setPalette(p: string): void {
  if (p === palette) return;
  palette = p;
  if (currentState) syncState(currentState, currentSeason, true);
  else {
    const tint = SEASON_TINT[currentSeason] ?? SEASON_TINT.spring!;
    (scene.background as Color).setHex(adjustForPalette(tint.sky));
    scene.fog!.color.setHex(adjustForPalette(tint.fog));
    (ground.material as MeshStandardMaterial).color.setHex(adjustForPalette(tint.ground));
  }
}
/** A session's seed places the trees, tufts, flowers, stones and motes (render.js setDecorationSeed). */
export function setDecorationSeed(seed: string): void {
  if (String(seed) === decorationSeed) return;
  decorationSeed = String(seed);
  buildTrees();
  buildDetail();
  buildMotes();
}

// -- camera and picking ----------------------------------------------------------------------------
/** The playfield's window rectangle (px): the camera keeps its aspect and draws into it. */
const pf = { x: 0, y: 0, w: 0, h: 0 };
export function setPlayfield(x: number, y: number, w: number, h: number): void { pf.x = x; pf.y = y; pf.w = w; pf.h = h; }
/** Drag orbit: the camera slides sideways within ±4 and keeps looking at the field. */
export function orbit(dxPx: number): void {
  camera.position.x = Math.max(-4, Math.min(4, camera.position.x - dxPx * 0.01));
  camera.lookAt(CAM_LOOK);
}
export function resetCamera(): void { camera.position.copy(CAM_POS); camera.lookAt(CAM_LOOK); }
const raycaster = new Raycaster();
raycaster.layers.set(LAYER_GAME);
const ndc = new Vector2();
/** The plot under a window point (px), or -1. */
export function plotAt(x: number, y: number): number {
  const f = frame();
  if (f.width <= 0 || f.height <= 0 || pf.w <= 0) return -1;
  if (x < pf.x || y < pf.y || x > pf.x + pf.w || y > pf.y + pf.h) return -1;
  ndc.set((x / f.width) * 2 - 1, -(y / f.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(plots.map((p) => p.soil), false);
  return hits.length ? (hits[0]!.object.userData.plotIndex as number) : -1;
}

// -- the frame -------------------------------------------------------------------------------------
/** render.js frame(): tweens, particles, ambient motion (water, wind, pollen), the selection pulse, the camera
 * fitted to the playfield. */
export function update(dtIn: number): void {
  const f = frame();
  const dt = Math.min(0.1, Math.max(0, dtIn));
  time += dt;
  if (f.width > 0 && f.height > 0) {
    const w = pf.w > 0 ? pf.w : f.width, h = pf.h > 0 ? pf.h : f.height;
    const aspect = w / h;
    // Narrow (portrait) playfields: widen the vertical FOV so the horizontal view never drops below an 0.85
    // aspect's, keeping all four plot columns in view.
    const MIN_ASPECT = 0.85, BASE_FOV = 38;
    const fov = aspect >= MIN_ASPECT ? BASE_FOV : 2 * Math.atan(Math.tan((BASE_FOV / 2) * PI / 180) * MIN_ASPECT / aspect) * 180 / PI;
    const v = camera.view;
    const key = !v || !v.enabled || v.fullWidth !== w || v.fullHeight !== h || v.offsetX !== -pf.x || v.offsetY !== -pf.y || v.width !== f.width || v.height !== f.height;
    if (aspect !== camera.aspect || fov !== camera.fov || key) {
      camera.aspect = aspect;
      camera.fov = fov;
      if (pf.w > 0) camera.setViewOffset(w, h, -pf.x, -pf.y, f.width, f.height);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
  }
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]!;
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    const e = 1 - Math.pow(1 - k, 3);
    tw.obj.scale.setScalar(tw.from + (tw.scale - tw.from) * e);
    if (k >= 1) { tw.obj.scale.setScalar(tw.scale); tweens.splice(i, 1); }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life -= dt;
    p.mesh.position.x += p.vel.x * dt;
    p.mesh.position.y += p.vel.y * dt;
    p.mesh.position.z += p.vel.z * dt;
    p.vel.y -= 6 * dt;
    if (p.life <= 0) { scene.remove(p.mesh); pool.push(p.mesh); particles.splice(i, 1); }
  }
  const moving = !reducedMotion;
  if (moving && look?.waterAnimated) {
    for (const r of pondRings) {
      const ph = r.userData.phase as number;
      r.scale.setScalar(1 + Math.sin(time * 0.8 + ph) * 0.06);
      (r.material as MeshBasicMaterial).opacity = 0.25 + Math.sin(time * 0.8 + ph) * 0.12;
    }
    const nm = (pondMesh.material as MeshStandardMaterial).normalMap;
    if (nm) { nm.offset.x = time * 0.018; nm.offset.y = time * 0.011; }
  }
  if (moving && look?.wind) {
    trees.forEach((tr, i) => { tr.rotation.z = Math.sin(time * 0.5 + i) * 0.015; });
    for (const p of plots) if (p.cropMesh) p.cropMesh.rotation.z = Math.sin(time * 1.1 + p.index * 0.9) * 0.035;
  }
  const motesOn = moving && look?.particles === "high";
  motes.visible = motesOn;
  if (motesOn) {
    for (let i = 0; i < moteCount; i++) {
      const b = moteBase[i]!, ph = b[3] + time * 0.35;
      motePos[i * 3] = b[0] + Math.sin(ph) * 0.8;
      motePos[i * 3 + 1] = b[1] + Math.sin(ph * 1.7) * 0.25;
      motePos[i * 3 + 2] = b[2] + Math.cos(ph * 0.8) * 0.6;
    }
    (moteGeo.attributes.position as BufferAttribute).needsUpdate = true;
  }
  if (selectionRing.visible && !reducedMotion) (selectionRing.material as MeshBasicMaterial).opacity = 0.7 + Math.sin(time * 4) * 0.25;
}
