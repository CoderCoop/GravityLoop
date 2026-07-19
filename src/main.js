// GravityLoop — spaceship golf across gravity-well terrain.
import * as THREE from '../vendor/three.module.js';
import {
  STEP, PREDICT_T, bodiesAt, hazardsAt, heightAt, checkState, stepShip, predict,
  activeTarget, legStart, legCount, launchFuelCost, maxAffordableLaunch,
} from './physics.js';
import { LEVELS, SETS } from './levels.js';
import * as sfx from './audio.js';
import * as tx from './textures.js';

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const GRID_N = 81;            // terrain vertices per side
const AIM_SCALE = 1.15;       // drag distance -> launch speed
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
let hazardVisuals = [];       // [{ group, hazard, prev }]
let pickupVisuals = [];       // [{ group, pickup, index }]
let waypointVisuals = [];     // [{ group, wp, ringMat, glow }]
let shipGroup, engineSprite, cargoBox, trailLine, trailPts = [];
let predictLine, predictMarker, aimArrow;
let aimAnchor, aimHandle, aimBand;
let goalGroup, padGroup;
let fxList = [];

let level = null, levelIndex = 0, displaySet = 0;
let frameCount = 0;
let state = 'menu';           // menu | ready | aiming | flying | docked | crashed | won
let simTime = 0;
let physAcc = 0;
let ship = { x: 0, z: 0, vx: 0, vz: 0 };
let fuel = 0, attempts = 0;
let stage = 0, carrying = false;
let pickupsDone = new Set(), pickupsTemp = new Set();
let dockAnim = null;          // { fromX, fromZ, toX, toZ, t, index }
let aim = null;
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
  updateTerrain(bodiesAt(level, simTime));
}

