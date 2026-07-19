// GravityLoop — level generator.
// Samples themed levels with a seeded RNG, keeps only candidates whose every
// leg the brute-force solver confirms is winnable inside the set's difficulty
// band, then writes the full 50-level roster (originals + generated) to
// src/levels.js.
//
//   node tools/generate.js
//
// Deterministic: same seeds -> same levels.
//
// Mechanics are introduced gradually by slot within each set:
//   set 1: gravity + fuel cells          set 2: + derelict/patrol ships
//   set 3: + station docking (2 legs)    set 4: + cargo hauling (3 legs)
//   set 5: everything, in solar systems
import { predict, legStart, legCount } from '../src/physics.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, a, b) => a + rng() * (b - a);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const sign = rng => (rng() < 0.5 ? -1 : 1);
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// ---------------------------------------------------------------------------
// Coarse per-leg solver (same grid CI uses via `solve.js --fast`)
// ---------------------------------------------------------------------------
function isDynamic(level) {
  return level.bodies.some(b => b.orbit) ||
    (level.hazards || []).some(h => h.orbit || h.patrol);
}

function solveLeg(level, stage) {
  const dynamic = isDynamic(level);
  const times = dynamic ? Array.from({ length: 11 }, (_, i) => i * 0.9) : [0];
  const start = legStart(level, stage);
  let wins = 0, total = 0;
  const byT0 = dynamic ? new Array(times.length).fill(0) : null;
  const winners = [];
  for (let ti = 0; ti < times.length; ti++) {
    const t0 = times[ti];
    for (let ang = 0; ang < 360; ang += 3) {
      const rad = (ang * Math.PI) / 180;
      for (let sp = 10; sp <= level.maxLaunch; sp += 4) {
        total++;
        const r = predict(level, start.x, start.z,
          Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 10, stage);
        if (r.outcome === 'goal' || r.outcome === 'waypoint') {
          wins++;
          if (byT0) byT0[ti]++;
          if (winners.length < 40) winners.push({ ang, sp, t0 });
        }
      }
    }
  }
  return { wins, rate: (wins / total) * 100, byT0, winners };
}

// Gravity-assist timing sensitivity: how much of the leg's wins concentrate
// in the best 4 of 11 launch-time buckets (0.36 = timing-insensitive).
function concentration(byT0) {
  const total = byT0.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const sorted = [...byT0].sort((a, b) => b - a);
  return (sorted[0] + sorted[1] + sorted[2] + sorted[3]) / total;
}

// Per-leg verdict for a candidate: every leg in band, legs of comparable
// difficulty, and (when required) timing-window sensitivity on the first
// launch. Aborts early once a candidate cannot beat the best found so far.
function evaluate(set, needsTiming, level, bestDist = Infinity) {
  const legs = legCount(level);
  // per-leg hops are intrinsically shorter/easier, so multi-leg levels get a
  // wider per-leg ceiling; balance and timing terms below keep them honest
  const low = set.band[0], high = set.band[1] * (legs > 1 ? 2.2 : 1);
  const rates = [], winners = [];
  let dist = 0, minWins = Infinity, conc = 0;
  for (let s = 0; s < legs; s++) {
    const r = solveLeg(level, s);
    minWins = Math.min(minWins, r.wins);
    if (r.wins < MIN_WINS) return { minWins, rates, dist: Infinity, conc, legs, winners };
    rates.push(r.rate);
    winners.push(r.winners);
    if (r.rate < low) dist += low - r.rate;
    else if (r.rate > high) dist += r.rate - high;
    if (s === 0 && needsTiming) {
      conc = r.byT0 ? concentration(r.byT0) : 0;
      if (conc < 0.5) dist += (0.5 - conc) * 6;      // demand launch windows
    }
    if (dist >= bestDist) return { minWins, rates, dist, conc, legs, winners };
  }
  if (legs > 1) {
    const ratio = Math.max(...rates) / Math.max(Math.min(...rates), 1e-9);
    if (ratio > 2.5) dist += ratio - 2.5;            // legs must be comparable
  }
  return { minWins, rates, dist, conc, legs, winners };
}

// ---------------------------------------------------------------------------
// Geometry helpers. A moving body's possible positions form an annulus
// (ring band) around its root center — clearance is distance to the band.
// ---------------------------------------------------------------------------
function annulus(level, i) {
  const b = level.bodies[i];
  if (!b.orbit) return { x: b.x, z: b.z, minR: 0, maxR: 0 };
  const o = b.orbit;
  if (o.parent != null) {
    const p = annulus(level, o.parent);
    return { x: p.x, z: p.z, minR: Math.max(0, p.minR - o.radius), maxR: p.maxR + o.radius };
  }
  return { x: o.cx || 0, z: o.cz || 0, minR: o.radius, maxR: o.radius };
}

