// GravityLoop — spaceship golf across gravity-well terrain.
import * as THREE from '../vendor/three.module.js';
import {
  STEP, PREDICT_T, OOB_FACTOR, bodiesAt, heightAt, checkState, stepShip, predict,
} from './physics.js';
import { LEVELS } from './levels.js';
import * as sfx from './audio.js';

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const GRID_N = 81;            // terrain vertices per side
const AIM_SCALE = 1.15;       // drag distance -> launch speed
const MIN_LAUNCH = 6;
const THRUST_ACCEL = 16;
const TRAIL_MAX = 260;
const PREDICT_MAX = 640;      // max prediction points uploaded to the GPU

const SAVE_KEY = 'gravityloop-save-v1';

let renderer, scene, camera;
let terrain;                  // { lines, gridX, gridZ, posAttr, colAttr }
let bodyVisuals = [];         // [{ group, body, spin }]
let shipGroup, engineSprite, trailLine, trailPts = [];
let predictLine, predictMarker;
let goalGroup, padGroup;
let fxList = [];

let level = null, levelIndex = 0;
let state = 'menu';           // menu | ready | aiming | flying | crashed | won
let simTime = 0;
let physAcc = 0;
let ship = { x: 0, z: 0, vx: 0, vz: 0 };
let fuel = 0, attempts = 0;
let aim = null;               // { sx, sz } drag start on the aim plane
let launchVel = { x: 0, z: 0 };
let keys = {};
let save = loadSave();
let lastFrame = performance.now();

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05010f);
  camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 1, 2500);

  addStars();
  buildShip();
  buildPredict();

  window.addEventListener('resize', onResize);
  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => { keys[e.code] = false; updateThrustSound(); });

  document.getElementById('btn-retry').addEventListener('click', () => { sfx.clickSound(); resetShip(true); });
  document.getElementById('btn-mute').addEventListener('click', toggleMute);

  buildLevelBar();
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
// Scene construction
// ---------------------------------------------------------------------------
function addStars() {
  const n = 1200;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(650 + Math.random() * 250);
    v.y = Math.abs(v.y) * (Math.random() < 0.25 ? -0.3 : 1); // mostly above horizon
    pos.set([v.x, v.y, v.z], i * 3);
    c.setHSL(0.55 + Math.random() * 0.15, 0.5, 0.55 + Math.random() * 0.4);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 1.7, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false });
  scene.add(new THREE.Points(g, m));
}

function glowTexture(inner = 'rgba(255,255,255,1)') {
  const s = 128, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}
const GLOW_TEX = glowTexture();