const _c = new THREE.Color();
function heightColor(y, out, o) {
  if (y > 0.4) {
    const t = Math.min(y / 12, 1);
    _c.setRGB(0.16 + 0.84 * t, 0.2 + 0.22 * t, 0.42 - 0.25 * t);
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
  out[o] = _c.r; out[o + 1] = _c.g; out[o + 2] = _c.b;
}

function updateTerrain(positions) {
  const { gridX, gridZ, posAttr, colAttr } = terrain;
  const pos = posAttr.array, col = colAttr.array;
  for (let idx = 0; idx < gridX.length; idx++) {
    const y = heightAt(level, gridX[idx], gridZ[idx], positions);
    pos[idx * 3 + 1] = y;
    heightColor(y, col, idx * 3);
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Bodies (planets, suns, black holes, repulsors)
// ---------------------------------------------------------------------------
function isSun(body) { return body.type === 'sun' || (body.mass >= 2500 && !body.type); }

function buildBodies() {
  for (const bv of bodyVisuals) scene.remove(bv.group);
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
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(body.radius, 1),
        new THREE.MeshBasicMaterial({ color: body.color }),
      );
      const wire = new THREE.Mesh(
        new THREE.IcosahedronGeometry(body.radius * 1.12, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.3 }),
      );
      group.add(rock, wire, makeGlow(body.color, body.radius * 5));
      spin = 0.8;
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
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 24, 18),
        new THREE.MeshBasicMaterial({ map: tx.planetTexture(body.color, seed, style) }),
      );
      sphere.rotation.z = 0.2 - (seed % 100) / 250;
      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 1.12, 20, 14),
        new THREE.MeshBasicMaterial({ color: body.color, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      group.add(sphere, atmo, makeGlow(body.color, body.radius * 3.6, 0.55));
      if (style === 'banded' && seed % 3 === 0) {
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
    bodyVisuals.push({ group, body, spin, discGroup });
  }
}

// ---------------------------------------------------------------------------
// Hazard ships, fuel pickups, waypoints
// ---------------------------------------------------------------------------
function buildHazards() {
  for (const hv of hazardVisuals) scene.remove(hv.group);
  hazardVisuals = [];
  for (const hazard of (level.hazards || [])) {
    const group = new THREE.Group();
    const moving = !!(hazard.orbit || hazard.patrol);
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
    scene.add(group);
    hazardVisuals.push({ group, hazard, prev: null });
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

const WP_COLORS = { station: 0x35e0ff, cargo: 0xffb703, dropoff: 0xc77dff };
function buildWaypoints() {
  for (const wv of waypointVisuals) scene.remove(wv.group);
  waypointVisuals = [];
  (level.waypoints || []).forEach((wp, index) => {
    const color = WP_COLORS[wp.type] || 0x35e0ff;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(wp.r, 0.35, 10, 44),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.name = 'ring';
    let core;
    if (wp.type === 'cargo') {
      core = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    } else if (wp.type === 'dropoff') {
      core = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.4, 0.7, 8), new THREE.MeshBasicMaterial({ color: 0xc77dff }));
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
    core.position.y = 1.4;
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
function buildGoal() {
  if (goalGroup) scene.remove(goalGroup);
  goalGroup = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(level.goal.r, 0.4, 10, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.name = 'pulse';
  goalRingMat = ring.material;
  goalBeacon = new THREE.Mesh(
    new THREE.CylinderGeometry(level.goal.r * 0.45, level.goal.r * 0.7, 46, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.07, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  goalBeacon.position.y = 23;
  goalGlow = makeGlow(0xffd166, level.goal.r * 4);
  goalGroup.add(ring, goalBeacon, goalGlow);
  scene.add(goalGroup);
}

function setGoalActive(active) {
  if (!goalRingMat) return;
  goalRingMat.opacity = active ? 0.95 : 0.25;
  goalBeacon.visible = active;
  goalGlow.material.opacity = active ? 0.85 : 0.2;
}

function buildPad() {
  if (padGroup) scene.remove(padGroup);
  padGroup = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.6, 0.25, 8, 36),
    new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  padGroup.add(ring);
  scene.add(padGroup);
}

function buildShip() {
  shipGroup = new THREE.Group();
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
  predictLine.frustumCulled = false;
  predictLine.visible = false;
  scene.add(predictLine);
  predictMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
  );
  predictMarker.visible = false;
  scene.add(predictMarker);
  aimArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 6, 0x7cff6b, 2.4, 1.6);
  aimArrow.visible = false;
  scene.add(aimArrow);

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
  predictMarker.visible = false;
  aimArrow.visible = false;
  aimAnchor.visible = false;
  aimHandle.visible = false;
  aimBand.visible = false;
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
  resetCamera();
  buildTerrain();
  buildBodies();
  buildHazards();
  buildPickups();
  buildGoal();
  buildWaypoints();
  buildPad();
  resetLeg();
  document.getElementById('level-label').textContent = `${i + 1} · ${level.name}`;
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
  const start = legStart(level, stage);
  ship = { x: start.x, z: start.z, vx: 0, vz: 0 };
  fuel = level.fuel;
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
  resetCamera();
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
  if (wp.type === 'cargo') toast('📦 Cargo secured! It\'s heavy — thrusters at half power.');
  else if (wp.type === 'dropoff') toast('📦 Cargo delivered!');
  else toast('🛰 Docked — refueled and ready!');
  resetLeg();
}

function onCrash(reason) {
  state = 'crashed';
  sfx.stopThrust();
  sfx.crashSound();
  const y = heightAt(level, ship.x, ship.z, bodiesAt(level, simTime)) + 1.6;
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
    const moving = !!(h.orbit || h.patrol);
    return moving ? '💥 Collided with a patrol ship!' : '💥 Collided with a derelict ship!';
  }
  const b = level.bodies[st.body];
  if (b.type === 'blackhole') return `🕳️ Swallowed by ${b.name}! Nothing escapes the red ring.`;
  if (b.mass < 0) return `💥 Smacked into ${b.name}!`;
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
function resetCamera() {
  camZoom = 1;
  camYaw = 0;
  camPan = { x: 0, z: 0 };
}
function onWheel(e) {
  e.preventDefault();
  camZoom = Math.min(Math.max(camZoom * Math.exp(e.deltaY * 0.0012), 0.45), 1.8);
}

function onPointerDown(e) {
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
  aimPointerId = e.pointerId;
  state = 'aiming';
  updateAim(e);
}

function onPointerMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture && pointers.size === 2) {
    const s = gestureShape();
    camZoom = Math.min(Math.max(gesture.zoom0 * (gesture.d0 / s.d), 0.45), 1.8);
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

function updateAim(e) {
  const p = pointerToWorld(e);
  if (!p) return;
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
  updatePrediction();
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
function updateAimArrow(power) {
  const speed = Math.hypot(launchVel.x, launchVel.z);
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
  if (v < MIN_LAUNCH) { predictLine.visible = false; predictMarker.visible = false; return; }
  const r = predict(level, ship.x, ship.z, launchVel.x, launchVel.z, simTime, PREDICT_T, stage);
  const dynamic = level.bodies.some(b => b.orbit);
  const nowPositions = bodiesAt(level, simTime);
  const attr = predictLine.geometry.getAttribute('position');
  const n = Math.min(r.points.length, PREDICT_MAX);
  for (let i = 0; i < n; i++) {
    const pt = r.points[i];
    const positions = dynamic ? bodiesAt(level, simTime + pt.t) : nowPositions;
    attr.array[i * 3] = pt.x;
    attr.array[i * 3 + 1] = heightAt(level, pt.x, pt.z, positions) + 1.3;
    attr.array[i * 3 + 2] = pt.z;
  }
  attr.needsUpdate = true;
  predictLine.geometry.setDrawRange(0, n);
  const good = r.outcome === 'goal' || r.outcome === 'waypoint';
  const bad = r.outcome === 'crash' || r.outcome === 'hazard';
  const color = good ? 0x7cff6b : bad ? 0xff5d5d : r.outcome === 'oob' ? 0x8a8fa3 : 0x9bd5ff;
  predictLine.material.color.setHex(color);
  predictLine.visible = true;
  if (good || bad) {
    const last = r.points[r.points.length - 1];
    const positions = dynamic ? bodiesAt(level, simTime + last.t) : nowPositions;
    predictMarker.position.set(last.x, heightAt(level, last.x, last.z, positions) + 1.5, last.z);
    predictMarker.material.color.setHex(color);
    predictMarker.visible = true;
  } else {
    predictMarker.visible = false;
  }
}

function onKeyDown(e) {
  if (e.repeat) return;
  keys[e.code] = true;
  updateThrustSound();
  if (e.code === 'KeyR') { sfx.clickSound(); if (state !== 'menu') resetLevel(); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Escape' && state === 'aiming') { aim = null; cancelAim(); }
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
  simTime += dt;
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
        else onCrash(crashMessage(st));
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
  if (dynamic && (level.bodies.length <= 4 || frameCount % 2 === 0)) updateTerrain(positions);

  // bodies
  for (let i = 0; i < bodyVisuals.length; i++) {
    const bv = bodyVisuals[i], p = positions[i];
    const y = heightAt(level, p.x, p.z, positions);
    bv.group.position.set(p.x, y + bv.body.radius * 0.55, p.z);
    bv.group.rotation.y += bv.spin * dt;
    if (bv.discGroup) bv.discGroup.children[0].rotation.z += dt * 0.5;
    const pulse = bv.group.getObjectByName('pulse');
    if (pulse) pulse.scale.setScalar(1 + Math.sin(simTime * 3.2) * 0.06);
    const corona = bv.group.getObjectByName('corona');
    if (corona) corona.scale.setScalar(bv.body.radius * (5.2 + Math.sin(simTime * 1.7) * 0.5));
  }

  // hazards
  const hazPositions = hazardsAt(level, simTime);
  for (let i = 0; i < hazardVisuals.length; i++) {
    const hv = hazardVisuals[i], p = hazPositions[i];
    const y = heightAt(level, p.x, p.z, positions) + 1.6;
    hv.group.position.set(p.x, y, p.z);
    if (hv.prev) {
      const dx = p.x - hv.prev.x, dz = p.z - hv.prev.z;
      if (dx * dx + dz * dz > 1e-8) hv.group.rotation.y = Math.atan2(dx, dz);
      else hv.group.rotation.y += 0.5 * dt;
    }
    hv.prev = { x: p.x, z: p.z };
  }

  // pickups
  for (const pv of pickupVisuals) {
    const taken = pickupsDone.has(pv.index) || pickupsTemp.has(pv.index);
    pv.group.visible = !taken;
    if (!taken) {
      const y = heightAt(level, pv.pickup.x, pv.pickup.z, positions);
      pv.group.position.set(pv.pickup.x, y + 2.2 + Math.sin(simTime * 2 + pv.index) * 0.5, pv.pickup.z);
      pv.group.rotation.y += dt * 1.2;
    }
  }

  // waypoints
  for (const wv of waypointVisuals) {
    const y = heightAt(level, wv.wp.x, wv.wp.z, positions);
    wv.group.position.set(wv.wp.x, y + 0.5, wv.wp.z);
    const ring = wv.group.getObjectByName('ring');
    if (wv.index === stage) ring.scale.setScalar(1 + Math.sin(simTime * 2.6) * 0.07);
    const core = wv.group.getObjectByName('core');
    if (core) core.rotation.y += dt * 0.8;
  }

  // goal + pad
  const gy = goalY(positions);
  goalGroup.position.set(level.goal.x, gy + 0.5, level.goal.z);
  const gring = goalGroup.getObjectByName('pulse');
  if (gring && stage >= (level.waypoints || []).length) gring.scale.setScalar(1 + Math.sin(simTime * 2.6) * 0.07);
  padGroup.position.set(level.ship.x, heightAt(level, level.ship.x, level.ship.z, positions) + 0.4, level.ship.z);

  // ship
  if (shipGroup.visible) {
    const sy = shipY(positions);
    const bob = state === 'ready' || state === 'aiming' ? Math.sin(simTime * 2.2) * 0.35 : 0;
    shipGroup.position.set(ship.x, sy + bob, ship.z);
    if (state === 'flying' && (ship.vx || ship.vz)) {
      shipGroup.rotation.y = Math.atan2(ship.vx, ship.vz);
    } else if (state === 'ready' || state === 'aiming') {
      const tgt = activeTarget(level, stage);
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

  if (state === 'aiming' && (dynamic || level.hazards)) updatePrediction();

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

function shipY(positions) {
  return heightAt(level, ship.x, ship.z, positions || bodiesAt(level, simTime)) + 1.6;
}
function goalY(positions) {
  return heightAt(level, level.goal.x, level.goal.z, positions || bodiesAt(level, simTime));
}

function updateCamera(dt) {
  const E = level.extent;
  const inFlight = state === 'flying' || state === 'crashed' || state === 'won';
  const followX = inFlight ? ship.x * 0.25 : ship.x * 0.3;
  const followZ = inFlight ? ship.z * 0.15 : ship.z * 0.18;
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
        but big launches burn more fuel ⛽.<br>
        The terrain <i>is</i> gravity — dive into wells to speed up, ride ridges to coast.<br>
        <b>WASD / arrows</b> nudge mid-flight. Grab fuel cells, dodge patrol ships,<br>
        dock at stations 🛰 and haul cargo 📦 across the void.<br>
        <b>Pinch</b> or <b>scroll</b> to zoom, two-finger drag to pan.<br>
        <b>R</b> restart · <b>M</b> mute · fewer launches = more stars ⭐
      </p>
      <button id="btn-play" class="big">▶ Play</button>
    </div>`);
  document.getElementById('btn-play').addEventListener('click', () => {
    sfx.clickSound();
    hideOverlay();
    resetLevel();
    state = 'ready';
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
};

init();