function pointToAnnulus(a, x, z) {
  const d = dist(a.x, a.z, x, z);
  return d < a.minR ? a.minR - d : d > a.maxR ? d - a.maxR : 0;
}

function annulusGap(a, b) {
  const d = dist(a.x, a.z, b.x, b.z);
  return Math.max(0, d - a.maxR - b.maxR, a.minR - d - b.maxR, b.minR - d - a.maxR);
}

// clearance of a point from every body (bodies only, not hazards)
function bodyClearance(level, x, z) {
  let min = Infinity;
  for (let i = 0; i < level.bodies.length; i++) {
    const a = annulus(level, i);
    min = Math.min(min, pointToAnnulus(a, x, z) - level.bodies[i].radius);
  }
  return min;
}

// key points a level must keep clear: pad, goal, waypoints
function keyPoints(level) {
  return [
    { x: level.ship.x, z: level.ship.z },
    { x: level.goal.x, z: level.goal.z },
    ...(level.waypoints || []),
  ];
}

function levelGeometryOk(level, padClear, goalClear) {
  const E = level.extent;
  for (let i = 0; i < level.bodies.length; i++) {
    const bi = level.bodies[i];
    const a = annulus(level, i);
    const moving = !!bi.orbit;
    if (Math.hypot(a.x, a.z) + a.maxR + bi.radius > E * 0.92) return false;
    const padM = moving ? Math.min(padClear, 10) : padClear;
    const goalM = moving ? Math.min(goalClear, 8) : goalClear;
    if (pointToAnnulus(a, level.ship.x, level.ship.z) < bi.radius + padM) return false;
    if (pointToAnnulus(a, level.goal.x, level.goal.z) < bi.radius + goalM) return false;
    for (const wp of level.waypoints || []) {
      if (pointToAnnulus(a, wp.x, wp.z) < bi.radius + (moving ? 8 : 10)) return false;
    }
    for (let j = i + 1; j < level.bodies.length; j++) {
      const bj = level.bodies[j];
      const oi = bi.orbit, oj = bj.orbit;
      if ((oj && oj.parent === i) || (oi && oi.parent === j)) continue;
      if (oi && oj && oi.parent == null && oj.parent == null &&
          (oi.cx || 0) === (oj.cx || 0) && (oi.cz || 0) === (oj.cz || 0) && oi.omega === oj.omega) {
        continue;
      }
      if (annulusGap(a, annulus(level, j)) < bi.radius + bj.radius + 6) return false;
    }
  }
  // waypoints: apart from each other and from pad/goal
  const sep = level.extent >= 66 ? 20 : 26;
  const kps = keyPoints(level);
  for (let i = 0; i < kps.length; i++) {
    for (let j = i + 1; j < kps.length; j++) {
      if (dist(kps[i].x, kps[i].z, kps[j].x, kps[j].z) < sep) return false;
    }
  }
  return true;
}

// hazard motion envelope for clearance checks
function hazardPoints(h) {
  if (h.orbit) return null; // handled as annulus
  if (h.patrol) {
    const p = h.patrol, out = [];
    for (let k = 0; k <= 4; k++) out.push({ x: p.x1 + (p.x2 - p.x1) * (k / 4), z: p.z1 + (p.z2 - p.z1) * (k / 4) });
    return out;
  }
  return [{ x: h.x, z: h.z }];
}

function hazardOk(level, h) {
  const E = level.extent;
  const clear = (x, z) => {
    if (Math.hypot(x, z) > E * 0.88) return false;
    if (bodyClearance(level, x, z) < h.radius + 3) return false;
    for (const kp of keyPoints(level)) {
      if (dist(x, z, kp.x, kp.z) < 12) return false;
    }
    return true;
  };
  if (h.orbit) {
    const o = h.orbit;
    if (Math.hypot(o.cx, o.cz) + o.radius > E * 0.88) return false;
    const ann = { x: o.cx, z: o.cz, minR: o.radius, maxR: o.radius };
    for (const kp of keyPoints(level)) {
      if (pointToAnnulus(ann, kp.x, kp.z) < h.radius + 10) return false;
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (bodyClearance(level, o.cx + Math.cos(a) * o.radius, o.cz + Math.sin(a) * o.radius) < h.radius + 2) return false;
    }
    return true;
  }
  return hazardPoints(h).every(p => clear(p.x, p.z));
}

