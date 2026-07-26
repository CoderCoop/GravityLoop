// GravityLoop — spaceship golf across gravity-well terrain.
import * as THREE from '../vendor/three.module.js';
import {
  STEP, PREDICT_T, bodiesAt, hazardsAt, heightAt, checkState, stepShip, predict,
  activeTarget, legStart, legCount, launchFuelCost, maxAffordableLaunch,
  anchorX, anchorZ, SHIP_R,
} from './physics.js';
import { LEVELS, SETS } from './levels.js';
import { CHANGELOG, VERSION } from './changelog.js';
import * as sfx from './audio.js';
import * as tx from './textures.js';

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const GRID_N = 161;           // terrain vertices per side
const DEFORM_EPS = 0.12;      // world units a body must move to redraw terrain
const AIM_SCALE = 1.15;       // drag distance -> launch speed
const FINE_MAX = 12;          // deepest fine ratio at a near-still pointer
const FINE_V_HI = 320;        // px/s — at or above, 1:1 response
const MIN_LAUNCH = 6;
const THRUST_ACCEL = 16;
const CARGO_THRUST_FACTOR = 0.55;
const TRAIL_MAX = 260;
const PREDICT_MAX = 1400;     // max prediction points uploaded to the GPU
const PICKUP_R = 3.5;

const SAVE_KEY = 'gravityloop-save-v2';

let renderer, scene, camera;
let terrain;
let bodyVisuals = [];         // [{ group, body, spin, discSpin? }]
let orbitVisuals = [];        // dotted orbit rings, one per orbiting body
let lastCrash = null;         // last body collision, for the collision test hook
let shipBob = 0;              // idle hover offset, reported to the contract test
let camDriftFrom = null;      // ship position last frame, while parked
let hazardVisuals = [];       // [{ group, hazard, prev }]
let pickupVisuals = [];       // [{ group, pickup, index }]
let waypointVisuals = [];     // [{ group, wp, ringMat, glow }]
let shipGroup, engineSprite, cargoBox, trailLine, trailPts = [];
let predictLine, predictDots, predictMarker, aimArrow, aimDial;
let aimAnchor, aimHandle, aimBand;
let goalGroup, padGroup;
let fxList = [];

let level = null, levelIndex = 0, displaySet = 0;
let frameCount = 0;
let vTime = 0;                // cosmetic clock — never pauses (pulses, spins, bobbing)
let state = 'menu';           // menu | ready | aiming | flying | docked | crashed | won
let simTime = 0;
let physAcc = 0;
let ship = { x: 0, z: 0, vx: 0, vz: 0 };
let fuel = 0, legStartFuel = 0, attempts = 0;
let stage = 0, carrying = false;
let pickupsDone = new Set(), pickupsTemp = new Set();
let dockAnim = null;          // { fromX, fromZ, toX, toZ, t, index }
let aim = null;
let aimSmooth = null;          // low-pass filtered touch aim (kills hand tremor)
let aimFine = null;            // gain-remapped aim point (slow drags move it finer)
let aimFinePrev = null;        // last pointer sample for the speed estimate
let fineActive = false;
let fineGain = 1;
let aimHist = [];              // recent smoothed aims for release rollback
let launchVel = { x: 0, z: 0 };
let pointers = new Map();     // active pointerId -> {x, y}
let aimPointerId = null;
let gesture = null;           // two-finger pinch/pan/rotate snapshot
let camZoom = 1, camPan = { x: 0, z: 0 }, camYaw = 0;
let keys = {};
let save = loadSave();
let lastFrame = performance.now();

const GLOW_TEX = tx.glowTexture();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05010f);
  camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 1, 2500);

  addBackdrop();
  buildShip();
  buildPredict();

  window.addEventListener('resize', onResize);
  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  // keep the browser's own pinch/double-tap zoom out of the game — it scales
  // the page mid-gesture and makes the grid render doubled/smeared
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, e => e.preventDefault());
  }
  el.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  el.addEventListener('dblclick', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => { keys[e.code] = false; updateThrustSound(); });

  document.getElementById('btn-retry').addEventListener('click', () => { sfx.clickSound(); if (state !== 'menu') resetLevel(); });
  document.getElementById('btn-mute').addEventListener('click', toggleMute);
  document.getElementById('level-label').addEventListener('click', () => {
    sfx.clickSound();
    setLevelPanel(!levelPanelOpen());
  });
  const expBtn = document.getElementById('btn-exp');
  expBtn.classList.toggle('on', !!save.experimental);
  expBtn.addEventListener('click', () => {
    sfx.clickSound();
    save.experimental = !save.experimental;
    storeSave();
    expBtn.classList.toggle('on', !!save.experimental);
    buildLevelBar();
    toast(save.experimental
      ? '🧪 Experimental mode ON — every level is open to explore!'
      : '🧪 Experimental mode off — back to normal progression.');
  });

  loadLevel(Math.min(save.unlocked - 1, LEVELS.length - 1));
  showMenu();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Save data
// ---------------------------------------------------------------------------
function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && s.unlocked) return s;
  } catch { /* fresh save */ }
  return { unlocked: 1, stars: {} };
}
function storeSave() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* private mode */ } }

// ---------------------------------------------------------------------------
// Backdrop: layered starfield, hero stars with diffraction spikes, nebulas
// ---------------------------------------------------------------------------
function addBackdrop() {
  const rng = tx.mulberry32(1337);
  for (const [count, size, bright] of [[1400, 1.4, 0.55], [220, 2.4, 0.95]]) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize()
        .multiplyScalar(650 + rng() * 250);
      v.y = Math.abs(v.y) * (rng() < 0.25 ? -0.3 : 1);
      pos.set([v.x, v.y, v.z], i * 3);
      c.setHSL(rng() < 0.12 ? 0.05 + rng() * 0.05 : 0.52 + rng() * 0.2, 0.55, bright * (0.5 + rng() * 0.5));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false,
    })));
  }
  // hero stars with spikes
  const flare = tx.flareTexture();
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flare, color: [0xbfe3ff, 0xffe9c9, 0xd9c9ff][i % 3],
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const v = new THREE.Vector3(rng() * 2 - 1, 0.15 + rng() * 0.8, rng() * 2 - 1).normalize().multiplyScalar(750);
    sp.position.copy(v);
    sp.scale.setScalar(26 + rng() * 30);
    scene.add(sp);
  }
  // nebulas
  for (let i = 0; i < 3; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tx.nebulaTexture(900 + i * 77), transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const ang = (i / 3) * Math.PI * 2 + rng();
    sp.position.set(Math.cos(ang) * 620, 120 + rng() * 260, Math.sin(ang) * 620 - 150);
    sp.scale.setScalar(520 + rng() * 320);
    sp.material.rotation = rng() * 6.28;
    scene.add(sp);
  }
}

function makeGlow(color, scale, opacity = 0.85) {
  const m = new THREE.SpriteMaterial({
    map: GLOW_TEX, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sp = new THREE.Sprite(m);
  sp.scale.setScalar(scale);
  return sp;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
function buildTerrain() {
  if (terrain) { scene.remove(terrain.lines); terrain.lines.geometry.dispose(); }
  const N = GRID_N, E = level.extent, span = 2 * E;
  const gridX = new Float32Array(N * N), gridZ = new Float32Array(N * N);
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      gridX[idx] = -E + (span * i) / (N - 1);
      gridZ[idx] = -E + (span * j) / (N - 1);
      pos[idx * 3] = gridX[idx];
      pos[idx * 3 + 2] = gridZ[idx];
    }
  }
  const index = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N - 1; i++) index.push(j * N + i, j * N + i + 1);
  for (let i = 0; i < N; i++) for (let j = 0; j < N - 1; j++) index.push(j * N + i, (j + 1) * N + i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  scene.add(lines);
  terrain = { lines, gridX, gridZ, posAttr: geo.getAttribute('position'), colAttr: geo.getAttribute('color') };
  updateTerrain(bodiesAt(level, simTime), true);
}

const _c = new THREE.Color();
function heightColor(y, out, o, fade) {
  if (y > 0.4) {
    // antimatter hills glow violet
    const t = Math.min(y / 12, 1);
    _c.setRGB(0.2 + 0.58 * t, 0.2 + 0.28 * t, 0.42 + 0.56 * t);
  } else {
    const d = -y;
    if (d < 7) {
      const t = d / 7;
      _c.setRGB(0.14 + 0.02 * t, 0.19 + 0.55 * t, 0.42 + 0.5 * t);
    } else if (d < 16) {
      const t = (d - 7) / 9;
      _c.setRGB(0.16 + 0.4 * t, 0.74 - 0.5 * t, 0.92 + 0.03 * t);
    } else {
      const t = Math.min((d - 16) / 10, 1);
      _c.setRGB(0.56 + 0.44 * t, 0.24 - 0.06 * t, 0.95 - 0.37 * t);
    }
  }
  const f = fade == null ? 1 : fade;
  out[o] = _c.r * f; out[o + 1] = _c.g * f; out[o + 2] = _c.b * f;
}

// Every level moves now, so the whole grid can't be re-deformed every frame at
// full density. It doesn't need to be: redraw only once the bodies have
// actually shifted by a fraction of a grid cell, which for the slow early sets
// is a few times a second and for fast alien systems is every frame.
let deformAt = null;
function terrainNeedsUpdate(positions) {
  if (!deformAt || deformAt.length !== positions.length * 2) return true;
  for (let i = 0; i < positions.length; i++) {
    if (Math.abs(positions[i].x - deformAt[i * 2]) +
        Math.abs(positions[i].z - deformAt[i * 2 + 1]) > DEFORM_EPS) return true;
  }
  return false;
}

// Recompute the height field the terrain is heading toward. The expensive
// part (a potential sum per vertex) happens here; `easeTerrain` then walks
// the drawn vertices toward it every frame so motion stays smooth even
// though the field is only re-solved when bodies have actually moved.
// How much to dim the grid at a point, so the mesh does not weave in front of
// the world sitting in the well. Additive blending means dimming to zero makes
// the lines vanish, leaving the planet against clean space.
function gridFade(x, z, positions) {
  const mode = window.WELLVIS || 'fade';
  if (mode === 'off') return 1;
  let f = 1;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i];
    const inner = b.radius * (b.type === 'sun' ? 1.5 : 1.9);
    const outer = b.radius * (b.type === 'sun' ? 2.6 : 3.4);
    const d = Math.hypot(positions[i].x - x, positions[i].z - z);
    if (d >= outer) continue;
    if (mode === 'aperture') { if (d < outer * 0.72) return 0; continue; }
    const t = Math.min(Math.max((d - inner) / (outer - inner), 0), 1);
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  return f;
}