function makeGlow(color, scale) {
  const m = new THREE.SpriteMaterial({
    map: GLOW_TEX, color, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sp = new THREE.Sprite(m);
  sp.scale.setScalar(scale);
  return sp;
}

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
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N - 1; i++) index.push(j * N + i, j * N + i + 1);         // rows
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - 1; j++) index.push(j * N + i, (j + 1) * N + i);       // columns
  }
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
  // hills -> warning orange; flat -> dim indigo; wells -> cyan -> violet -> pink
  if (y > 0.4) {
    const t = Math.min(y / 12, 1);
    _c.setRGB(0.16 + 0.84 * t, 0.2 + 0.22 * t, 0.42 - 0.25 * t);
  } else {
    const d = -y;
    if (d < 7) {
      const t = d / 7;
      _c.setRGB(0.14 + 0.02 * t, 0.19 + 0.55 * t, 0.42 + 0.5 * t);      // indigo -> cyan
    } else if (d < 16) {
      const t = (d - 7) / 9;
      _c.setRGB(0.16 + 0.4 * t, 0.74 - 0.5 * t, 0.92 + 0.03 * t);       // cyan -> violet
    } else {
      const t = Math.min((d - 16) / 10, 1);
      _c.setRGB(0.56 + 0.44 * t, 0.24 - 0.06 * t, 0.95 - 0.37 * t);     // violet -> pink
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

function buildBodies() {
  for (const bv of bodyVisuals) scene.remove(bv.group);
  bodyVisuals = [];
  for (const body of level.bodies) {
    const group = new THREE.Group();
    let spin = 0;
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
      const disc = new THREE.Mesh(
        new THREE.RingGeometry(body.radius * 1.05, body.horizon * 1.9, 48),
        new THREE.MeshBasicMaterial({ color: 0x7a1c3f, transparent: true, opacity: 0.3, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      group.add(core, ring, disc, makeGlow(0xff3355, body.horizon * 4));
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
    } else {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius, 24, 18),
        new THREE.MeshBasicMaterial({ color: body.color }),
      );
      const wire = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 1.08, 12, 8),
        new THREE.MeshBasicMaterial({ color: body.color, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      group.add(sphere, wire, makeGlow(body.color, body.radius * 4.5));
      spin = 0.25;
    }
    scene.add(group);
    bodyVisuals.push({ group, body, spin });
  }
}

function buildGoal() {
  if (goalGroup) scene.remove(goalGroup);
  goalGroup = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(level.goal.r, 0.4, 10, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.name = 'pulse';
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(level.goal.r * 0.45, level.goal.r * 0.7, 46, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.07, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  beacon.position.y = 23;
  goalGroup.add(ring, beacon, makeGlow(0xffd166, level.goal.r * 4));
  scene.add(goalGroup);
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
  cone.rotation.x = Math.PI / 2;   // point along +z (group forward)
  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x35e0ff }),
  );
  cockpit.position.set(0, 0.4, 0.4);
  engineSprite = makeGlow(0x66d9ff, 4);
  engineSprite.position.z = -2.2;
  shipGroup.add(cone, cockpit, engineSprite, makeGlow(0xbfeaff, 6));
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
}

// ---------------------------------------------------------------------------
// Level flow
// ---------------------------------------------------------------------------
function loadLevel(i) {
  levelIndex = i;
  level = LEVELS[i];
  simTime = 0;
  attempts = 0;
  buildTerrain();
  buildBodies();
  buildGoal();
  buildPad();
  resetShip(false);
  document.getElementById('level-label').textContent = `${i + 1} · ${level.name}`;
  setHint(level.hint);
  buildLevelBar();
}

function resetShip(countsAsUI) {
  if (countsAsUI && state === 'menu') return;
  state = 'ready';
  ship = { x: level.ship.x, z: level.ship.z, vx: 0, vz: 0 };
  fuel = level.fuel;
  trailPts = [];
  trailLine.geometry.setDrawRange(0, 0);
  predictLine.visible = false;
  predictMarker.visible = false;
  aim = null;
  shipGroup.visible = true;
  sfx.stopThrust();
  updateFuelBar();
  updateAttempts();
  hidePower();
}

function launch(vx, vz) {
  ship.vx = vx; ship.vz = vz;
  state = 'flying';
  attempts++;
  updateAttempts();
  physAcc = 0;
  const p = Math.hypot(vx, vz) / level.maxLaunch;
  sfx.launchSound(p);
  predictLine.visible = false;
  predictMarker.visible = false;
  hidePower();
}

function onWin() {
  state = 'won';
  sfx.stopThrust();
  sfx.winSound();
  burst(level.goal.x, goalY() + 2, level.goal.z, 0xffd166, 90);
  const earned = attempts <= 1 ? 3 : attempts <= 3 ? 2 : 1;
  save.stars[levelIndex] = Math.max(save.stars[levelIndex] || 0, earned);
  save.unlocked = Math.max(save.unlocked, Math.min(levelIndex + 2, LEVELS.length));
  storeSave();
  buildLevelBar();
  setTimeout(() => showWin(earned), 900);
}

function onCrash(reason) {
  state = 'crashed';
  sfx.stopThrust();
  sfx.crashSound();
  const y = heightAt(level, ship.x, ship.z, bodiesAt(level, simTime)) + 1.6;
  burst(ship.x, y, ship.z, 0xff7b54, 80);
  shipGroup.visible = false;
  toast(reason);
  setTimeout(() => { if (state === 'crashed') resetShip(false); }, 1400);
}

function failOOB() {
  state = 'crashed';
  sfx.stopThrust();
  toast('🌌 Lost in deep space…');
  setTimeout(() => { if (state === 'crashed') resetShip(false); }, 1100);
}

function crashMessage(bodyIdx) {
  const b = level.bodies[bodyIdx];
  if (b.type === 'blackhole') return `🕳️ Swallowed by ${b.name}! Nothing escapes the red ring.`;
  if (b.mass < 0) return `💥 Smacked into ${b.name}!`;
  return `💥 Crashed into ${b.name}!`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
function pointerToWorld(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
  _ray.setFromCamera({ x: nx, y: ny }, camera);
  _plane.constant = -shipY();
  return _ray.ray.intersectPlane(_plane, _hit) ? { x: _hit.x, z: _hit.z } : null;
}

function onPointerDown(e) {
  if (state !== 'ready') return;
  const p = pointerToWorld(e);
  if (!p) return;
  aim = { sx: p.x, sz: p.z };
  state = 'aiming';
  updateAim(e);
}

function onPointerMove(e) {
  if (state === 'aiming') updateAim(e);
}

function onPointerUp(e) {
  if (state !== 'aiming') return;
  updateAim(e);
  const v = Math.hypot(launchVel.x, launchVel.z);
  if (v >= MIN_LAUNCH) {
    launch(launchVel.x, launchVel.z);
  } else {
    state = 'ready';
    predictLine.visible = false;
    predictMarker.visible = false;
    hidePower();
  }
  aim = null;
}

function updateAim(e) {
  const p = pointerToWorld(e);
  if (!p) return;
  let vx = (aim.sx - p.x) * AIM_SCALE;
  let vz = (aim.sz - p.z) * AIM_SCALE;
  const sp = Math.hypot(vx, vz);
  if (sp > level.maxLaunch) {
    vx *= level.maxLaunch / sp;
    vz *= level.maxLaunch / sp;
  }
  launchVel = { x: vx, z: vz };
  showPower(Math.min(sp / level.maxLaunch, 1));
  updatePrediction();
}

function updatePrediction() {
  const v = Math.hypot(launchVel.x, launchVel.z);
  if (v < MIN_LAUNCH) { predictLine.visible = false; predictMarker.visible = false; return; }
  const r = predict(level, ship.x, ship.z, launchVel.x, launchVel.z, simTime, PREDICT_T);
  const positions = bodiesAt(level, simTime);
  const attr = predictLine.geometry.getAttribute('position');
  const n = Math.min(r.points.length, PREDICT_MAX);
  for (let i = 0; i < n; i++) {
    const pt = r.points[i];
    attr.array[i * 3] = pt.x;
    attr.array[i * 3 + 1] = heightAt(level, pt.x, pt.z, positions) + 1.3;
    attr.array[i * 3 + 2] = pt.z;
  }
  attr.needsUpdate = true;
  predictLine.geometry.setDrawRange(0, n);
  const color = r.outcome === 'goal' ? 0x7cff6b : r.outcome === 'crash' ? 0xff5d5d : r.outcome === 'oob' ? 0x8a8fa3 : 0x9bd5ff;
  predictLine.material.color.setHex(color);
  predictLine.visible = true;
  if (r.outcome === 'goal' || r.outcome === 'crash') {
    const last = r.points[r.points.length - 1];
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
  if (e.code === 'KeyR') { sfx.clickSound(); if (state !== 'menu') resetShip(true); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Escape' && state === 'aiming') {
    state = 'ready'; aim = null;
    predictLine.visible = false; predictMarker.visible = false; hidePower();
  }
  if (e.code === 'KeyN' && state === 'won') nextLevel();
}

function thrustVector() {
  if (state !== 'flying' || fuel <= 0) return null;
  let tx = 0, tz = 0;
  if (keys.ArrowUp || keys.KeyW) tz -= 1;
  if (keys.ArrowDown || keys.KeyS) tz += 1;
  if (keys.ArrowLeft || keys.KeyA) tx -= 1;
  if (keys.ArrowRight || keys.KeyD) tx += 1;
  if (!tx && !tz) return null;
  const inv = THRUST_ACCEL / Math.hypot(tx, tz);
  return { x: tx * inv, z: tz * inv };
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
    const v = new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 18);
    vel.push(v);
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
      const positions = stepShip(level, ship, simTime - physAcc, STEP, thrust);
      const st = checkState(level, ship.x, ship.z, positions);
      if (st) {
        if (st.type === 'goal') onWin();
        else if (st.type === 'crash') onCrash(crashMessage(st.body));
        else failOOB();
      }
    }
  }

  const positions = bodiesAt(level, simTime);
  if (dynamic) updateTerrain(positions);

  // bodies
  for (let i = 0; i < bodyVisuals.length; i++) {
    const bv = bodyVisuals[i], p = positions[i];
    const y = heightAt(level, p.x, p.z, positions);
    bv.group.position.set(p.x, y + bv.body.radius * 0.55, p.z);
    bv.group.rotation.y += bv.spin * dt;
    const pulse = bv.group.getObjectByName('pulse');
    if (pulse) pulse.scale.setScalar(1 + Math.sin(simTime * 3.2) * 0.06);
  }

  // goal + pad
  const gy = goalY(positions);
  goalGroup.position.set(level.goal.x, gy + 0.5, level.goal.z);
  const gring = goalGroup.getObjectByName('pulse');
  if (gring) gring.scale.setScalar(1 + Math.sin(simTime * 2.6) * 0.07);
  padGroup.position.set(level.ship.x, heightAt(level, level.ship.x, level.ship.z, positions) + 0.4, level.ship.z);

  // ship
  if (shipGroup.visible) {
    const sy = shipY(positions);
    const bob = state === 'ready' || state === 'aiming' ? Math.sin(simTime * 2.2) * 0.35 : 0;
    shipGroup.position.set(ship.x, sy + bob, ship.z);
    if (state === 'flying' && (ship.vx || ship.vz)) {
      shipGroup.rotation.y = Math.atan2(ship.vx, ship.vz);
    } else if (state === 'ready' || state === 'aiming') {
      const dir = state === 'aiming' && Math.hypot(launchVel.x, launchVel.z) > 2
        ? launchVel : { x: level.goal.x - ship.x, z: level.goal.z - ship.z };
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

  // live prediction re-sim while aiming (bodies keep moving)
  if (state === 'aiming' && dynamic) updatePrediction();

  updateFx(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}

function shipY(positions) {
  return heightAt(level, ship.x, ship.z, positions || bodiesAt(level, simTime)) + 1.6;
}
function goalY(positions) {
  return heightAt(level, level.goal.x, level.goal.z, positions || bodiesAt(level, simTime));
}

function updateCamera(dt) {
  const E = level.extent;
  const followX = state === 'flying' ? ship.x * 0.25 : 0;
  const followZ = state === 'flying' ? ship.z * 0.15 : 0;
  const target = new THREE.Vector3(followX * 0.4, -4, followZ * 0.4);
  const desired = new THREE.Vector3(followX, E * 1.02, E * 1.52 + followZ);
  const k = Math.min(dt * 2.5, 1);
  camera.position.lerp(desired, k);
  camera.lookAt(target);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function setHint(text) {
  document.getElementById('hint').textContent = text;
}
function showPower(frac) {
  const el = document.getElementById('power');
  el.hidden = false;
  el.textContent = `⚡ Power ${Math.round(frac * 100)}%`;
}
function hidePower() { document.getElementById('power').hidden = true; }
function updateFuelBar() {
  document.getElementById('fuel-fill').style.width = `${(fuel / level.fuel) * 100}%`;
}
function updateAttempts() {
  document.getElementById('attempts').textContent = `🚀 ${attempts}`;
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
  const bar = document.getElementById('levels-bar');
  bar.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const b = document.createElement('button');
    const unlocked = i < save.unlocked;
    b.className = 'level-dot' + (i === levelIndex ? ' current' : '') + (unlocked ? '' : ' locked');
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
  });
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
        <b>Drag back</b> from your ship and release to launch.<br>
        The terrain <i>is</i> gravity — dive into wells to speed up, ride ridges to save fuel.<br>
        <b>WASD / arrows</b> give tiny mid-flight nudges (limited fuel ⛽).<br>
        <b>R</b> restart · <b>M</b> mute · fewer attempts = more stars ⭐
      </p>
      <button id="btn-play" class="big">▶ Play</button>
    </div>`);
  document.getElementById('btn-play').addEventListener('click', () => {
    sfx.clickSound();
    hideOverlay();
    state = 'ready';
    resetShip(false);
    toast(level.hint);
  });
}

function showWin(earned) {
  const last = levelIndex === LEVELS.length - 1;
  const starStr = '★'.repeat(earned) + '☆'.repeat(3 - earned);
  const msg = attempts <= 1 ? 'Hole in one! 🏌️' : attempts <= 3 ? 'Smooth flying!' : 'Made it!';
  showOverlay(`
    <div class="panel">
      <h2>${msg}</h2>
      <div class="stars">${starStr}</div>
      <p class="tagline">${level.name} cleared in ${attempts} launch${attempts === 1 ? '' : 'es'}</p>
      ${last
        ? '<p class="howto">🏆 That was the Grand Tour — you\'ve mastered the gravity wells!<br>Replay any level from the bar below to hunt three stars.</p>'
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
  toast(level.hint);
}

init();