function pickupOk(level, x, z) {
  const E = level.extent;
  if (Math.hypot(x, z) > E * 0.85) return false;
  if (bodyClearance(level, x, z) < 4) return false;
  for (const kp of keyPoints(level)) {
    if (dist(x, z, kp.x, kp.z) < 9) return false;
  }
  for (const other of level.pickups || []) {
    if (dist(x, z, other.x, other.z) < 9) return false;
  }
  for (const h of level.hazards || []) {
    for (const p of hazardPoints(h) || [{ x: h.orbit.cx, z: h.orbit.cz }]) {
      if (dist(x, z, p.x, p.z) < 7) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mechanic add-ons
// ---------------------------------------------------------------------------
// Fuel cells placed just off solver-found winning trajectories, so grabbing
// one is a deliberate small detour a player can plan for.
function placePickupsOnPaths(rng, level, winnersByLeg, count) {
  level.pickups = [];
  const legsWithWins = winnersByLeg.map((w, i) => (w.length ? i : -1)).filter(i => i >= 0);
  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 25; tries++) {
      const leg = legsWithWins[(i + tries) % legsWithWins.length];
      const w = pick(rng, winnersByLeg[leg]);
      const start = legStart(level, leg);
      const rad = (w.ang * Math.PI) / 180;
      const r = predict(level, start.x, start.z, Math.cos(rad) * w.sp, Math.sin(rad) * w.sp, w.t0, 12, leg);
      const pt = r.points[Math.floor(r.points.length * rand(rng, 0.35, 0.68))];
      const x = Math.round(pt.x + rand(rng, -4, 4));
      const z = Math.round(pt.z + rand(rng, -4, 4));
      if (pickupOk(level, x, z)) {
        level.pickups.push({ x, z, fuel: 1.5 });
        break;
      }
    }
  }
  if (!level.pickups.length) delete level.pickups;
}

// Static planet with an orbiting moon (moons orbit planets, planets orbit
// stars — this is the planet-moon tier).
function addMoonTo(rng, lv, name, parentIdx) {
  const parent = lv.bodies[parentIdx];
  const orbR = +rand(rng, parent.radius + 7, parent.radius + 13).toFixed(1);
  lv.bodies.push({
    name: name(BODY_NAMES), mass: Math.round(rand(rng, 250, 500)),
    radius: +rand(rng, 2, 3).toFixed(1), color: 0xe2e2e2,
    orbit: { parent: parentIdx, radius: orbR, omega: +(sign(rng) * rand(rng, 0.5, 1)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
  });
}

function addDerelict(rng, level) {
  for (let tries = 0; tries < 30; tries++) {
    const h = {
      radius: 2,
      x: Math.round(rand(rng, -0.6, 0.6) * level.extent),
      z: Math.round(rand(rng, -0.5, 0.5) * level.extent),
    };
    if (hazardOk(level, h)) {
      (level.hazards = level.hazards || []).push(h);
      return;
    }
  }
}

function addPatrol(rng, level) {
  for (let tries = 0; tries < 30; tries++) {
    if (rng() < 0.5) {
      const h = {
        radius: 2,
        orbit: {
          cx: Math.round(rand(rng, -0.3, 0.3) * level.extent),
          cz: Math.round(rand(rng, -0.3, 0.3) * level.extent),
          radius: +rand(rng, 10, 20).toFixed(1),
          omega: +(sign(rng) * rand(rng, 0.35, 0.7)).toFixed(2),
          phase: +rand(rng, 0, 6.28).toFixed(2),
        },
      };
      if (hazardOk(level, h)) { (level.hazards = level.hazards || []).push(h); return; }
    } else {
      const x1 = Math.round(rand(rng, -0.6, 0.6) * level.extent);
      const z1 = Math.round(rand(rng, -0.4, 0.4) * level.extent);
      const h = {
        radius: 2,
        patrol: {
          x1, z1,
          x2: Math.round(x1 + rand(rng, -0.35, 0.35) * level.extent),
          z2: Math.round(z1 + rand(rng, -0.35, 0.35) * level.extent),
          period: +rand(rng, 4, 8).toFixed(1),
          phase: +rand(rng, 0, 1).toFixed(2),
        },
      };
      if (dist(h.patrol.x1, h.patrol.z1, h.patrol.x2, h.patrol.z2) > 14 && hazardOk(level, h)) {
        (level.hazards = level.hazards || []).push(h);
        return;
      }
    }
  }
}

// Waypoints along the route: fractions of the pad->goal line with lateral jitter.
function addWaypoints(rng, level, specs) {
  const wps = [];
  for (const spec of specs) {
    let placed = false;
    for (let tries = 0; tries < 80 && !placed; tries++) {
      const t = spec.t + rand(rng, -0.08, 0.08);
      const x = Math.round(level.ship.x + (level.goal.x - level.ship.x) * t + rand(rng, -0.32, 0.32) * level.extent);
      const z = Math.round(level.ship.z + (level.goal.z - level.ship.z) * t + rand(rng, -0.14, 0.14) * level.extent);
      if (Math.hypot(x, z) > level.extent * 0.82) continue;
      const cand = { x, z, r: spec.r, type: spec.type };
      const test = { ...level, waypoints: [...wps, cand] };
      if (levelGeometryOk(test, 14, 11)) {
        wps.push(cand);
        placed = true;
      }
    }
    if (!placed) return false;
  }
  level.waypoints = wps;
  return true;
}

// ---------------------------------------------------------------------------
// Flavour
// ---------------------------------------------------------------------------
const BODY_NAMES = ['Pebble', 'Mint', 'Coral', 'Sage', 'Ember', 'Nimbus', 'Juno', 'Vesta', 'Lyra', 'Atlas',
  'Rhea', 'Iris', 'Quartz', 'Basil', 'Echo', 'Fern', 'Opal', 'Dune', 'Frost', 'Halo',
  'Jasper', 'Koa', 'Lumen', 'Mica', 'Nova', 'Onyx', 'Pip', 'Zephyr', 'Cinder', 'Willow'];
const PLANET_COLORS = [0x8ecae6, 0x7ae582, 0xff8fa3, 0xffd166, 0xf4a261, 0x90e0ef, 0xbde0fe, 0xc8b6ff, 0xffc8dd, 0x95d5b2];
const SUN_COLORS = [0xffd166, 0xffb703, 0xff9e6b];
const REPULSOR_NAMES = ['Nope', 'Shove', 'Pusher', 'Grudge', 'Bristle', 'Static'];
const HOLE_NAMES = ['Maw', 'Gulp', 'Void', 'Abyss', 'Hush'];

function namer(rng) {
  const used = new Set();
  return pool => {
    for (let k = 0; k < 20; k++) {
      const n = pick(rng, pool);
      if (!used.has(n)) { used.add(n); return n; }
    }
    return pick(rng, pool) + ' II';
  };
}

// ---------------------------------------------------------------------------
// Theme samplers — sample(rng, slot) returns a candidate level or null
// ---------------------------------------------------------------------------
function padAndGoal(rng, E, goalR) {
  return {
    ship: { x: Math.round(rand(rng, -0.5, 0.5) * E * 0.9), z: Math.round(E * 0.72) },
    goal: { x: Math.round(rand(rng, -0.55, 0.55) * E * 0.9), z: Math.round(-E * 0.73), r: +goalR.toFixed(1) },
  };
}

function addPlanet(rng, lv, name, massLo, massHi, rLo, rHi) {
  lv.bodies.push({
    name, mass: Math.round(rand(rng, massLo, massHi)),
    radius: +rand(rng, rLo, rHi).toFixed(1), color: pick(rng, PLANET_COLORS),
    x: Math.round(rand(rng, -0.75, 0.75) * lv.extent), z: Math.round(rand(rng, -0.58, 0.58) * lv.extent),
  });
}

function sampleSet1(rng, slot) {
  const E = 58;
  const lv = { extent: E, ...padAndGoal(rng, E, 6.3 - slot * 0.13), maxLaunch: Math.round(rand(rng, 48, 52)), fuel: 3, bodies: [] };
  const name = namer(rng);
  const n = 2 + (slot >= 5 && rng() < 0.6 ? 1 : 0);
  for (let i = 0; i < n; i++) addPlanet(rng, lv, name(BODY_NAMES), 400, 1350, 3, 5);
  return levelGeometryOk(lv, 17, 15) ? lv : null;
}

function sampleSet2(rng, slot) {
  const E = 60;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.9, 5.5)), maxLaunch: Math.round(rand(rng, 46, 50)), fuel: 3, bodies: [] };
  const name = namer(rng);
  const mx = (lv.ship.x + lv.goal.x) / 2, mz = (lv.ship.z + lv.goal.z) / 2;
  lv.bodies.push({
    name: name(BODY_NAMES), mass: Math.round(rand(rng, 1600, 2400)),
    radius: +rand(rng, 6, 7.5).toFixed(1), color: pick(rng, PLANET_COLORS),
    x: Math.round(mx + rand(rng, -10, 10)), z: Math.round(mz + rand(rng, -12, 12)),
  });
  const extra = 2 + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < extra; i++) addPlanet(rng, lv, name(BODY_NAMES), 600, 1500, 3.5, 5.5);
  if (slot >= 4 && rng() < 0.3) addMoonTo(rng, lv, name, 0);
  if (!levelGeometryOk(lv, 15, 13)) return null;
  if (slot >= 2) for (let i = 0; i < 1 + (slot >= 4 ? 1 : 0); i++) addDerelict(rng, lv);
  if (slot >= 6) addPatrol(rng, lv);
  return lv;
}