function updateTerrain(positions, snap) {
  const { gridX, gridZ, posAttr, colAttr } = terrain;
  const pos = posAttr.array, col = colAttr.array;
  deformAt = new Float64Array(positions.length * 2);
  for (let i = 0; i < positions.length; i++) {
    deformAt[i * 2] = positions[i].x;
    deformAt[i * 2 + 1] = positions[i].z;
  }
  if (!terrain.targetY || terrain.targetY.length !== gridX.length) {
    terrain.targetY = new Float32Array(gridX.length);
    snap = true;
  }
  if (!terrain.fade || terrain.fade.length !== gridX.length) terrain.fade = new Float32Array(gridX.length);
  for (let idx = 0; idx < gridX.length; idx++) {
    const y = surfaceY(gridX[idx], gridZ[idx], positions);
    terrain.targetY[idx] = y;
    terrain.fade[idx] = gridFade(gridX[idx], gridZ[idx], positions);
    if (snap) {
      pos[idx * 3 + 1] = y;
      heightColor(y, col, idx * 3, terrain.fade[idx]);
    }
  }
  if (!snap) {
    for (let idx = 0; idx < gridX.length; idx++) heightColor(pos[idx * 3 + 1], col, idx * 3, terrain.fade[idx]);
    colAttr.needsUpdate = true;
  }
  if (snap) {
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}

// Glide the drawn surface toward the target field. Cheap: no potential sums,
// just a lerp per vertex, so it can run every frame at full grid density.
function easeTerrain(dt) {
  if (!terrain || !terrain.targetY) return;
  const { targetY, posAttr, colAttr } = terrain;
  const pos = posAttr.array, col = colAttr.array;
  const k = Math.min(dt * 9, 1);
  let moved = false, recoloured = false;
  for (let idx = 0; idx < targetY.length; idx++) {
    const cur = pos[idx * 3 + 1], want = targetY[idx];
    const d = want - cur;
    if (d > 0.002 || d < -0.002) {
      const y = cur + d * k;
      pos[idx * 3 + 1] = y;
      moved = true;
      // depth colour is a slow gradient — only worth redoing on a visible
      // change, which keeps the per-frame ease cheap at full grid density
      if (d > 0.05 || d < -0.05) { heightColor(y, col, idx * 3, terrain.fade ? terrain.fade[idx] : 1); recoloured = true; }
    }
  }
  if (moved) posAttr.needsUpdate = true;
  if (recoloured) colAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Bodies (planets, suns, black holes, repulsors)
// ---------------------------------------------------------------------------
function isSun(body) { return body.type === 'sun' || (body.mass >= 2500 && !body.type); }

// small arrow showing a mover's current direction of travel
function makeMotionArrow(color) {
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 6, color, 2, 1.3);
  arrow.line.material.transparent = true;
  arrow.line.material.opacity = 0.75;
  arrow.cone.material.transparent = true;
  arrow.cone.material.opacity = 0.75;
  scene.add(arrow);
  return arrow;
}

const _mdir = new THREE.Vector3();
function updateMotionArrow(arrow, posFn, i, baseY) {
  const a = posFn(level, simTime), b = posFn(level, simTime + 0.05);
  const vx = (b[i].x - a[i].x) / 0.05, vz = (b[i].z - a[i].z) / 0.05;
  const speed = Math.hypot(vx, vz);
  if (speed < 0.5) { arrow.visible = false; return; }
  _mdir.set(vx / speed, 0, vz / speed);
  arrow.position.set(a[i].x, baseY, a[i].z);
  arrow.setDirection(_mdir);
  arrow.setLength(Math.min(4 + speed * 0.35, 9), 2, 1.3);
  arrow.visible = true;
}

function buildBodies() {
  for (const bv of bodyVisuals) { scene.remove(bv.group); if (bv.arrow) scene.remove(bv.arrow); }
  bodyVisuals = [];
  for (const body of level.bodies) {
    const group = new THREE.Group();
    const seed = tx.hashStr(body.name || 'body');
    let spin = 0.25, discGroup = null;
    if (body.type === 'blackhole') {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0x000000 }),
      );
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(body.horizon, 0.3, 10, 48),
        new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.name = 'pulse';
      discGroup = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.RingGeometry(body.radius * 1.15, body.horizon * 2.4, 64),
        new THREE.MeshBasicMaterial({ map: tx.accretionTexture(seed), transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      discGroup.rotation.x = -Math.PI / 2 + 0.18;
      discGroup.add(disc);
      group.add(core, ring, discGroup, makeGlow(0xff3355, body.horizon * 4));
      spin = 0.6;
    } else if (body.mass < 0) {
      // antimatter star: burns violet-white and pushes everything away
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 24, 18),
        new THREE.MeshBasicMaterial({ map: tx.sunTexture(0xb47aff, seed) }),
      );
      const corona = makeGlow(0xc77dff, body.radius * 4.5, 0.85);
      corona.name = 'corona';
      group.add(sphere, corona, makeGlow(0xffffff, body.radius * 2.4, 0.5));
      spin = 0.15;
    } else if (isSun(body)) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 28, 20),
        new THREE.MeshBasicMaterial({ map: tx.sunTexture(body.color, seed) }),
      );
      const corona = makeGlow(body.color, body.radius * 5.2, 0.9);
      corona.name = 'corona';
      group.add(sphere, corona, makeGlow(0xfff3d0, body.radius * 3, 0.75));
      spin = 0.12;
    } else {
      const style = body.radius >= 4.4 && (seed & 1) === 0 ? 'banded' : body.radius >= 4.6 ? 'banded' : 'rocky';
      // real solar-system worlds get their own look; alien ones stay procedural
      const named = tx.namedPlanetTexture(body.name, seed);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 24, 18),
        new THREE.MeshBasicMaterial({ map: named || tx.planetTexture(body.color, seed, style) }),
      );
      sphere.rotation.z = 0.2 - (seed % 100) / 250;
      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 1.12, 20, 14),
        new THREE.MeshBasicMaterial({ color: body.color, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      group.add(sphere, atmo, makeGlow(body.color, body.radius * 3.6, 0.55));
      const namedRings = /^saturn$/i.test(body.name || '');
      if (namedRings || (!named && style === 'banded' && seed % 3 === 0)) {
        const rings = new THREE.Mesh(
          new THREE.RingGeometry(body.radius * 1.45, body.radius * 2.3, 48),
          new THREE.MeshBasicMaterial({ map: tx.ringSystemTexture(body.color, seed), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
        );
        rings.rotation.x = -Math.PI / 2 + 0.35;
        rings.rotation.y = (seed % 60) / 60;
        group.add(rings);
      }
      spin = 0.22;
    }
    scene.add(group);
    // no motion arrow: the dotted orbit path already shows where a world is
    // going, and the two together just crowd the map. Hazards keep theirs —
    // no path is drawn for patrols, comets or derelicts.
    bodyVisuals.push({ group, body, spin, discGroup, arrow: null });
  }
  buildOrbitPaths();
}

// ---------------------------------------------------------------------------
// Orbit paths — dotted rings draped over the terrain, so an orbit visibly
// dips through the wells it crosses.
// ---------------------------------------------------------------------------
const ORBIT_SEGS = 132;
function buildOrbitPaths() {
  for (const ov of orbitVisuals) scene.remove(ov.line);
  orbitVisuals = [];
  for (let i = 0; i < level.bodies.length; i++) {
    const o = level.bodies[i].orbit;
    if (!o) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SEGS + 1) * 3), 3));
    // fixed-size beads: legible at every zoom, unlike world-scaled dashes
    const line = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffd9a0, size: 2.6, sizeAttenuation: false,
      transparent: true, opacity: 0.85, depthWrite: false,
    }));
    line.frustumCulled = false;
    scene.add(line);
    orbitVisuals.push({ line, o });
  }
}
function updateOrbitPaths(positions) {
  for (const ov of orbitVisuals) {
    const o = ov.o;
    const c = o.parent != null ? positions[o.parent] : { x: o.cx || 0, z: o.cz || 0 };
    const attr = ov.line.geometry.getAttribute('position');
    const arr = attr.array;
    for (let j = 0; j <= ORBIT_SEGS; j++) {
      const a = (j / ORBIT_SEGS) * Math.PI * 2;
      const x = c.x + Math.cos(a) * o.radius, z = c.z + Math.sin(a) * o.radius;
      arr[j * 3] = x;
      arr[j * 3 + 1] = surfaceY(x, z, positions) + 0.35;
      arr[j * 3 + 2] = z;
    }
    attr.needsUpdate = true;
    ov.line.geometry.computeBoundingSphere();
  }
}

// ---------------------------------------------------------------------------
// Hazard ships, fuel pickups, waypoints
// ---------------------------------------------------------------------------
function buildHazards() {
  for (const hv of hazardVisuals) { scene.remove(hv.group); if (hv.arrow) scene.remove(hv.arrow); }
  hazardVisuals = [];
  for (const hazard of (level.hazards || [])) {
    const group = new THREE.Group();
    const moving = !!(hazard.orbit || hazard.patrol || hazard.comet);
    if (hazard.comet) {
      const ice = new THREE.Mesh(
        new THREE.IcosahedronGeometry(hazard.radius, 1),
        new THREE.MeshBasicMaterial({ color: 0xdfefff }),
      );
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(hazard.radius * 0.9, hazard.radius * 7, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x9fd9ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      tail.rotation.x = Math.PI / 2;                 // point along local -z
      tail.position.z = hazard.radius * 3.8;
      tail.name = 'tail';
      group.add(ice, tail, makeGlow(0xbfe8ff, hazard.radius * 5, 0.7));
    } else if (hazard.kind === 'asteroid') {
      // a grainy dust cloud, not a modelled rock: at belt scale these are
      // specks, and drawing each as an object made them read like moons
      const grains = 22;
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(grains * 3);
      const rng = tx.mulberry32(tx.hashStr(`ast${hazard.x},${hazard.z}`));
      for (let i = 0; i < grains; i++) {
        const a = rng() * 6.283, u = rng() + rng();
        const rr = (u > 1 ? 2 - u : u) * hazard.radius * 2.2;
        pos[i * 3] = Math.cos(a) * rr;
        pos[i * 3 + 1] = (rng() - 0.5) * hazard.radius * 1.2;
        pos[i * 3 + 2] = Math.sin(a) * rr;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const dust = new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xc9b79c, size: 2, sizeAttenuation: false,
        transparent: true, opacity: 0.85, depthWrite: false,
      }));
      group.add(dust, makeGlow(0xd0a070, hazard.radius * 5, 0.22));
    } else {
      const hull = new THREE.Mesh(
        new THREE.ConeGeometry(hazard.radius * 0.55, hazard.radius * 1.9, 8),
        new THREE.MeshBasicMaterial({ color: moving ? 0xd0d6e8 : 0x8a92a8 }),
      );
      hull.rotation.x = Math.PI / 2;
      const wing = new THREE.Mesh(
        new THREE.BoxGeometry(hazard.radius * 1.9, 0.25, hazard.radius * 0.6),
        new THREE.MeshBasicMaterial({ color: moving ? 0x9aa8c8 : 0x6a7288 }),
      );
      group.add(hull, wing, makeGlow(0xff5d5d, hazard.radius * 4, 0.6));
    }
    scene.add(group);
    const arrow = moving ? makeMotionArrow(0xff5d5d) : null;
    hazardVisuals.push({ group, hazard, prev: null, arrow });
  }
}

function buildPickups() {
  for (const pv of pickupVisuals) scene.remove(pv.group);
  pickupVisuals = [];
  (level.pickups || []).forEach((pickup, index) => {
    const group = new THREE.Group();
    const can = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 2, 10),
      new THREE.MeshBasicMaterial({ color: 0xff9f43 }),
    );
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 0.95, 0.5, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe4b3 }),
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(PICKUP_R * 0.75, 0.12, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(can, band, ring, makeGlow(0xff9f43, 7, 0.7));
    scene.add(group);
    pickupVisuals.push({ group, pickup, index });
  });
}