function sampleSet3(rng, slot) {
  const E = 62;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.6, 5.4)), maxLaunch: Math.round(rand(rng, 44, 49)), fuel: 3.5, bodies: [] };
  const name = namer(rng);
  const nRep = rng() < 0.45 ? 2 : 1;
  for (let i = 0; i < nRep; i++) {
    const mx = (lv.ship.x + lv.goal.x) / 2, mz = (lv.ship.z + lv.goal.z) / 2;
    lv.bodies.push({
      name: name(REPULSOR_NAMES), mass: -Math.round(rand(rng, 900, 1800)),
      radius: +rand(rng, 4, 5).toFixed(1), color: 0xff6b35,
      x: Math.round(mx + rand(rng, -0.35, 0.35) * E), z: Math.round(mz + rand(rng, -0.35, 0.35) * E),
    });
  }
  const planetStart = lv.bodies.length;
  const nPl = 2 + (rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < nPl; i++) addPlanet(rng, lv, name(BODY_NAMES), 700, 1600, 3.5, 5.5);
  if (rng() < 0.35) addMoonTo(rng, lv, name, planetStart);
  if (!levelGeometryOk(lv, 15, 12)) return null;
  if (slot >= 4 && !addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  if (slot >= 2 && rng() < 0.7) addDerelict(rng, lv);
  if (slot >= 6) addPatrol(rng, lv);
  return lv;
}