const WP_COLORS = { station: 0x35e0ff, cargo: 0xffb703, dropoff: 0x64dfdf };
function buildWaypoints() {
  for (const wv of waypointVisuals) scene.remove(wv.group);
  waypointVisuals = [];
  (level.waypoints || []).forEach((wp, index) => {
    const color = WP_COLORS[wp.type] || 0x35e0ff;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(wp.r, Math.min(0.35, wp.r * 0.12), 10, 44),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.name = 'ring';
    let core;
    if (wp.type === 'cargo') {
      core = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    } else if (wp.type === 'dropoff') {
      core = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.4, 0.7, 8), new THREE.MeshBasicMaterial({ color: 0x64dfdf }));
    } else {
      core = new THREE.Group();
      const hub = new THREE.Mesh(new THREE.OctahedronGeometry(1.5), new THREE.MeshBasicMaterial({ color: 0xd7ecff }));
      const panelMat = new THREE.MeshBasicMaterial({ color: 0x3a7bd5, side: THREE.DoubleSide });
      for (const s of [-1, 1]) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.1), panelMat);
        panel.position.x = s * 2.4;
        core.add(panel);
      }
      core.add(hub);
    }
    core.scale.setScalar(stationScale(wp.r) * (wp.type === 'station' ? 1 : 1.6));
    core.position.y = 0.8;
    core.name = 'core';
    const glow = makeGlow(color, wp.r * 3.2, 0.6);
    group.add(ring, core, glow);
    scene.add(group);
    waypointVisuals.push({ group, wp, index, ringMat: ring.material, glow });
  });
  refreshWaypointStates();
}

function refreshWaypointStates() {
  for (const wv of waypointVisuals) {
    const done = wv.index < stage;
    const active = wv.index === stage;
    const color = done ? 0x7cff6b : WP_COLORS[wv.wp.type] || 0x35e0ff;
    wv.ringMat.color.setHex(color);
    wv.ringMat.opacity = done ? 0.4 : active ? 0.95 : 0.35;
    wv.glow.material.color.setHex(color);
    wv.glow.material.opacity = active ? 0.65 : 0.25;
  }
  setGoalActive(stage >= (level.waypoints || []).length);
  updateStopsHud();
}

// ---------------------------------------------------------------------------
// Goal, pad, ship
// ---------------------------------------------------------------------------
let goalRingMat, goalBeacon, goalGlow;
// Station models are authored ~8.8 units across; scale them to span a little
// under their docking ring so the structure always reads as smaller than any
// world nearby.
function stationScale(r) {
  return Math.max(r, 0.8) * 0.2;
}

function buildGoal() {
  if (goalGroup) scene.remove(goalGroup);
  goalGroup = new THREE.Group();
  // the target is always a space station: hub + solar panels inside a gold
  // docking ring
  // The win test is "centre distance < goal.r", so the ring's centreline IS
  // the boundary. A fat tube puts half the drawn ring outside the scoring
  // radius, which reads as flying through the target without docking — keep
  // it thin relative to r now that targets are small.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(level.goal.r, Math.min(0.4, level.goal.r * 0.12), 10, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.name = 'pulse';
  goalRingMat = ring.material;
  const station = new THREE.Group();
  station.name = 'station';
  const hub = new THREE.Mesh(new THREE.OctahedronGeometry(1.7), new THREE.MeshBasicMaterial({ color: 0xffe9b8 }));
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6.4, 8), new THREE.MeshBasicMaterial({ color: 0xd8c48a }));
  spine.rotation.z = Math.PI / 2;
  const panelMat = new THREE.MeshBasicMaterial({ color: 0x3a7bd5, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.3), panelMat);
    panel.position.x = s * 3;
    station.add(panel);
  }
  station.add(hub, spine);
  // a station is a structure, not a world: scale it to sit inside its own
  // docking ring rather than dwarfing the moon it orbits
  station.scale.setScalar(stationScale(level.goal.r));
  station.position.y = 0.9;
  if (goalBeacon) scene.remove(goalBeacon);
  goalBeacon = new THREE.Mesh(
    new THREE.CylinderGeometry(level.goal.r * 0.45, level.goal.r * 0.7, 46, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.07, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  goalBeacon.position.y = 23;
  scene.add(goalBeacon);   // scene-level: the beacon marks the ACTIVE target
  goalGlow = makeGlow(0xffd166, level.goal.r * 4);
  goalGroup.add(ring, station, goalGlow);
  scene.add(goalGroup);
}

// The light column always stands on whatever you must reach NEXT — a cargo
// stop, a station, or the final goal.
function updateBeacon(positions) {
  if (!goalBeacon || !level) return;
  const tgt = activeTarget(level, stage, positions);
  goalBeacon.position.set(tgt.x, 23, tgt.z);
  const s = Math.max(tgt.r, 1.8) / Math.max(level.goal.r, 0.001);
  goalBeacon.scale.set(s, 1, s);
  goalBeacon.material.color.setHex(tgt.kind === 'goal' ? 0xffd166 : 0x66e0ff);
}

function setGoalActive(active) {
  if (!goalRingMat) return;
  goalRingMat.opacity = active ? 0.95 : 0.25;
  goalGlow.material.opacity = active ? 0.85 : 0.2;
}

function buildPad() {
  if (padGroup) scene.remove(padGroup);
  padGroup = new THREE.Group();
  // the pad is a launch platform, not a landmark — keep it near the goal ring
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.16, 8, 36),
    new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  padGroup.add(ring);
  scene.add(padGroup);
}

function buildShip() {
  shipGroup = new THREE.Group();
  shipGroup.scale.setScalar(0.45);   // planets should dwarf the ship
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 3.4, 12),
    new THREE.MeshBasicMaterial({ color: 0xf5fbff }),
  );
  cone.rotation.x = Math.PI / 2;
  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x35e0ff }),
  );
  cockpit.position.set(0, 0.4, 0.4);
  cargoBox = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 1.1, 1.1),
    new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  );
  cargoBox.position.set(0, 0, -2.6);
  cargoBox.visible = false;
  engineSprite = makeGlow(0x66d9ff, 4);
  engineSprite.position.z = -2.2;
  shipGroup.add(cone, cockpit, cargoBox, engineSprite, makeGlow(0xbfeaff, 6));
  scene.add(shipGroup);

  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  trailLine = new THREE.Line(tg, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  trailLine.frustumCulled = false;
  scene.add(trailLine);
}