function sampleSet4(rng, slot) {
  const E = 64;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.8, 5.2)), maxLaunch: Math.round(rand(rng, 42, 48)), fuel: 4, bodies: [] };
  const name = namer(rng);
  if (rng() < 0.35) {
    const cx = Math.round(rand(rng, -0.2, 0.2) * E), cz = Math.round(rand(rng, -0.25, 0.15) * E);
    const r = +rand(rng, 10, 15).toFixed(1), om = +(sign(rng) * rand(rng, 0.3, 0.55)).toFixed(2);
    const ph = +rand(rng, 0, Math.PI * 2).toFixed(2);
    for (let i = 0; i < 2; i++) {
      lv.bodies.push({
        name: name(BODY_NAMES), mass: Math.round(rand(rng, 1000, 1400)),
        radius: +rand(rng, 4.5, 5.5).toFixed(1), color: pick(rng, PLANET_COLORS),
        orbit: { cx, cz, radius: r, omega: om, phase: +(ph + i * Math.PI).toFixed(2) },
      });
    }
  } else {
    const planet = {
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 1800, 2600)),
      radius: +rand(rng, 6.5, 7.5).toFixed(1), color: pick(rng, PLANET_COLORS),
      x: Math.round(rand(rng, -0.25, 0.25) * E), z: Math.round(rand(rng, -0.3, 0.15) * E),
    };
    lv.bodies.push(planet);
    const nMoons = rng() < 0.3 ? 2 : 1;
    let lastR = planet.radius + 6;
    for (let i = 0; i < nMoons; i++) {
      const orbR = +rand(rng, lastR + 6, lastR + 12).toFixed(1);
      lastR = orbR;
      lv.bodies.push({
        name: name(BODY_NAMES), mass: Math.round(rand(rng, 350, 650)),
        radius: +rand(rng, 2.5, 3.5).toFixed(1), color: 0xe2e2e2,
        orbit: { parent: 0, radius: orbR, omega: +(sign(rng) * rand(rng, 0.45, 0.9)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
      });
    }
  }
  addPlanet(rng, lv, name(BODY_NAMES), 600, 1300, 3.5, 5);
  if (rng() < 0.4) addPlanet(rng, lv, name(BODY_NAMES), 500, 1000, 3, 4.5);
  if (!levelGeometryOk(lv, 14, 11)) return null;
  if (slot >= 3) {
    if (!addWaypoints(rng, lv, [{ t: 0.35, r: 4.5, type: 'cargo' }, { t: 0.7, r: 4.5, type: 'dropoff' }])) return null;
  } else if (slot >= 1 && rng() < 0.5) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  }
  if (slot >= 5) addPatrol(rng, lv);
  return lv;
}

function sampleSet5(rng, slot) {
  const E = Math.round(rand(rng, 66, 74));
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.2, 4.6)), maxLaunch: Math.round(rand(rng, 38, 46)), fuel: 5, bodies: [] };
  const name = namer(rng);
  const sx = Math.round(rand(rng, -0.12, 0.12) * E), sz = Math.round(rand(rng, -0.18, 0.08) * E);
  lv.bodies.push({
    name: pick(rng, ['Sol', 'Helios', 'Aurum', 'Tsuki', 'Vera']), mass: Math.round(rand(rng, 2600, 3800)),
    radius: +rand(rng, 8, 9.5).toFixed(1), color: pick(rng, SUN_COLORS), x: sx, z: sz, type: 'sun',
  });
  const nPl = 2 + (rng() < 0.6 ? 1 : 0);
  let orbR = Math.max(21, rand(rng, 0.26, 0.3) * E);
  for (let i = 0; i < nPl; i++) {
    if (orbR > E * 0.62) break;
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 500, 1100)),
      radius: +rand(rng, 3.5, 5).toFixed(1), color: pick(rng, PLANET_COLORS),
      orbit: { cx: sx, cz: sz, radius: +orbR.toFixed(1), omega: +(sign(rng) * rand(rng, 0.22, 0.55)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    orbR += Math.max(17, rand(rng, 0.16, 0.2) * E);
  }
  // moons orbit the planets (up to two, on distinct planets)
  const planetIdxs = lv.bodies.map((b, i) => (b.orbit && b.orbit.parent == null ? i : -1)).filter(i => i > 0);
  let moons = 0;
  for (const pIdx of planetIdxs) {
    if (moons >= 2 || rng() >= 0.45) continue;
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 180, 320)),
      radius: +rand(rng, 2, 2.5).toFixed(1), color: 0xe2e2e2,
      orbit: { parent: pIdx, radius: +rand(rng, 8, 11).toFixed(1), omega: +(sign(rng) * rand(rng, 0.8, 1.2)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    moons++;
  }
  if (rng() < 0.45) {
    const ang = rand(rng, 0, Math.PI * 2);
    const d = orbR + rand(rng, 12, 20);
    lv.bodies.push({
      name: name(HOLE_NAMES), mass: Math.round(rand(rng, 3500, 4800)),
      radius: 3, horizon: +rand(rng, 5.5, 6.5).toFixed(1), color: 0x1a1a2e, type: 'blackhole',
      x: Math.round(sx + Math.cos(ang) * d), z: Math.round(sz + Math.sin(ang) * d),
    });
  }
  if (rng() < 0.3) {
    lv.bodies.push({
      name: name(REPULSOR_NAMES), mass: -Math.round(rand(rng, 1000, 1600)),
      radius: +rand(rng, 4, 5).toFixed(1), color: 0xff6b35,
      x: Math.round(rand(rng, -0.7, 0.7) * E), z: Math.round(rand(rng, -0.5, 0.5) * E),
    });
  }
  if (!levelGeometryOk(lv, 14, 11)) return null;
  if (slot >= 5) {
    if (!addWaypoints(rng, lv, [{ t: 0.3, r: 3.6, type: 'cargo' }, { t: 0.7, r: 3.6, type: 'dropoff' }])) return null;
  } else if (slot >= 2 && rng() < 0.7) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4, type: 'station' }])) return null;
  }
  if (slot >= 3) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Sets: themes, difficulty bands (coarse min-leg win %), fixed original slots