function buildPredict() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREDICT_MAX * 3), 3));
  predictLine = new THREE.Line(g, new THREE.LineBasicMaterial({
    color: 0x9bd5ff, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  predictLine.material.opacity = 0.45;
  predictLine.frustumCulled = false;
  predictLine.visible = false;
  // draw over everything: a shot that dives toward a planet would otherwise
  // vanish inside that planet's glow sprite and the wall of its own well
  predictLine.material.depthTest = false;
  predictLine.renderOrder = 20;
  scene.add(predictLine);
  // chunky dots along the same geometry: the trajectory reads clearly even
  // on bright terrain and small phone screens
  // Dots get their own geometry sampled by DISTANCE, not by time: sharing the
  // line's time-sampled points piles them into an unreadable blob wherever the
  // ship is moving slowly — exactly where a shot starts, and worst of all next
  // to a planet where a stubby trail needs to read clearly.
  const gd = new THREE.BufferGeometry();
  gd.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREDICT_MAX * 3), 3));
  predictDots = new THREE.Points(gd, new THREE.PointsMaterial({
    color: 0xffffff, size: 6, sizeAttenuation: false, transparent: true,
    opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  predictDots.frustumCulled = false;
  predictDots.visible = false;
  predictDots.material.depthTest = false;
  predictDots.renderOrder = 21;
  scene.add(predictDots);
  predictMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
  );
  predictMarker.visible = false;
  scene.add(predictMarker);
  aimArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 6, 0x7cff6b, 2.4, 1.6);
  aimArrow.visible = false;
  scene.add(aimArrow);
  aimDial = buildAimDial();

  // slingshot touch indicators: ring where the drag started, a handle dot
  // under the finger, and a dashed rubber band between them
  aimAnchor = new THREE.Mesh(
    new THREE.TorusGeometry(1.7, 0.2, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0x9bd5ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  aimAnchor.rotation.x = Math.PI / 2;
  aimAnchor.visible = false;
  scene.add(aimAnchor);

  aimHandle = new THREE.Group();
  const handleRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.22, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  handleRing.rotation.x = Math.PI / 2;
  handleRing.name = 'hring';
  const handleDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
  );
  handleDot.name = 'hdot';
  aimHandle.add(handleRing, handleDot);
  aimHandle.visible = false;
  scene.add(aimHandle);

  const bandGeo = new THREE.BufferGeometry();
  bandGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  aimBand = new THREE.Line(bandGeo, new THREE.LineDashedMaterial({
    color: 0x9bd5ff, dashSize: 1.4, gapSize: 0.9, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  aimBand.frustumCulled = false;
  aimBand.visible = false;
  scene.add(aimBand);
}

function hideAimUI() {
  predictLine.visible = false;
  predictDots.visible = false;
  predictMarker.visible = false;
  aimArrow.visible = false;
  aimAnchor.visible = false;
  aimHandle.visible = false;
  aimBand.visible = false;
  if (aimDial) aimDial.visible = false;
  hideLeadVis();
  document.getElementById('fine-chip').hidden = true;
  document.getElementById('aim-readout').hidden = true;
}

// ---------------------------------------------------------------------------
// Level flow
// ---------------------------------------------------------------------------
function loadLevel(i) {
  levelIndex = i;
  level = LEVELS[i];
  displaySet = Math.floor(i / 10);
  simTime = 0;
  attempts = 0;
  stage = 0;
  pickupsDone = new Set();
  legStartFuel = level.fuel;
  buildTerrain();
  buildBodies();
  buildHazards();
  buildPickups();
  buildGoal();
  buildWaypoints();
  buildPad();
  resetLeg();
  setLevelPanel(false);
  document.getElementById('level-label').textContent = `${i + 1} · ${level.name}`;
  document.getElementById('engine').textContent = `⚙ ${level.maxLaunch}`;
  const d = level.difficulty || 1;
  document.getElementById('difficulty').textContent = '★'.repeat(d) + '☆'.repeat(5 - d);
  document.getElementById('difficulty').title = `${SETS[displaySet].name} — difficulty ${d}/5`;
  setHint(level.hint);
  buildLevelBar();
}

function derivedCarrying() {
  const wps = level.waypoints || [];
  let c = false;
  for (let i = 0; i < stage && i < wps.length; i++) {
    if (wps[i].type === 'cargo') c = true;
    else if (wps[i].type === 'dropoff') c = false;
  }
  return c;
}

function resetLeg() {
  state = 'ready';
  const start = legStart(level, stage, bodiesAt(level, simTime));
  ship = { x: start.x, z: start.z, vx: 0, vz: 0 };
  resetCamera();
  updateBeacon();
  fuel = legStartFuel;   // stops never refuel — you fly the leg with what you docked with
  carrying = derivedCarrying();
  cargoBox.visible = carrying;
  pickupsTemp = new Set();
  trailPts = [];
  trailLine.geometry.setDrawRange(0, 0);
  hideAimUI();
  aim = null;
  dockAnim = null;
  shipGroup.visible = true;
  sfx.stopThrust();
  refreshWaypointStates();
  updateFuelBar();
  updateAttempts();
  updateCargoHud();
  hidePower();
}

function resetLevel() {
  if (state === 'menu') return;
  stage = 0;
  pickupsDone = new Set();
  legStartFuel = level.fuel;
  resetLeg();
}

function launch(vx, vz) {
  const speed = Math.hypot(vx, vz);
  fuel = Math.max(fuel - launchFuelCost(speed, level.maxLaunch), 0);
  ship.vx = vx; ship.vz = vz;
  state = 'flying';
  attempts++;
  updateAttempts();
  updateFuelBar();
  physAcc = 0;
  sfx.launchSound(speed / level.maxLaunch);
  hideAimUI();
  hidePower();
}

function onWin() {
  state = 'won';
  sfx.stopThrust();
  sfx.winSound();
  burst(level.goal.x, goalY() + 2, level.goal.z, 0xffd166, 90);
  const legs = legCount(level);
  const earned = attempts <= legs ? 3 : attempts <= legs + 2 ? 2 : 1;
  save.stars[levelIndex] = Math.max(save.stars[levelIndex] || 0, earned);
  // experimental-mode wins on levels beyond the frontier don't skip progression
  if (levelIndex < save.unlocked) {
    save.unlocked = Math.max(save.unlocked, Math.min(levelIndex + 2, LEVELS.length));
  }
  storeSave();
  buildLevelBar();
  setTimeout(() => showWin(earned), 900);
}

function beginDock(index) {
  const wp = (level.waypoints || [])[index];
  state = 'docked';
  sfx.stopThrust();
  sfx.dockSound();
  dockAnim = { fromX: ship.x, fromZ: ship.z, toX: wp.x, toZ: wp.z, t: 0, index };
}

function finishDock() {
  const wp = (level.waypoints || [])[dockAnim.index];
  stage = dockAnim.index + 1;
  for (const p of pickupsTemp) pickupsDone.add(p);
  dockAnim = null;
  legStartFuel = fuel;   // no refueling at stops — what you have is what you fly with
  const lowFuel = level.legMinCosts && fuel + 0.01 < level.legMinCosts[stage];
  if (lowFuel) toast('⚠️ Not enough fuel for the next launch — press R and grab the fuel cells!');
  else if (wp.type === 'cargo') toast('📦 Cargo secured! It\'s heavy — thrusters at half power.');
  else if (wp.type === 'dropoff') toast('📦 Cargo delivered!');
  else toast('🛰 Docked!');
  resetLeg();
}

function onCrash(reason) {
  state = 'crashed';
  sfx.stopThrust();
  sfx.crashSound();
  const y = surfaceY(ship.x, ship.z, bodiesAt(level, simTime)) + 1.6;
  burst(ship.x, y, ship.z, 0xff7b54, 80);
  shipGroup.visible = false;
  toast(reason);
  setTimeout(() => { if (state === 'crashed') resetLeg(); }, 1400);
}

function failOOB() {
  state = 'crashed';
  sfx.stopThrust();
  toast('🌌 Lost in deep space…');
  setTimeout(() => { if (state === 'crashed') resetLeg(); }, 1100);
}

function crashMessage(st) {
  if (st.type === 'hazard') {
    const h = level.hazards[st.hazard];
    if (h.comet) return '☄️ Struck by a comet!';
    if (h.kind === 'asteroid') return '💥 Smashed into an asteroid!';
    const moving = !!(h.orbit || h.patrol);
    return moving ? '💥 Collided with a patrol ship!' : '💥 Collided with a derelict ship!';
  }
  const b = level.bodies[st.body];
  if (b.type === 'blackhole') return `🕳️ Swallowed by ${b.name}! Nothing escapes the red ring.`;
  if (b.mass < 0) return `💥 Annihilated by the antimatter star ${b.name}!`;
  return `💥 Crashed into ${b.name}!`;
}

// ---------------------------------------------------------------------------
// Input & aiming
// ---------------------------------------------------------------------------
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
function screenToWorld(clientX, clientY, planeY) {
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((clientX - r.left) / r.width) * 2 - 1;
  const ny = -((clientY - r.top) / r.height) * 2 + 1;
  _ray.setFromCamera({ x: nx, y: ny }, camera);
  _plane.constant = -planeY;
  return _ray.ray.intersectPlane(_plane, _hit) ? { x: _hit.x, z: _hit.z } : null;
}
function pointerToWorld(e) {
  return screenToWorld(e.clientX, e.clientY, shipY());
}

// ------------------------------------- pinch zoom / pan / rotate camera
function gestureShape() {
  const [p1, p2] = [...pointers.values()];
  return {
    d: Math.max(Math.hypot(p1.x - p2.x, p1.y - p2.y), 1),
    a: Math.atan2(p2.y - p1.y, p2.x - p1.x),
    mx: (p1.x + p2.x) / 2,
    my: (p1.y + p2.y) / 2,
  };
}
function clampPan() {
  const lim = level.extent * 0.9;
  camPan.x = Math.min(Math.max(camPan.x, -lim), lim);
  camPan.z = Math.min(Math.max(camPan.z, -lim), lim);
}
// Frame each leg's start: view centered over the ship, rotated so the active
// target sits up-screen, zoomed in as far as the pair allows.
const _fitCam = new THREE.PerspectiveCamera();
const _fitV = new THREE.Vector3();
// Smallest camZoom (= closest camera) that keeps the whole target ring and
// the ship inside the frame, each with its own edge margin (fraction of the
// screen). Mirrors updateCamera's settled 'ready'-state transform.
function fitZoom(tgt, marginTgt, marginShip, flying) {
  const E = level.extent;
  _fitCam.fov = camera.fov;
  _fitCam.aspect = window.innerWidth / window.innerHeight;
  _fitCam.near = camera.near;
  _fitCam.far = camera.far;
  // mirror updateCamera: in flight the view rides camPan with no follow bias
  const followX = flying ? 0 : ship.x * 0.3, followZ = flying ? 0 : ship.z * 0.18;
  const cos = Math.cos(camYaw), sin = Math.sin(camYaw);
  const inside = (x, y, z, m) => {
    _fitV.set(x, y, z).project(_fitCam);
    return Math.abs(_fitV.x) <= 1 - m * 2 && Math.abs(_fitV.y) <= 1 - m * 2;
  };
  const test = z => {
    const tx = followX * 0.4 + camPan.x, tz = followZ * 0.4 + camPan.z;
    const ox = followX * 0.6, oz = E * 1.52 * z + followZ * 0.6;
    _fitCam.position.set(tx + ox * cos + oz * sin, E * 1.02 * z, tz + (-ox * sin + oz * cos));
    _fitCam.lookAt(tx, -4, tz);
    _fitCam.updateProjectionMatrix();
    _fitCam.updateMatrixWorld();
    const r = Math.max(tgt.r, 1.5);
    return inside(tgt.x - r, 0, tgt.z, marginTgt) && inside(tgt.x + r, 0, tgt.z, marginTgt)
      && inside(tgt.x, 0, tgt.z - r, marginTgt) && inside(tgt.x, 0, tgt.z + r, marginTgt)
      && inside(ship.x, shipY(), ship.z, marginShip);
  };
  let lo = 0.05, hi = 1;
  if (test(lo)) return lo;
  if (!test(hi)) return hi;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid)) hi = mid; else lo = mid;
  }
  return hi;
}
function resetCamera() {
  camZoom = 1;
  camYaw = 0;
  camPan = { x: 0, z: 0 };
  if (!level) return;
  const tgt = activeTarget(level, stage, bodiesAt(level, simTime));
  const dx = tgt.x - ship.x, dz = tgt.z - ship.z;
  const D = Math.hypot(dx, dz);
  if (D > 1) camYaw = Math.atan2(-dx, -dz);
  const midX = ship.x * 0.55 + tgt.x * 0.45, midZ = ship.z * 0.55 + tgt.z * 0.45;
  camPan = { x: midX - ship.x * 0.12, z: midZ - ship.z * 0.072 };
  clampPan();
  // zoom in on the ship as far as possible with the target still on screen:
  // target ring 3.5% inside the frame, ship 11% (user-picked "maximum zoom")
  camZoom = Math.min(Math.max(fitZoom(tgt, 0.035, 0.11), 9 / level.extent), 1);
}
function onWheel(e) {
  e.preventDefault();
  camZoom = Math.min(Math.max(camZoom * Math.exp(e.deltaY * 0.0012), 0.28), 1.8);
}

function levelPanelOpen() {
  return document.getElementById('levels-bar').classList.contains('open');
}
function setLevelPanel(open) {
  document.getElementById('levels-bar').classList.toggle('open', open);
}

function onPointerDown(e) {
  if (levelPanelOpen()) { setLevelPanel(false); return; }
  // taps in the HUD strip must never start a slingshot
  const hudB = document.getElementById('hud').getBoundingClientRect().bottom;
  const hintB = document.getElementById('hint').getBoundingClientRect().bottom;
  if (e.clientY <= Math.max(hudB, hintB) + 8) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // second finger: switch from aiming to camera gesture
    if (state === 'aiming') { aim = null; cancelAim(); }
    aimPointerId = null;
    const s = gestureShape();
    gesture = { d0: s.d, a0: s.a, mx0: s.mx, my0: s.my, zoom0: camZoom, yaw0: camYaw, pan0: { ...camPan } };
    return;
  }
  if (pointers.size > 2 || state !== 'ready') return;
  const p = pointerToWorld(e);
  if (!p) return;
  aim = { sx: p.x, sz: p.z };
  aimSmooth = null;
  aimFine = null;
  aimFinePrev = null;
  aimHist.length = 0;
  aimPointerId = e.pointerId;
  state = 'aiming';
  updateAim(e);
}

function onPointerMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture && pointers.size === 2) {
    const s = gestureShape();
    camZoom = Math.min(Math.max(gesture.zoom0 * (gesture.d0 / s.d), 0.28), 1.8);
    camYaw = gesture.yaw0 + (s.a - gesture.a0);
    // pan from absolute screen deltas since gesture start — never re-derived
    // through the (still-lerping) camera, so it cannot feed back and jump
    const rect = renderer.domElement.getBoundingClientRect();
    const dist = level.extent * 1.83 * camZoom;
    const wpp = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / rect.height;
    const wx = (s.mx - gesture.mx0) * wpp;
    const wz = (s.my - gesture.my0) * wpp * 1.35;
    const cos = Math.cos(camYaw), sin = Math.sin(camYaw);
    camPan.x = gesture.pan0.x - (wx * cos + wz * sin);
    camPan.z = gesture.pan0.z - (-wx * sin + wz * cos);
    clampPan();
    return;
  }
  if (state === 'aiming' && e.pointerId === aimPointerId) updateAim(e);
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (e.pointerId !== aimPointerId) return;
  aimPointerId = null;
  if (state !== 'aiming') return;
  updateAim(e);
  if (e.pointerType === 'touch' && aimHist.length) {
    // launch from the aim ~80ms BEFORE the finger lifted — lift-off jitter
    // is what yanks precise shots at the last instant
    const cutoff = performance.now() - 80;
    let h = aimHist[0];
    for (const entry of aimHist) { if (entry.t <= cutoff) h = entry; else break; }
    let vx = (aim.sx - h.x) * AIM_SCALE;
    let vz = (aim.sz - h.z) * AIM_SCALE;
    const cap = Math.min(level.maxLaunch, maxAffordableLaunch(fuel, level.maxLaunch));
    const sp = Math.hypot(vx, vz);
    if (sp > cap) { vx *= cap / sp; vz *= cap / sp; }
    launchVel = { x: vx, z: vz };
  }
  const v = Math.hypot(launchVel.x, launchVel.z);
  if (v >= MIN_LAUNCH) {
    launch(launchVel.x, launchVel.z);
  } else {
    cancelAim();
  }
  aim = null;
}