// ---------------------------------------------------------------------------
const ORIGINALS = {
  liftoff: { name: 'Liftoff', hint: 'Drag back from your ship to aim — like a slingshot — then release to launch!', extent: 60, ship: { x: 0, z: 42 }, goal: { x: 0, z: -40, r: 7 }, maxLaunch: 50, fuel: 3, bodies: [{ name: 'Pebble', mass: 260, radius: 3, color: 0x8ecae6, x: -34, z: -4 }] },
  thedip: { name: 'The Dip', hint: 'That well will bend your shot. Watch the prediction line and aim off-center.', extent: 60, ship: { x: 0, z: 42 }, goal: { x: 0, z: -42, r: 5.5 }, maxLaunch: 50, fuel: 3, bodies: [{ name: 'Mint', mass: 1300, radius: 5, color: 0x7ae582, x: 15, z: 0 }] },
  slingshot: { name: 'Slingshot', hint: 'No way through — so curve around. Dive into the well and let it fling you!', extent: 60, ship: { x: 0, z: 44 }, goal: { x: 0, z: -44, r: 5 }, maxLaunch: 48, fuel: 3, bodies: [{ name: 'Rusty', mass: 2100, radius: 7, color: 0xff8fa3, x: 0, z: -2 }] },
  saddle: { name: 'The Saddle', hint: 'Two wells, one ridge between them. Thread the saddle — or swing wide.', extent: 62, ship: { x: -10, z: 44 }, goal: { x: 4, z: -44, r: 4.5 }, maxLaunch: 48, fuel: 3, bodies: [{ name: 'Castor', mass: 1500, radius: 6, color: 0xffd166, x: -16, z: 0 }, { name: 'Pollux', mass: 1500, radius: 6, color: 0xf4a261, x: 16, z: 0 }] },
  repulsor: { name: 'Repulsor Ridge', hint: 'That hill pushes you AWAY. Ride the pass between the hill and the well.', extent: 62, ship: { x: 0, z: 44 }, goal: { x: 0, z: -44, r: 5 }, maxLaunch: 48, fuel: 3.5, bodies: [{ name: 'Nope', mass: -1200, radius: 4.5, color: 0xff6b35, x: -12, z: 0 }, { name: 'Anchor', mass: 1300, radius: 5, color: 0x90e0ef, x: 16, z: -2 }] },
  moonshot: { name: 'Moonshot', hint: 'The moon keeps moving — even while you aim. Time your release!', extent: 62, ship: { x: 0, z: 44 }, goal: { x: 0, z: -46, r: 5 }, maxLaunch: 48, fuel: 3.5, bodies: [{ name: 'Aegis', mass: 2200, radius: 7, color: 0xbde0fe, x: 0, z: -4 }, { name: 'Luna', mass: 520, radius: 3, color: 0xe2e2e2, orbit: { parent: 0, radius: 20, omega: 0.7, phase: 0.8 } }] },
  horizon: { name: 'Event Horizon', hint: 'Nothing escapes the red ring. Skim close for a huge slingshot — but not TOO close.', extent: 64, ship: { x: -38, z: 44 }, goal: { x: 34, z: -44, r: 4.5 }, maxLaunch: 44, fuel: 4, bodies: [{ name: 'Maw', mass: 5200, radius: 3.5, horizon: 6.5, color: 0x1a1a2e, x: 0, z: 0, type: 'blackhole' }] },
  grandtour: { name: 'Grand Tour', hint: 'Everything at once. Take your time — plot the long way round.', extent: 74, ship: { x: 30, z: 56 }, goal: { x: -34, z: -50, r: 5 }, maxLaunch: 48, fuel: 5, bodies: [{ name: 'Titan', mass: 1700, radius: 6, color: 0xffd166, x: 26, z: 14 }, { name: 'Wisp', mass: 420, radius: 2.5, color: 0xe2e2e2, orbit: { parent: 0, radius: 15, omega: 0.8, phase: 2.1 } }, { name: 'Nope II', mass: -1600, radius: 4.5, color: 0xff6b35, x: 2, z: -4 }, { name: 'Maw II', mass: 4200, radius: 3, horizon: 5.5, color: 0x1a1a2e, x: -26, z: -18, type: 'blackhole' }] },
};

const SETS = [
  {
    name: 'Cadet Orbits', difficulty: 1, sample: sampleSet1, band: [1.1, 2.7],
    originals: [{ level: ORIGINALS.liftoff, slot: 0 }, { level: ORIGINALS.thedip, slot: 1 }],
    hint: 'Multiple wells bend every shot. Learn to read the terrain.',
    slotHints: { 2: 'Orange fuel cells sit near good routes — big launches burn fuel, so top up!' },
    pickups: slot => (slot >= 2 ? 1 : 0),
    names: ['First Glide', 'Two Stones', 'Fuel Run', 'Long Coast', 'Downhill Run', 'Easy Does It', 'Twin Dimples', 'Drift Lane', 'Warm Up', 'Graduation'],
  },
  {
    name: 'Slingshot Academy', difficulty: 2, sample: sampleSet2, band: [0.6, 1.8],
    originals: [{ level: ORIGINALS.slingshot, slot: 0 }, { level: ORIGINALS.saddle, slot: 1 }],
    hint: 'Big wells block the way. Dive in and let gravity throw you.',
    slotHints: {
      2: 'Derelict ships drift in the lanes now — one touch and it\'s over.',
      6: 'That ship is on patrol. Watch its route before you launch.',
    },
    pickups: () => 1,
    names: ['Around the Bend', 'Deep Dive', 'Wreckage Field', 'Double Trouble', 'The Long Way', 'Whiplash', 'Picket Line', 'Gravity Assist', 'Full Send', 'Masterclass'],
  },
  {
    name: 'Repulsor Fields', difficulty: 3, sample: sampleSet3, band: [0.4, 1.35],
    originals: [{ level: ORIGINALS.repulsor, slot: 0 }],
    hint: 'Orange hills push you away. Ride the passes between push and pull.',
    slotHints: { 4: 'Dock at the station 🛰 first — it refuels you for the next leg.' },
    pickups: () => 1,
    names: ['Uphill Battle', 'The Pass', 'Push and Pull', 'Ridge Runner', 'Waystation', 'Backpressure', 'Crosswind', 'The Squeeze', 'Turbulence', 'Summit'],
  },
  {
    name: 'Clockwork Moons', difficulty: 4, sample: sampleSet4, band: [0.25, 1.1],
    originals: [{ level: ORIGINALS.moonshot, slot: 0 }],
    hint: 'Everything is moving — even while you aim. Timing is everything.',
    slotHints: {
      3: 'Grab the cargo 📦, then haul it to the dropoff 📥. It\'s heavy — thrusters suffer.',
      6: 'Gravity assist: launch when a moving body can sling you forward, not against you.',
    },
    pickups: slot => 1 + (slot >= 6 ? 1 : 0),
    timing: 6,
    names: ['Tick Tock', 'Orbit Window', 'Waltz', 'First Haul', 'Pendulum', 'Metronome', 'Eclipse', 'Revolution', 'Perfect Timing', 'Clockwork'],
  },
  {
    name: 'Deep Space', difficulty: 5, sample: sampleSet5, band: [0.08, 0.9],
    originals: [{ level: ORIGINALS.horizon, slot: 0 }, { level: ORIGINALS.grandtour, slot: 1 }],
    hint: 'Whole solar systems, weak engines. Ride the planets\' orbital momentum — launch windows matter.',
    slotHints: {
      3: 'Your engine can\'t brute-force this one. Wait for a planet to swing by and steal its momentum.',
    },
    pickups: slot => 1 + (slot >= 4 ? 1 : 0),
    timing: 3,
    names: ['Outer Rim', 'Three-Body Problem', 'Star System', 'Dark Passage', 'Planetfall', 'The Gauntlet', 'Singularity', 'Far Shore', 'Last Light', 'GravityLoop'],
  },
];

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
const MIN_WINS = 3;       // per-leg coarse floor so `solve.js --fast` always passes
const ATTEMPTS = 500;

const allLevels = [];
for (let s = 0; s < SETS.length; s++) {
  const set = SETS[s];
  const slots = new Array(10).fill(null);
  for (const o of set.originals) {
    const r = evaluate(set, false, o.level);
    slots[o.slot] = o.level;
    console.log(`[set ${s + 1}] slot ${o.slot} original  ${o.level.name.padEnd(18)} rates [${r.rates.map(x => x.toFixed(2)).join(', ')}]%`);
  }
  for (let slot = 0; slot < 10; slot++) {
    if (slots[slot]) continue;
    const needsTiming = set.timing != null && slot >= set.timing;
    let best = null;
    let found = null;
    let geoOk = 0, solvable = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const rng = mulberry32(3e6 + s * 100003 + slot * 1009 + attempt);
      const lv = set.sample(rng, slot);
      if (!lv) continue;
      geoOk++;
      const r = evaluate(set, needsTiming, lv, best ? best.res.dist : Infinity);
      if (r.minWins < MIN_WINS || r.dist === Infinity) continue;
      solvable++;
      if (!best || r.dist < best.res.dist) best = { level: lv, res: r, rng };
      if (r.dist === 0) { found = { level: lv, res: r, rng }; break; }
    }
    const chosen = found || best;
    if (!chosen) throw new Error(`set ${s + 1} slot ${slot}: no solvable candidate (geoOk ${geoOk}/${ATTEMPTS}, solvable ${solvable})`);
    const nPickups = set.pickups ? set.pickups(slot) : 0;
    if (nPickups > 0) placePickupsOnPaths(chosen.rng, chosen.level, chosen.res.winners, nPickups);
    chosen.level.name = set.names[slot];
    chosen.level.hint = set.slotHints[slot] || set.hint;
    slots[slot] = chosen.level;
    const r = chosen.res;
    console.log(
      `[set ${s + 1}] slot ${slot} generated ${set.names[slot].padEnd(18)} rates [${r.rates.map(x => x.toFixed(2)).join(', ')}]%` +
      ` legs ${r.legs}${needsTiming ? ` timing ${r.conc.toFixed(2)}` : ''}` +
      `${(chosen.level.pickups || []).length ? ` pickups ${chosen.level.pickups.length}` : ''}` +
      `${found ? '' : '  (closest to band)'}`
    );
  }
  for (const lv of slots) {
    lv.difficulty = set.difficulty;
    allLevels.push(lv);
  }
}

// ---------------------------------------------------------------------------
// Emit src/levels.js
// ---------------------------------------------------------------------------
const setsOut = SETS.map(s => ({ name: s.name, difficulty: s.difficulty }));
let js = `// GravityLoop — level data (50 levels in 5 themed sets of 10).
// GENERATED by tools/generate.js — edit that file and re-run:
//   node tools/generate.js
// Coordinates: x is right, z is toward the camera (ship starts at +z).
// mass < 0 makes a repulsor (a hill instead of a well).

export const SETS = ${JSON.stringify(setsOut, null, 2)};

export const LEVELS = ${JSON.stringify(allLevels, null, 2)};
`;
js = js.replace(/"color": (\d+)/g, (_, n) => `"color": 0x${Number(n).toString(16)}`);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'levels.js');
fs.writeFileSync(out, js);
console.log(`\nWrote ${allLevels.length} levels to ${out}`);