function cancelAim() {
  state = 'ready';
  hideAimUI();
  hidePower();
  updateFuelBar();
}

// Adaptive fine aim: the slower the pointer creeps, the finer its motion
// reaches the handle — ramping continuously from 1:1 at flick speed down to
// 1/FINE_MAX at a near-still crawl, so the last hundredths of a degree are
// dialable. Fast flicks pull the handle back onto the finger so slow-phase
// offset never piles up.
function fineAim(e, p) {
  const now = performance.now();
  if (!aimFinePrev) {
    aimFine = { x: p.x, z: p.z };
    aimFinePrev = { sx: e.clientX, sy: e.clientY, wx: p.x, wz: p.z, t: now, v: FINE_V_HI };
    fineActive = false;
    fineGain = 1;
    return aimFine;
  }
  const dt = Math.max(now - aimFinePrev.t, 1);
  const pxs = (Math.hypot(e.clientX - aimFinePrev.sx, e.clientY - aimFinePrev.sy) / dt) * 1000;
  const v = aimFinePrev.v + (pxs - aimFinePrev.v) * 0.35;
  const t = Math.min(v / FINE_V_HI, 1);
  const gain = Math.max(t ** 1.4, 1 / FINE_MAX);
  aimFine.x += (p.x - aimFinePrev.wx) * gain;
  aimFine.z += (p.z - aimFinePrev.wz) * gain;
  const k = t * t * 0.3;
  aimFine.x += (p.x - aimFine.x) * k;
  aimFine.z += (p.z - aimFine.z) * k;
  aimFinePrev = { sx: e.clientX, sy: e.clientY, wx: p.x, wz: p.z, t: now, v };
  fineActive = gain < 0.6;
  fineGain = gain;
  return aimFine;
}

function updateAim(e) {
  const raw = pointerToWorld(e);
  if (!raw) return;
  let p = raw;
  if (e.pointerType === 'touch') {
    // smooth touch input: fingers tremble, launches shouldn't
    aimSmooth = aimSmooth
      ? { x: aimSmooth.x + (raw.x - aimSmooth.x) * 0.3, z: aimSmooth.z + (raw.z - aimSmooth.z) * 0.3 }
      : { x: raw.x, z: raw.z };
    p = aimSmooth;
  }
  p = fineAim(e, p);
  if (e.pointerType === 'touch') {
    aimHist.push({ t: performance.now(), x: p.x, z: p.z });
    while (aimHist.length && aimHist[0].t < performance.now() - 300) aimHist.shift();
  }
  let vx = (aim.sx - p.x) * AIM_SCALE;
  let vz = (aim.sz - p.z) * AIM_SCALE;
  const cap = Math.min(level.maxLaunch, maxAffordableLaunch(fuel, level.maxLaunch));
  const sp = Math.hypot(vx, vz);
  if (sp > cap) {
    vx *= cap / sp;
    vz *= cap / sp;
  }
  launchVel = { x: vx, z: vz };
  const speed = Math.min(sp, cap);
  const power = speed / level.maxLaunch;
  showPower(power, launchFuelCost(speed, level.maxLaunch));
  updateAimArrow(power);
  updateAimTouchUI(p, power);
  updateFineChip(p);
  updatePrediction();
}

const _proj = new THREE.Vector3();
function updateFineChip(p) {
  const chip = document.getElementById('fine-chip');
  if (!fineActive) { chip.hidden = true; return; }
  chip.textContent = `FINE ×${Math.round(1 / fineGain)}`;
  _proj.set(p.x, shipY() + 0.5, p.z).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  chip.style.left = `${r.left + ((_proj.x + 1) / 2) * r.width}px`;
  chip.style.top = `${r.top + ((1 - _proj.y) / 2) * r.height}px`;
  chip.hidden = false;
}

function updateAimTouchUI(p, power) {
  const y = shipY() + 0.5;
  const col = power < 0.5 ? lerpColor(0x7cff6b, 0xffd166, power * 2) : lerpColor(0xffd166, 0xff5d5d, (power - 0.5) * 2);
  aimAnchor.position.set(aim.sx, y, aim.sz);
  aimAnchor.visible = true;
  aimHandle.position.set(p.x, y, p.z);
  aimHandle.getObjectByName('hring').material.color.setHex(col);
  aimHandle.visible = true;
  const attr = aimBand.geometry.getAttribute('position');
  attr.array.set([aim.sx, y, aim.sz, p.x, y, p.z]);
  attr.needsUpdate = true;
  aimBand.computeLineDistances();
  aimBand.material.color.setHex(col);
  aimBand.visible = true;
}

const _dir = new THREE.Vector3();
// Launch telemetry: with fine-aim damping the handle is no longer the launch
// vector, so show the vector itself — a full-power reference ring with
// heading ticks (the aim arrow is the needle, its tip touching the ring at
// 100%) plus an exact heading/power readout.
const AIM_RING_R = 7;
function buildAimDial() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(AIM_RING_R, 0.12, 6, 72),
    new THREE.MeshBasicMaterial({ color: 0x7f8cc0, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const pts = [];
  for (let d = 0; d < 360; d += 15) {
    const a = (d * Math.PI) / 180;
    const inner = d % 45 === 0 ? AIM_RING_R - 1.9 : AIM_RING_R - 0.9;
    pts.push(Math.cos(a) * inner, 0, Math.sin(a) * inner,
             Math.cos(a) * (AIM_RING_R + 0.3), 0, Math.sin(a) * (AIM_RING_R + 0.3));
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  g.add(new THREE.LineSegments(tg, new THREE.LineBasicMaterial({
    color: 0x8fa0d8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  g.visible = false;
  scene.add(g);
  return g;
}

const _tproj = new THREE.Vector3();
function updateAimTelemetry(power) {
  const speed = Math.hypot(launchVel.x, launchVel.z);
  const chip = document.getElementById('aim-readout');
  if (speed < MIN_LAUNCH) {
    if (aimDial) aimDial.visible = false;
  hideLeadVis();
    chip.hidden = true;
    return;
  }
  if (aimDial) {
    aimDial.visible = true;
    aimDial.position.set(ship.x, shipY() + 0.5, ship.z);
  }
  // screen-up is -z rotated by the camera yaw; report a compass heading so the
  // number means the same thing however the view is twisted
  let deg = (Math.atan2(launchVel.x, -launchVel.z) * 180) / Math.PI - (camYaw * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  chip.textContent = `${deg.toFixed(1)}° · ${Math.round(power * 100)}%`;
  _tproj.set(ship.x, shipY() + 0.5, ship.z).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  chip.style.left = `${r.left + ((_tproj.x + 1) / 2) * r.width}px`;
  chip.style.top = `${r.top + ((1 - _tproj.y) / 2) * r.height}px`;
  chip.hidden = false;
}

function updateAimArrow(power) {
  const speed = Math.hypot(launchVel.x, launchVel.z);
  updateAimTelemetry(power);
  if (speed < MIN_LAUNCH) { aimArrow.visible = false; return; }
  _dir.set(launchVel.x / speed, 0, launchVel.z / speed);
  aimArrow.position.set(ship.x, shipY() + 0.6, ship.z);
  aimArrow.setDirection(_dir);
  aimArrow.setLength(4 + power * 15, 2.6, 1.8);
  const col = power < 0.5 ? lerpColor(0x7cff6b, 0xffd166, power * 2) : lerpColor(0xffd166, 0xff5d5d, (power - 0.5) * 2);
  aimArrow.setColor(col);
  aimArrow.visible = true;
}

const _ca = new THREE.Color(), _cb = new THREE.Color();
function lerpColor(a, b, t) {
  _ca.setHex(a); _cb.setHex(b);
  return _ca.lerp(_cb, Math.min(Math.max(t, 0), 1)).getHex();
}

function updatePrediction() {
  const v = Math.hypot(launchVel.x, launchVel.z);
  if (v < MIN_LAUNCH) { predictLine.visible = false; predictDots.visible = false; predictMarker.visible = false; return; }
  const r = predict(level, ship.x, ship.z, launchVel.x, launchVel.z, simTime, PREDICT_T, stage);
  const dynamic = level.bodies.some(b => b.orbit);
  const nowPositions = bodiesAt(level, simTime);
  const attr = predictLine.geometry.getAttribute('position');
  const n = Math.min(r.points.length, PREDICT_MAX);
  for (let i = 0; i < n; i++) {
    const pt = r.points[i];
    const positions = dynamic ? bodiesAt(level, simTime + pt.t) : nowPositions;
    attr.array[i * 3] = pt.x;
    attr.array[i * 3 + 1] = surfaceY(pt.x, pt.z, positions) + 1.3;
    attr.array[i * 3 + 2] = pt.z;
  }
  attr.needsUpdate = true;
  predictLine.geometry.setDrawRange(0, n);
  // even spacing along the path, so short trails still read as a trail
  const dAttr = predictDots.geometry.getAttribute('position');
  const STEP_U = 1.15;
  let dn = 0, acc = STEP_U, px = attr.array[0], pz = attr.array[2];
  for (let i = 0; i < n && dn < PREDICT_MAX; i++) {
    const x = attr.array[i * 3], y = attr.array[i * 3 + 1], z = attr.array[i * 3 + 2];
    acc += Math.hypot(x - px, z - pz);
    px = x; pz = z;
    if (acc >= STEP_U) {
      acc = 0;
      dAttr.array[dn * 3] = x; dAttr.array[dn * 3 + 1] = y; dAttr.array[dn * 3 + 2] = z;
      dn++;
    }
  }
  dAttr.needsUpdate = true;
  predictDots.geometry.setDrawRange(0, dn);
  const good = r.outcome === 'goal' || r.outcome === 'waypoint';
  const bad = r.outcome === 'crash' || r.outcome === 'hazard';
  const color = good ? 0x7cff6b : bad ? 0xff5d5d : r.outcome === 'oob' ? 0x8a8fa3 : 0x9bd5ff;
  predictLine.material.color.setHex(color);
  predictLine.visible = true; predictDots.visible = true;
  if (good || bad) {
    const last = r.points[r.points.length - 1];
    const positions = dynamic ? bodiesAt(level, simTime + last.t) : nowPositions;
    predictMarker.position.set(last.x, surfaceY(last.x, last.z, positions) + 1.5, last.z);
    predictMarker.material.color.setHex(color);
    predictMarker.material.depthTest = false;
    predictMarker.renderOrder = 22;
    // scale with the view so "you end up here" stays legible when the whole
    // trail is only a few units long
    predictMarker.scale.setScalar(bad ? 1.5 : 1.1);
    predictMarker.visible = true;
  } else {
    predictMarker.visible = false;
  }
  updateLeadVis(r, dynamic);
}

// Where the target will be when the shot gets closest to it. The trajectory
// alone cannot explain a miss against a moving station: the line runs through
// where the target is NOW, while the shot is scored against where it will be.
let ghostRing = null, leadArc = null, leadLink = null;
let leadState = null;
function buildLeadVis() {
  if (ghostRing) return;
  ghostRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.1, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ghostRing.rotation.x = Math.PI / 2;
  ghostRing.material.depthTest = false;
  ghostRing.renderOrder = 19;
  ghostRing.visible = false;
  scene.add(ghostRing);

  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(120 * 3), 3));
  leadArc = new THREE.Points(arcGeo, new THREE.PointsMaterial({
    color: 0xffd166, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.5, depthWrite: false,
  }));
  leadArc.material.depthTest = false;
  leadArc.renderOrder = 19;
  leadArc.frustumCulled = false;
  leadArc.visible = false;
  scene.add(leadArc);

  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  leadLink = new THREE.Line(linkGeo, new THREE.LineDashedMaterial({
    color: 0xffd166, dashSize: 0.7, gapSize: 0.6, transparent: true, opacity: 0.6, depthWrite: false,
  }));
  leadLink.material.depthTest = false;
  leadLink.renderOrder = 19;
  leadLink.frustumCulled = false;
  leadLink.visible = false;
  scene.add(leadLink);

}

function hideLeadVis() {
  for (const o of [ghostRing, leadArc, leadLink]) if (o) o.visible = false;
  leadState = null;
}

function updateLeadVis(r, dynamic) {
  buildLeadVis();
  if (!dynamic || !r.points.length) { hideLeadVis(); return; }

  // closest approach to the target as it moves
  let best = null;
  for (let i = 0; i < r.points.length; i += 6) {
    const pt = r.points[i];
    const ps = bodiesAt(level, simTime + pt.t);
    const tgt = activeTarget(level, stage, ps);
    const d = Math.hypot(pt.x - tgt.x, pt.z - tgt.z);
    if (!best || d < best.d) best = { d, t: pt.t, sx: pt.x, sz: pt.z, tx: tgt.x, tz: tgt.z, r: tgt.r, ps };
  }
  if (!best) { hideLeadVis(); return; }
  leadState = best;

  const gy = surfaceY(best.tx, best.tz, best.ps) + 0.5;
  ghostRing.position.set(best.tx, gy, best.tz);
  ghostRing.scale.setScalar(best.r);
  ghostRing.visible = true;

  const linkAttr = leadLink.geometry.getAttribute('position');
  linkAttr.array.set([best.sx, surfaceY(best.sx, best.sz, best.ps) + 1.2, best.sz, best.tx, gy, best.tz]);
  linkAttr.needsUpdate = true;
  leadLink.computeLineDistances();
  leadLink.visible = best.d > best.r;

  {
    const attr = leadArc.geometry.getAttribute('position');
    const n = 60;
    for (let i = 0; i < n; i++) {
      const t = (best.t * i) / (n - 1);
      const ps = bodiesAt(level, simTime + t);
      const tg = activeTarget(level, stage, ps);
      attr.array[i * 3] = tg.x;
      attr.array[i * 3 + 1] = surfaceY(tg.x, tg.z, ps) + 0.5;
      attr.array[i * 3 + 2] = tg.z;
    }
    attr.needsUpdate = true;
    leadArc.geometry.setDrawRange(0, n);
    leadArc.geometry.computeBoundingSphere();
    leadArc.visible = true;
  }
}

function onKeyDown(e) {
  if (e.repeat) return;
  keys[e.code] = true;
  updateThrustSound();
  if (e.code === 'KeyR') { sfx.clickSound(); if (state !== 'menu') resetLevel(); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Escape') {
    if (levelPanelOpen()) setLevelPanel(false);
    else if (state === 'aiming') { aim = null; cancelAim(); }
  }
  if (e.code === 'KeyN' && state === 'won') nextLevel();
}

function thrustVector() {
  if (state !== 'flying' || fuel <= 0) return null;
  let tx2 = 0, tz = 0;
  if (keys.ArrowUp || keys.KeyW) tz -= 1;
  if (keys.ArrowDown || keys.KeyS) tz += 1;
  if (keys.ArrowLeft || keys.KeyA) tx2 -= 1;
  if (keys.ArrowRight || keys.KeyD) tx2 += 1;
  if (!tx2 && !tz) return null;
  const accel = THRUST_ACCEL * (carrying ? CARGO_THRUST_FACTOR : 1);
  const inv = accel / Math.hypot(tx2, tz);
  // rotate thrust into the (possibly yawed) camera frame so "up" stays screen-up
  const cos = Math.cos(camYaw), sin = Math.sin(camYaw);
  const wx = tx2 * inv, wz = tz * inv;
  return { x: wx * cos + wz * sin, z: -wx * sin + wz * cos };
}

function updateThrustSound() {
  const on = state === 'flying' && fuel > 0 &&
    (keys.ArrowUp || keys.KeyW || keys.ArrowDown || keys.KeyS || keys.ArrowLeft || keys.KeyA || keys.ArrowRight || keys.KeyD);
  if (on) sfx.startThrust(); else sfx.stopThrust();
}

function toggleMute() {
  sfx.setMuted(!sfx.isMuted());
  document.getElementById('btn-mute').textContent = sfx.isMuted() ? '🔇' : '🔊';
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
function burst(x, y, z, color, count) {
  const pos = new Float32Array(count * 3);
  const vel = [];
  for (let i = 0; i < count; i++) {
    pos.set([x, y, z], i * 3);
    vel.push(new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 18));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color, size: 2.6, sizeAttenuation: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  fxList.push({ obj: pts, vel, age: 0, life: 1.15 });
}

function updateFx(dt) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const fx = fxList[i];
    fx.age += dt;
    const attr = fx.obj.geometry.getAttribute('position');
    for (let j = 0; j < fx.vel.length; j++) {
      attr.array[j * 3] += fx.vel[j].x * dt;
      attr.array[j * 3 + 1] += fx.vel[j].y * dt;
      attr.array[j * 3 + 2] += fx.vel[j].z * dt;
      fx.vel[j].multiplyScalar(1 - 1.6 * dt);
    }
    attr.needsUpdate = true;
    fx.obj.material.opacity = Math.max(1 - fx.age / fx.life, 0);
    if (fx.age >= fx.life) {
      scene.remove(fx.obj);
      fx.obj.geometry.dispose();
      fx.obj.material.dispose();
      fxList.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  vTime += dt;
  // the world freezes while you aim, so the prediction line is EXACT: the
  // flight you release is simulated from the same instant you saw drawn
  if (state !== 'aiming') simTime += dt;
  frameCount++;

  const dynamic = level.bodies.some(b => b.orbit);

  if (state === 'flying') {
    physAcc += dt;
    const thrust = thrustVector();
    if (thrust) {
      fuel = Math.max(fuel - dt, 0);
      updateFuelBar();
      if (fuel <= 0) sfx.stopThrust();
    }
    while (physAcc >= STEP && state === 'flying') {
      physAcc -= STEP;
      const t = simTime - physAcc;
      const positions = stepShip(level, ship, t, STEP, thrust);
      const st = checkState(level, ship.x, ship.z, positions, hazardsAt(level, t), stage);
      if (st) {
        if (st.type === 'goal') onWin();
        else if (st.type === 'waypoint') beginDock(st.index);
        else if (st.type === 'oob') failOOB();
        else {
          lastCrash = st.body != null ? {
            body: st.body,
            gap: Math.hypot(ship.x - positions[st.body].x, ship.z - positions[st.body].z),
          } : null;
          onCrash(crashMessage(st));
        }
      }
    }
    if (state === 'flying') checkPickups();
  }

  if (state === 'docked' && dockAnim) {
    dockAnim.t += dt / 0.6;
    const k = Math.min(dockAnim.t, 1);
    const ease = 1 - (1 - k) * (1 - k);
    ship.x = dockAnim.fromX + (dockAnim.toX - dockAnim.fromX) * ease;
    ship.z = dockAnim.fromZ + (dockAnim.toZ - dockAnim.fromZ) * ease;
    ship.vx = ship.vz = 0;
    if (k >= 1) finishDock();
  }

  const positions = bodiesAt(level, simTime);
  if (dynamic && terrainNeedsUpdate(positions)) updateTerrain(positions);
  easeTerrain(dt);

  // bodies
  for (let i = 0; i < bodyVisuals.length; i++) {
    const bv = bodyVisuals[i], p = positions[i];
    const y = surfaceY(p.x, p.z, positions);
    bv.group.position.set(p.x, y + bv.body.radius * 0.55, p.z);
    bv.group.rotation.y += bv.spin * dt;
    if (bv.arrow) updateMotionArrow(bv.arrow, bodiesAt, i, y + bv.body.radius + 3, );
    if (bv.discGroup) bv.discGroup.children[0].rotation.z += dt * 0.5;
    const pulse = bv.group.getObjectByName('pulse');
    if (pulse) pulse.scale.setScalar(1 + Math.sin(vTime * 3.2) * 0.06);
    const corona = bv.group.getObjectByName('corona');
    if (corona) corona.scale.setScalar(bv.body.radius * (5.2 + Math.sin(vTime * 1.7) * 0.5));
  }

  updateOrbitPaths(positions);

  // hazards
  const hazPositions = hazardsAt(level, simTime);
  for (let i = 0; i < hazardVisuals.length; i++) {
    const hv = hazardVisuals[i], p = hazPositions[i];
    const y = surfaceY(p.x, p.z, positions) + 1.6;
    hv.group.position.set(p.x, y, p.z);
    if (hv.prev) {
      const dx = p.x - hv.prev.x, dz = p.z - hv.prev.z;
      if (dx * dx + dz * dz > 1e-8) hv.group.rotation.y = Math.atan2(dx, dz);
      else hv.group.rotation.y += 0.5 * dt;
    }
    hv.prev = { x: p.x, z: p.z };
    if (hv.arrow) updateMotionArrow(hv.arrow, hazardsAt, i, y + hv.hazard.radius + 2.5);
    if (hv.hazard.kind === 'asteroid') hv.group.rotation.y += dt * 0.3;
    if (hv.hazard.comet && level.bodies.length) {
      // tail streams away from the sun
      const sun = positions[0];
      hv.group.rotation.y = Math.atan2(p.x - sun.x, p.z - sun.z);
    }
  }

  // pickups
  for (const pv of pickupVisuals) {
    const taken = pickupsDone.has(pv.index) || pickupsTemp.has(pv.index);
    pv.group.visible = !taken;
    if (!taken) {
      const y = surfaceY(pv.pickup.x, pv.pickup.z, positions);
      pv.group.position.set(pv.pickup.x, y + 2.2 + Math.sin(vTime * 2 + pv.index) * 0.5, pv.pickup.z);
      pv.group.rotation.y += dt * 1.2;
    }
  }

  // waypoints
  for (const wv of waypointVisuals) {
    const wx = anchorX(wv.wp, positions), wz = anchorZ(wv.wp, positions);
    const y = surfaceY(wx, wz, positions);
    wv.group.position.set(wx, y + 0.5, wz);
    const ring = wv.group.getObjectByName('ring');
    if (wv.index === stage) ring.scale.setScalar(1 + Math.sin(vTime * 2.6) * 0.07);
    const core = wv.group.getObjectByName('core');
    if (core) core.rotation.y += dt * 0.8;
  }

  // goal + pad (both may be stations riding an orbiting body)
  const goalX = anchorX(level.goal, positions), goalZ = anchorZ(level.goal, positions);
  goalGroup.position.set(goalX, goalY(positions) + 0.5, goalZ);
  const gring = goalGroup.getObjectByName('pulse');
  if (gring && stage >= (level.waypoints || []).length) gring.scale.setScalar(1 + Math.sin(vTime * 2.6) * 0.07);
  const gstation = goalGroup.getObjectByName('station');
  if (gstation) gstation.rotation.y += dt * 0.5;
  const padX = anchorX(level.ship, positions), padZ = anchorZ(level.ship, positions);
  padGroup.position.set(padX, surfaceY(padX, padZ, positions) + 0.4, padZ);
  // the parked ship rides its pad until launch
  if (state === 'ready' || state === 'aiming') {
    if (stage === 0) { ship.x = padX; ship.z = padZ; }
    else {
      const wp = level.waypoints[stage - 1];
      ship.x = anchorX(wp, positions); ship.z = anchorZ(wp, positions);
    }
  }
  updateBeacon(positions);

  // ship
  if (shipGroup.visible) {
    const sy = shipY(positions);
    const bob = state === 'ready' || state === 'aiming' ? Math.sin(vTime * 2.2) * 0.35 : 0;
    shipBob = bob;
    shipGroup.position.set(ship.x, sy + bob, ship.z);
    if (state === 'flying' && (ship.vx || ship.vz)) {
      shipGroup.rotation.y = Math.atan2(ship.vx, ship.vz);
    } else if (state === 'ready' || state === 'aiming') {
      const tgt = activeTarget(level, stage, positions);
      const dir = state === 'aiming' && Math.hypot(launchVel.x, launchVel.z) > 2
        ? launchVel : { x: tgt.x - ship.x, z: tgt.z - ship.z };
      shipGroup.rotation.y = Math.atan2(dir.x, dir.z);
    }
    const thrusting = state === 'flying' && thrustVector();
    engineSprite.material.opacity = thrusting ? 0.95 : state === 'flying' ? 0.55 : 0.3;
    engineSprite.scale.setScalar(thrusting ? 5.5 + Math.random() * 1.5 : 3.5);
  }

  // trail
  if (state === 'flying') {
    const sy = shipY(positions);
    trailPts.push({ x: ship.x, y: sy, z: ship.z });
    if (trailPts.length > TRAIL_MAX) trailPts.shift();
    const pa = trailLine.geometry.getAttribute('position');
    const ca = trailLine.geometry.getAttribute('color');
    for (let i = 0; i < trailPts.length; i++) {
      const p = trailPts[i], t = i / trailPts.length;
      pa.array.set([p.x, p.y, p.z], i * 3);
      ca.array.set([0.1 * t + 0.05, 0.7 * t + 0.05, t * 0.9 + 0.1], i * 3);
    }
    pa.needsUpdate = true;
    ca.needsUpdate = true;
    trailLine.geometry.setDrawRange(0, trailPts.length);
  }


  updateFx(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}

function checkPickups() {
  const pickups = level.pickups || [];
  for (let i = 0; i < pickups.length; i++) {
    if (pickupsDone.has(i) || pickupsTemp.has(i)) continue;
    const p = pickups[i];
    const dx = p.x - ship.x, dz = p.z - ship.z;
    if (dx * dx + dz * dz < PICKUP_R * PICKUP_R) {
      pickupsTemp.add(i);
      fuel = Math.min(fuel + (p.fuel || 1.5), level.fuel);
      updateFuelBar();
      sfx.pickupSound();
      toast('⛽ Fuel cell collected!');
    }
  }
}

// Height of the DRAWN surface at a point. Every object resting on the terrain
// must go through this one helper rather than calling heightAt directly, so
// the ship, rings, pad and trail can never drift out of agreement with the
// ground (and with each other) if the surface is ever restyled again.
function surfaceY(x, z, positions) { return heightAt(level, x, z, positions); }
function shipY(positions) {
  const p = positions || bodiesAt(level, simTime);
  return surfaceY(ship.x, ship.z, p) + 1.6;
}
function goalY(positions) {
  const p = positions || bodiesAt(level, simTime);
  return surfaceY(anchorX(level.goal, p), anchorZ(level.goal, p), p);
}

function updateCamera(dt) {
  const E = level.extent;
  // Parked on a pad that rides an orbiting world, the ship drifts while the
  // player lines up a shot. Carry the view along by the ship's own
  // displacement rather than re-centring on it, so the leg's chosen framing
  // (and any pan the player has made) survives.
  if ((state === 'ready' || state === 'aiming') && !gesture) {
    if (camDriftFrom) {
      camPan.x += ship.x - camDriftFrom.x;
      camPan.z += ship.z - camDriftFrom.z;
      clampPan();
    }
    camDriftFrom = { x: ship.x, z: ship.z };
  } else {
    camDriftFrom = null;
  }
  if (state === 'flying' && !gesture) {
    // follow the ship: the tight framing would lose it in a frame or two
    const k2 = Math.min(dt * 3, 1);
    camPan.x += (ship.x - camPan.x) * k2;
    camPan.z += (ship.z - camPan.z) * k2;
    clampPan();
    // and breathe the zoom so the ship and what it is heading for both stay
    // in frame as the gap between them opens and closes
    const tgt = activeTarget(level, stage, bodiesAt(level, simTime));
    const want = Math.min(Math.max(fitZoom(tgt, 0.07, 0.15, true), 9 / E), 1.8);
    camZoom += (want - camZoom) * Math.min(dt * 1.6, 1);
  }
  const inFlight = state === 'flying' || state === 'crashed' || state === 'won';
  const followX = state === 'flying' ? 0 : inFlight ? ship.x * 0.25 : ship.x * 0.3;
  const followZ = state === 'flying' ? 0 : inFlight ? ship.z * 0.15 : ship.z * 0.18;
  const target = new THREE.Vector3(followX * 0.4 + camPan.x, -4, followZ * 0.4 + camPan.z);
  // offset from target, rotated about Y by the two-finger twist yaw
  const ox = followX * 0.6, oz = E * 1.52 * camZoom + followZ * 0.6;
  const cos = Math.cos(camYaw), sin = Math.sin(camYaw);
  const desired = new THREE.Vector3(
    target.x + ox * cos + oz * sin,
    E * 1.02 * camZoom,
    target.z + (-ox * sin + oz * cos),
  );
  const k = Math.min(dt * (gesture ? 8 : 2.5), 1);
  camera.position.lerp(desired, k);
  camera.lookAt(target);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function setHint(text) {
  document.getElementById('hint').textContent = text;
}

function showPower(frac, cost) {
  const el = document.getElementById('power');
  el.hidden = false;
  el.textContent = `⚡ ${Math.round(frac * 100)}% · −${cost.toFixed(1)}⛽`;
  const track = document.getElementById('fuel-cost');
  const costPct = (cost / level.fuel) * 100;
  const fillPct = (fuel / level.fuel) * 100;
  track.style.left = `${Math.max(fillPct - costPct, 0)}%`;
  track.style.width = `${Math.min(costPct, fillPct)}%`;
  track.hidden = false;
}
function hidePower() {
  document.getElementById('power').hidden = true;
  document.getElementById('fuel-cost').hidden = true;
}
function updateFuelBar() {
  document.getElementById('fuel-fill').style.width = `${(fuel / level.fuel) * 100}%`;
}
function updateAttempts() {
  document.getElementById('attempts').textContent = `🚀 ${attempts}`;
}

const WP_ICONS = { station: '🛰', cargo: '📦', dropoff: '📥' };
function updateStopsHud() {
  const el = document.getElementById('stops');
  const wps = level.waypoints || [];
  if (!wps.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = wps.map((wp, i) =>
    `<span class="${i < stage ? 'stop-done' : i === stage ? 'stop-active' : 'stop-todo'}">${WP_ICONS[wp.type] || '🛰'}</span>`
  ).join('') + `<span class="${stage >= wps.length ? 'stop-active' : 'stop-todo'}">🏁</span>`;
}
function updateCargoHud() {
  document.getElementById('cargo').hidden = !carrying;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function buildLevelBar() {
  const setBar = document.getElementById('set-bar');
  setBar.innerHTML = '';
  SETS.forEach((set, s) => {
    const b = document.createElement('button');
    const earned = save.unlocked > s * 10;
    const unlocked = earned || save.experimental;
    b.className = 'set-btn' + (s === displaySet ? ' current' : '') + (unlocked ? '' : ' locked') + (unlocked && !earned ? ' exp' : '');
    b.textContent = unlocked ? `${'★'.repeat(set.difficulty)}` : '🔒';
    b.title = unlocked ? `${set.name} (levels ${s * 10 + 1}–${s * 10 + 10})` : 'Locked — finish the previous set';
    b.disabled = !unlocked;
    b.addEventListener('click', () => {
      sfx.clickSound();
      displaySet = s;
      buildLevelBar();
    });
    setBar.appendChild(b);
  });

  document.getElementById('set-name').textContent = SETS[displaySet].name;

  const bar = document.getElementById('dot-bar');
  bar.innerHTML = '';
  for (let i = displaySet * 10; i < displaySet * 10 + 10; i++) {
    const lv = LEVELS[i];
    const b = document.createElement('button');
    const earned = i < save.unlocked;
    const unlocked = earned || save.experimental;
    b.className = 'level-dot' + (i === levelIndex ? ' current' : '') + (unlocked ? '' : ' locked') + (unlocked && !earned ? ' exp' : '');
    const stars = save.stars[i] || 0;
    b.textContent = unlocked ? String(i + 1) : '🔒';
    b.title = unlocked ? `${lv.name}${stars ? ' ' + '★'.repeat(stars) : ''}` : 'Locked';
    b.disabled = !unlocked;
    b.addEventListener('click', () => {
      sfx.clickSound();
      hideOverlay();
      loadLevel(i);
    });
    bar.appendChild(b);
  }
}

function overlayEl() { return document.getElementById('overlay'); }
function hideOverlay() { overlayEl().classList.remove('show'); }
function showOverlay(html) {
  overlayEl().innerHTML = html;
  overlayEl().classList.add('show');
}

function showMenu() {
  state = 'menu';
  showOverlay(`
    <div class="panel">
      <div class="menu-emoji">🌌</div>
      <h1>GravityLoop</h1>
      <p class="tagline">Spaceship golf across the curves of spacetime.</p>
      <p class="howto">
        <b>Drag back</b> from your ship and release to launch — pull farther for more power,
        but big launches burn more fuel ⛽ and stops never refuel.<br>
        The terrain <i>is</i> gravity — dive into wells to speed up, ride ridges to coast.<br>
        <b>WASD / arrows</b> nudge mid-flight. On multi-stop routes, grab fuel cells<br>
        or you won't make the next hop. Dodge patrols, haul cargo 📦, mind the ⚙ engine.<br>
        <b>Pinch</b> or <b>scroll</b> to zoom, two-finger drag to pan.<br>
        <b>R</b> restart · <b>M</b> mute · fewer launches = more stars ⭐
      </p>
      <button id="btn-play" class="big">▶ Play</button>
      <button id="btn-news" class="linkish">v${VERSION} · What's new${unreadNews() ? ' <span class="news-dot">NEW</span>' : ''}</button>
      <button id="btn-rebuild" class="linkish">Built by AI · rebuild it yourself</button>
    </div>`);
  document.getElementById('btn-play').addEventListener('click', () => {
    sfx.clickSound();
    hideOverlay();
    resetLevel();
    state = 'ready';
  });
  document.getElementById('btn-news').addEventListener('click', () => {
    sfx.clickSound();
    showChangelog();
  });
  document.getElementById('btn-rebuild').addEventListener('click', () => {
    sfx.clickSound();
    showRebuild();
  });
}

// The whole game was specified in conversation and built by an AI agent, so
// the spec that reconstitutes it ships with it — readable and copyable here,
// versioned as PROMPT.md in the repo.
const REPO = 'https://github.com/CoderCoop/GravityLoop';
async function showRebuild() {
  showOverlay(`
    <div class="panel wide">
      <h1 class="news-h1">Rebuild this game</h1>
      <p class="tagline">GravityLoop was specified in conversation and written by an AI
        coding agent. It ships with the specification that rebuilds it — requirements in
        EARS notation, a design, and a phased task list. Copy the whole thing into an
        agent in an empty directory and you should get this game back.</p>
      <pre id="prompt-box" class="promptbox">Loading…</pre>
      <div class="rebuild-actions">
        <button id="btn-copy-prompt">📋 Copy full spec</button>
        <a class="btnlink" href="${REPO}/blob/main/spec/requirements.md" target="_blank" rel="noopener">requirements ↗</a>
        <a class="btnlink" href="${REPO}/blob/main/spec/design.md" target="_blank" rel="noopener">design ↗</a>
        <a class="btnlink" href="${REPO}/blob/main/spec/tasks.md" target="_blank" rel="noopener">tasks ↗</a>
      </div>
      <button id="btn-rebuild-back" class="big">◀ Back</button>
    </div>`);
  document.getElementById('btn-rebuild-back').addEventListener('click', () => {
    sfx.clickSound();
    showMenu();
  });
  // Assemble the kickoff prompt and the three spec documents into one
  // copyable block, straight from the repo files — no second copy to drift.
  let text = '';
  try {
    const [prompt, ...specs] = await Promise.all(
      ['PROMPT.md', 'spec/requirements.md', 'spec/design.md', 'spec/tasks.md']
        .map(f => fetch(f).then(r => r.text())),
    );
    const kickoff = prompt.split('## The kickoff prompt')[1].split('\n## ')[0]
      .split('\n').filter(l => l.startsWith('>')).map(l => l.replace(/^> ?/, '')).join('\n').trim();
    text = [kickoff, ...specs.map(s => `\n\n${'='.repeat(60)}\n\n${s.trim()}`)].join('');
  } catch {
    text = `Could not load the spec offline — read it at ${REPO}/blob/main/PROMPT.md`;
  }
  const box = document.getElementById('prompt-box');
  if (box) box.textContent = text;
  const copy = document.getElementById('btn-copy-prompt');
  if (copy) {
    copy.addEventListener('click', async () => {
      sfx.clickSound();
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = '✓ Copied';
      } catch {
        copy.textContent = 'Select the text above to copy';
      }
    });
  }
}

// ------------------------------------------------------------- what's new
const NEWS_KEY = 'gl-news-seen';
function unreadNews() {
  try { return localStorage.getItem(NEWS_KEY) !== VERSION; } catch { return false; }
}
function showChangelog() {
  try { localStorage.setItem(NEWS_KEY, VERSION); } catch { /* private mode */ }
  const entries = CHANGELOG.map((e, i) => `
    <div class="rel${i === 0 ? ' latest' : ''}">
      <div class="rel-head"><span class="rel-v">v${e.v}</span> <span class="rel-t">${e.title}</span>
        <span class="rel-d">${e.date}</span></div>
      <ul>${e.notes.map(n => `<li>${n}</li>`).join('')}</ul>
    </div>`).join('');
  showOverlay(`
    <div class="panel wide">
      <h1 class="news-h1">What's new</h1>
      <div class="rel-list">${entries}</div>
      <button id="btn-news-back" class="big">◀ Back</button>
    </div>`);
  document.getElementById('btn-news-back').addEventListener('click', () => {
    sfx.clickSound();
    showMenu();
  });
}

function showWin(earned) {
  const last = levelIndex === LEVELS.length - 1;
  const setDone = (levelIndex + 1) % 10 === 0 && !last;
  const starStr = '★'.repeat(earned) + '☆'.repeat(3 - earned);
  const legs = legCount(level);
  const msg = attempts <= legs ? (legs > 1 ? 'Perfect route! 🛰' : 'Hole in one! 🏌️') : attempts <= legs + 2 ? 'Smooth flying!' : 'Made it!';
  const setIdx = Math.floor(levelIndex / 10);
  showOverlay(`
    <div class="panel">
      <h2>${msg}</h2>
      <div class="stars">${starStr}</div>
      <p class="tagline">${level.name} cleared in ${attempts} launch${attempts === 1 ? '' : 'es'}${legs > 1 ? ` (${legs} legs)` : ''}</p>
      ${setDone
        ? `<p class="howto">🎓 <b>${SETS[setIdx].name} complete!</b><br>Next up: <b>${SETS[setIdx + 1].name}</b> ${'★'.repeat(SETS[setIdx + 1].difficulty)} — things get trickier from here.</p>`
        : ''}
      ${last
        ? '<p class="howto">🏆 All 50 levels cleared — you\'ve mastered the gravity wells!<br>Replay any level from the bar below to hunt three stars.</p>'
        : ''}
      <div class="btn-row">
        <button id="btn-replay">↻ Replay</button>
        ${last ? '' : '<button id="btn-next" class="big">Next Level ▶</button>'}
      </div>
    </div>`);
  document.getElementById('btn-replay').addEventListener('click', () => {
    sfx.clickSound();
    hideOverlay();
    loadLevel(levelIndex);
  });
  const nx = document.getElementById('btn-next');
  if (nx) nx.addEventListener('click', () => { sfx.clickSound(); nextLevel(); });
}

function nextLevel() {
  hideOverlay();
  loadLevel(Math.min(levelIndex + 1, LEVELS.length - 1));
}

// Minimal debug/test hooks (used by the headless smoke tests).
window.GL = {
  load: i => loadLevel(i),
  launch: (vx, vz) => { if (state === 'ready') launch(vx, vz); },
  status: () => ({ state, stage, fuel, attempts, carrying, level: levelIndex }),
  aim: () => ({ fine: fineActive, gain: +fineGain.toFixed(3), v: aimFinePrev && Math.round(aimFinePrev.v), vel: { ...launchVel } }),
  // Do the drawn positions agree with what the physics decided?
  debugCollide: () => {
    if (!lastCrash) return { state };
    const bv = bodyVisuals[lastCrash.body];
    const sp = shipGroup.position, bp = bv.group.position;
    return {
      state,
      body: bv.body.name,
      bodyR: +bv.body.radius.toFixed(2),
      gapAtCrash: +lastCrash.gap.toFixed(2),
      drawnGap: +Math.hypot(sp.x - bp.x, sp.z - bp.z).toFixed(2),
      dy: +(sp.y - bp.y).toFixed(2),
    };
  },
  // Everything the contract test needs to compare the drawn scene with the
  // scoring geometry.
  debugContract: () => {
    const ps = bodiesAt(level, simTime);
    const rings = [];
    const goalRing = goalGroup.getObjectByName('pulse');
    rings.push({
      what: 'goal ring',
      drawnRadius: goalRing.geometry.parameters.radius,
      scoringRadius: level.goal.r,
      tube: goalRing.geometry.parameters.tube,
    });
    for (const wv of waypointVisuals) {
      const g = wv.group.getObjectByName('ring').geometry.parameters;
      rings.push({ what: `waypoint ${wv.index} ring`, drawnRadius: g.radius, scoringRadius: wv.wp.r, tube: g.tube });
    }
    const bodies = bodyVisuals.map(bv => ({
      name: bv.body.name,
      drawnRadius: bv.body.type === 'blackhole' ? bv.body.horizon : bv.body.radius,
      hitRadius: (bv.body.horizon || bv.body.radius) + SHIP_R * 0.25,
    }));
    const onSurface = [
      { what: 'ship', y: shipGroup.position.y, surfaceY: surfaceY(ship.x, ship.z, ps), offset: 1.6 + shipBob },
      { what: 'launch pad', y: padGroup.position.y,
        surfaceY: surfaceY(anchorX(level.ship, ps), anchorZ(level.ship, ps), ps), offset: 0.4 },
      { what: 'goal', y: goalGroup.position.y,
        surfaceY: surfaceY(anchorX(level.goal, ps), anchorZ(level.goal, ps), ps), offset: 0.5 },
    ];
    for (const wv of waypointVisuals) {
      onSurface.push({
        what: `waypoint ${wv.index}`, y: wv.group.position.y,
        surfaceY: surfaceY(anchorX(wv.wp, ps), anchorZ(wv.wp, ps), ps), offset: 0.5,
      });
    }
    return { rings, bodies, onSurface };
  },
  debugRing: () => {
    const ring = goalGroup.getObjectByName('pulse');
    const tube = ring.geometry.parameters.tube;
    return {
      r: level.goal.r,
      inner: +(ring.geometry.parameters.radius - tube).toFixed(2),
      outer: +(ring.geometry.parameters.radius + tube).toFixed(2),
    };
  },
  perf: () => {
    const ps = bodiesAt(level, simTime);
    let t0 = performance.now();
    for (let i = 0; i < 5; i++) updateTerrain(ps, true);
    const deform = (performance.now() - t0) / 5;
    t0 = performance.now();
    for (let i = 0; i < 20; i++) easeTerrain(1 / 60);
    return {
      bodies: level.bodies.length,
      deformMs: +deform.toFixed(2),
      easeMs: +((performance.now() - t0) / 20).toFixed(2),
    };
  },
  debugPredict: () => {
    const v = Math.hypot(launchVel.x, launchVel.z);
    const r = predict(level, ship.x, ship.z, launchVel.x, launchVel.z, simTime, PREDICT_T, stage);
    const ys = [];
    const attr = predictLine.geometry.getAttribute('position');
    const n = predictLine.geometry.drawRange.count;
    for (let i = 0; i < Math.min(n, 400); i++) ys.push(attr.array[i * 3 + 1]);
    return {
      speed: +v.toFixed(2), outcome: r.outcome, pts: r.points.length, drawn: n,
      lineVis: predictLine.visible, dotsVis: predictDots.visible,
      dotsDrawn: predictDots.geometry.drawRange.count,
      yMin: ys.length ? +Math.min(...ys).toFixed(1) : null,
      yMax: ys.length ? +Math.max(...ys).toFixed(1) : null,
      shipY: +shipY().toFixed(1),
      screen: (() => {
        const v = new THREE.Vector3();
        const rect = renderer.domElement.getBoundingClientRect();
        const out = [];
        for (const i of [0, Math.floor(n / 2), n - 1]) {
          if (i < 0) continue;
          v.set(attr.array[i * 3], attr.array[i * 3 + 1], attr.array[i * 3 + 2]).project(camera);
          out.push([Math.round((v.x + 1) / 2 * rect.width), Math.round((1 - v.y) / 2 * rect.height)]);
        }
        return out;
      })(),
    };
  },
  debugSpots: () => {
    const p = bodiesAt(level, simTime);
    return {
      t: simTime,
      goal: { x: anchorX(level.goal, p), z: anchorZ(level.goal, p) },
      pad: { x: anchorX(level.ship, p), z: anchorZ(level.ship, p) },
      shipScreen: (() => {
        const v = new THREE.Vector3(ship.x, shipY(p), ship.z).project(camera);
        const r = renderer.domElement.getBoundingClientRect();
        return { x: Math.round((v.x + 1) / 2 * r.width), y: Math.round((1 - v.y) / 2 * r.height) };
      })(),
    };
  },
};

init();
