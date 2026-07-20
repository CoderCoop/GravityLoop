// GravityLoop — level generator.
// Samples themed levels with a seeded RNG, keeps only candidates whose every
// leg the brute-force solver confirms is winnable inside the set's difficulty
// band, then writes the full 50-level roster to src/levels.js.
//
//   node tools/generate.js
//
// Deterministic: same seeds -> same levels.
//
// Campaign: the game starts at Earth and works outward —
//   set 1 Earthrise        launch from Earth to the Moon, Venus, Mars (static)
//   set 2 Inner System     Mercury..Mars around a heavy Sun (static)
//   set 3 Outer Planets    gas giants + moons, station routes (static)
//   set 4 Asteroid Belt    rock fields, cargo hauls, patrol lanes
//   set 5 New Star Systems alien suns, antimatter stars, black holes (moving)
import { predict, legStart, legCount, launchFuelCost } from '../src/physics.js';
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

// Per-leg verdict: every leg in band, legs of comparable difficulty, and
// (when required) timing-window sensitivity on the first launch. Aborts
// early once a candidate cannot beat the best found so far.
function evaluate(set, needsTiming, level, bestDist = Infinity) {
  const legs = legCount(level);
  const low = set.band[0], high = set.band[1] * (legs > 1 ? 2.2 : 1);
  const rates = [], winners = [];
  let dist2 = 0, minWins = Infinity, conc = 0;
  for (let s = 0; s < legs; s++) {
    const r = solveLeg(level, s);
    minWins = Math.min(minWins, r.wins);
    if (r.wins < MIN_WINS) return { minWins, rates, dist: Infinity, conc, legs, winners };
    rates.push(r.rate);
    winners.push(r.winners);
    if (r.rate < low) dist2 += low - r.rate;
    else if (r.rate > high) dist2 += r.rate - high;
    if (s === 0 && needsTiming) {
      conc = r.byT0 ? concentration(r.byT0) : 0;
      if (conc < 0.5) dist2 += (0.5 - conc) * 6;     // demand launch windows
    }
    if (dist2 >= bestDist) return { minWins, rates, dist: dist2, conc, legs, winners };
  }
  if (legs > 1) {
    const ratio = Math.max(...rates) / Math.max(Math.min(...rates), 1e-9);
    if (ratio > 2.5) dist2 += ratio - 2.5;           // legs must be comparable
  }
  return { minWins, rates, dist: dist2, conc, legs, winners };
}

// ---------------------------------------------------------------------------
// Geometry. A moving body's possible positions form an annulus around its
// root center — clearance is distance to the band. The designated home body
// (Earth, next to the pad) and target body (next to the goal) are exempt
// from the usual big margins.
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

function bodyClearance(level, x, z) {
  let min = Infinity;
  for (let i = 0; i < level.bodies.length; i++) {
    const a = annulus(level, i);
    min = Math.min(min, pointToAnnulus(a, x, z) - level.bodies[i].radius);
  }
  return min;
}

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
    if (Math.hypot(a.x, a.z) + a.maxR + bi.radius > E * 0.95) return false;
    const isHome = level.homeIdx === i, isTarget = level.targetIdx === i;
    const padM = isHome ? 5 : moving ? Math.min(padClear, 10) : padClear;
    const goalM = isTarget ? 4 : moving ? Math.min(goalClear, 8) : goalClear;
    if (pointToAnnulus(a, level.ship.x, level.ship.z) < bi.radius + padM) return false;
    if (pointToAnnulus(a, level.goal.x, level.goal.z) < bi.radius + goalM) return false;
    for (const wp of level.waypoints || []) {
      if (pointToAnnulus(a, wp.x, wp.z) < bi.radius + (moving ? 6 : 10)) return false;
    }
    for (let j = i + 1; j < level.bodies.length; j++) {
      const bj = level.bodies[j];
      const oi = bi.orbit, oj = bj.orbit;
      if ((oj && oj.parent === i) || (oi && oi.parent === j)) continue;
      if (bi.moonOf === j || bj.moonOf === i) {
        if (dist(a.x, a.z, annulus(level, j).x, annulus(level, j).z) < bi.radius + bj.radius + 2.5) return false;
        continue;
      }
      if (oi && oj && oi.parent == null && oj.parent == null &&
          (oi.cx || 0) === (oj.cx || 0) && (oi.cz || 0) === (oj.cz || 0) && oi.omega === oj.omega) {
        continue;
      }
      if (annulusGap(a, annulus(level, j)) < bi.radius + bj.radius + 6) return false;
    }
  }
  const sep = level.extent >= 66 ? 20 : 24;
  const kps = keyPoints(level);
  for (let i = 0; i < kps.length; i++) {
    for (let j = i + 1; j < kps.length; j++) {
      if (dist(kps[i].x, kps[i].z, kps[j].x, kps[j].z) < sep) return false;
    }
  }
  return true;
}

function hazardPoints(h) {
  if (h.orbit) return null;
  if (h.patrol) {
    const p = h.patrol, out = [];
    for (let k = 0; k <= 4; k++) out.push({ x: p.x1 + (p.x2 - p.x1) * (k / 4), z: p.z1 + (p.z2 - p.z1) * (k / 4) });
    return out;
  }
  return [{ x: h.x, z: h.z }];
}

function hazardOk(level, h, keyMargin = 12) {
  const E = level.extent;
  const clear = (x, z) => {
    if (Math.hypot(x, z) > E * 0.88) return false;
    if (bodyClearance(level, x, z) < h.radius + 3) return false;
    for (const kp of keyPoints(level)) {
      if (dist(x, z, kp.x, kp.z) < keyMargin) return false;
    }
    for (const other of level.hazards || []) {
      for (const p of hazardPoints(other) || [{ x: other.orbit.cx, z: other.orbit.cz }]) {
        if (dist(x, z, p.x, p.z) < h.radius + other.radius + 3) return false;
      }
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
// Fuel cells sit at the apex of DETOUR winning routes: among a leg's winning
// trajectories, prefer the ones that bow far away from the straight line to
// the target, and drop the cell at the farthest point of that bow. Direct
// routes miss it — you must deliberately fly the curved route to refuel.
function placePickupsOnPaths(rng, level, winnersByLeg, count) {
  level.pickups = [];
  const lastLeg = winnersByLeg.length - 1;
  const legsWithWins = winnersByLeg.map((w, i) => (w.length && i < lastLeg ? i : -1)).filter(i => i >= 0);
  if (!legsWithWins.length) { delete level.pickups; return; }

  const apexes = new Map();   // leg -> [{dev, pt}] sorted by deviation desc
  for (const leg of legsWithWins) {
    const start = legStart(level, leg);
    const scored = [];
    for (const w of winnersByLeg[leg].slice(0, 25)) {
      const rad = (w.ang * Math.PI) / 180;
      const r = predict(level, start.x, start.z, Math.cos(rad) * w.sp, Math.sin(rad) * w.sp, w.t0, 10, leg);
      const end = r.points[r.points.length - 1];
      const ex = end.x - start.x, ez = end.z - start.z;
      const len = Math.max(Math.hypot(ex, ez), 1e-6);
      let dev = 0, apex = null;
      for (const pt of r.points) {
        const d = Math.abs((pt.x - start.x) * ez - (pt.z - start.z) * ex) / len;
        if (d > dev) { dev = d; apex = pt; }
      }
      if (apex) scored.push({ dev, pt: apex });
    }
    scored.sort((a, b) => b.dev - a.dev);
    apexes.set(leg, scored.slice(0, 8));
  }

  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 25; tries++) {
      const leg = legsWithWins[(i + tries) % legsWithWins.length];
      const cands = apexes.get(leg);
      if (!cands || !cands.length) continue;
      const c = pick(rng, cands);
      const x = Math.round(c.pt.x + rand(rng, -2.5, 2.5));
      const z = Math.round(c.pt.z + rand(rng, -2.5, 2.5));
      if (pickupOk(level, x, z)) {
        level.pickups.push({ x, z, fuel: 1.5 });
        break;
      }
    }
  }
  if (!level.pickups.length) delete level.pickups;
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

function addWaypoints(rng, level, specs) {
  const wps = [];
  for (const spec of specs) {
    let placed = false;
    for (let tries = 0; tries < 80 && !placed; tries++) {
      const t = spec.t + rand(rng, -0.08, 0.08);
      const x = Math.round(level.ship.x + (level.goal.x - level.ship.x) * t + rand(rng, -0.42, 0.42) * level.extent);
      const z = Math.round(level.ship.z + (level.goal.z - level.ship.z) * t + rand(rng, -0.16, 0.16) * level.extent);
      if (Math.hypot(x, z) > level.extent * 0.85) continue;
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
// Fuel economy: fuel (and fuel cells) only exist on multi-hop levels, and
// there the tank covers a typical first launch but NOT the whole route at
// typical power — cells along the early legs bridge the gap.
// ---------------------------------------------------------------------------
function tuneFuelEconomy(rng, level, res) {
  if (res.legs <= 1) return;
  placePickupsOnPaths(rng, level, res.winners, res.legs);
  const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const costs = res.winners.map(w => w.map(x => launchFuelCost(x.sp, level.maxLaunch)));
  level.legMinCosts = costs.map(c => +(c.length ? Math.min(...c) : 0.4).toFixed(2));
  const med = costs.map(c => (c.length ? median(c) : 0.8));
  const medTotal = med.reduce((a, b) => a + b, 0);
  if ((level.pickups || []).length >= 1) {
    level.fuel = +Math.min(5, Math.max(1.4, med[0] + 0.4)).toFixed(1);
  } else {
    level.fuel = +Math.min(5, medTotal + 1.2).toFixed(1);
  }
  level.fuelRequired = level.fuel < medTotal;
}

// ---------------------------------------------------------------------------
// Bodies: realistic size tiers
// ---------------------------------------------------------------------------
const SUN_COLORS = [0xffd166, 0xffb703, 0xff9e6b];
const ALIEN_NAMES = ['Vesta', 'Lyra', 'Atlas', 'Rhea', 'Iris', 'Quartz', 'Echo', 'Opal', 'Dune', 'Frost',
  'Jasper', 'Koa', 'Lumen', 'Mica', 'Nova', 'Onyx', 'Pip', 'Zephyr', 'Cinder', 'Willow'];
const PLANET_COLORS = [0x8ecae6, 0x7ae582, 0xff8fa3, 0xffd166, 0xf4a261, 0x90e0ef, 0xbde0fe, 0xc8b6ff, 0xffc8dd, 0x95d5b2];
const ANTIMATTER_NAMES = ['Nulla', 'Antara', 'Umbra', 'Vex', 'Inverse', 'Aversa'];
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

const ringPos = (c, R, a) => ({ x: Math.round(c.x + Math.cos(a) * R), z: Math.round(c.z + Math.sin(a) * R) });
const unit = (dx, dz) => { const d = Math.max(Math.hypot(dx, dz), 1e-9); return { x: dx / d, z: dz / d }; };

function mkSun(rng, lv, name2, mLo = 2200, mHi = 3200) {
  const E = lv.extent;
  const body = {
    name: name2, mass: Math.round(rand(rng, mLo, mHi)),
    radius: +rand(rng, 9, 11.5).toFixed(1), color: pick(rng, SUN_COLORS),
    x: Math.round(sign(rng) * rand(rng, 0.02, 0.14) * E),
    z: Math.round(rand(rng, -0.12, 0.04) * E),
    type: 'sun',
  };
  lv.bodies.push(body);
  return body;
}

function mkPlanet(lv, name2, R, ang, sun, size) {
  const p = ringPos(sun, R, ang);
  const body = { name: name2, mass: size.m, radius: size.r, color: size.c, x: p.x, z: p.z };
  lv.bodies.push(body);
  return lv.bodies.length - 1;
}

// planet size presets (rough real-world tiering)
const rocky = (rng, c) => ({ r: +rand(rng, 2.4, 3.8).toFixed(1), m: Math.round(rand(rng, 300, 700)), c });
const small = (rng, c) => ({ r: +rand(rng, 1.5, 2.2).toFixed(1), m: Math.round(rand(rng, 90, 250)), c });
const gas = (rng, c) => ({ r: +rand(rng, 5.5, 6.5).toFixed(1), m: Math.round(rand(rng, 1100, 1700)), c });
const iceGiant = (rng, c) => ({ r: +rand(rng, 4.4, 5).toFixed(1), m: Math.round(rand(rng, 800, 1100)), c });

// place the launch pad just off a home body, and the goal just past a target
function padByBody(lv, body, sun, gap) {
  const u = unit(body.x - sun.x, body.z - sun.z);
  lv.ship = { x: Math.round(body.x + u.x * (body.radius + gap)), z: Math.round(body.z + u.z * (body.radius + gap)) };
}
function goalByBody(lv, body, sun, gap, r) {
  const u = unit(body.x - sun.x, body.z - sun.z);
  lv.goal = { x: Math.round(body.x + u.x * (body.radius + gap)), z: Math.round(body.z + u.z * (body.radius + gap)), r };
}

// ---------------------------------------------------------------------------
// Set 1 — Earthrise: launch from Earth to the Moon, Venus, Mars. Static.
// ---------------------------------------------------------------------------
function sampleEarthrise(rng, slot) {
  const E = 62;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 6 }, maxLaunch: Math.round(rand(rng, 48, 52)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2000, 2600);
  const angPad = Math.atan2(0.72 * E - sun.z, rand(rng, -0.3, 0.3) * E - sun.x) + rand(rng, -0.25, 0.25);
  const Re = sun.radius + rand(rng, 13, 17);
  const earthIdx = mkPlanet(lv, 'Earth', Re, angPad, sun, { r: 3.4, m: Math.round(rand(rng, 480, 620)), c: 0x4d9de0 });
  const earth = lv.bodies[earthIdx];
  padByBody(lv, earth, sun, rand(rng, 8, 10));
  lv.homeIdx = earthIdx;

  let targetIdx;
  if (slot < 3) {
    const angM = angPad + sign(rng) * rand(rng, 0.55, 0.95);
    targetIdx = mkPlanet(lv, 'Moon', Re + rand(rng, 11, 15), angM, sun, small(rng, 0xd8d8d8));
  } else if (slot < 6) {
    const angT = Math.atan2(-0.73 * E - sun.z, rand(rng, -0.35, 0.35) * E - sun.x) + rand(rng, -0.2, 0.2);
    targetIdx = mkPlanet(lv, 'Venus', Re + rand(rng, 14, 19), angT, sun, { r: 3.2, m: Math.round(rand(rng, 430, 560)), c: 0xe8c07d });
  } else {
    const angT = Math.atan2(-0.73 * E - sun.z, rand(rng, -0.35, 0.35) * E - sun.x) + rand(rng, -0.2, 0.2);
    targetIdx = mkPlanet(lv, 'Mars', Re + rand(rng, 15, 20), angT, sun, { r: 2.6, m: Math.round(rand(rng, 300, 420)), c: 0xd1603d });
    if (rng() < 0.6) mkPlanet(lv, 'Mercury', sun.radius + rand(rng, 6.5, 8.5), rand(rng, 0, 6.28), sun, small(rng, 0xb5a642));
  }
  goalByBody(lv, lv.bodies[targetIdx], sun, rand(rng, 9, 11), +(6.4 - slot * 0.12).toFixed(1));
  lv.targetIdx = targetIdx;
  return levelGeometryOk(lv, 16, 14) ? lv : null;
}

// ---------------------------------------------------------------------------
// Set 2 — Inner System: Mercury..Mars around a heavy Sun. Static + wrecks.
// ---------------------------------------------------------------------------
function sampleInner(rng, slot) {
  const E = 66;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 5.2 }, maxLaunch: Math.round(rand(rng, 46, 50)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000);
  const Rmer = sun.radius + rand(rng, 6.5, 8.5);
  const Rven = Rmer + rand(rng, 9, 12);
  const Rear = Rven + rand(rng, 9, 12);
  const Rmar = Rear + rand(rng, 9, 12);
  const angs = [0, 1, 2, 3].map(() => rand(rng, 0, 6.28));
  const mer = mkPlanet(lv, 'Mercury', Rmer, angs[0], sun, small(rng, 0xb5a642));
  const ven = mkPlanet(lv, 'Venus', Rven, angs[1], sun, { r: 3.2, m: Math.round(rand(rng, 430, 560)), c: 0xe8c07d });
  const ear = mkPlanet(lv, 'Earth', Rear, angs[2], sun, { r: 3.4, m: Math.round(rand(rng, 480, 620)), c: 0x4d9de0 });
  const mar = mkPlanet(lv, 'Mars', Rmar, angs[3], sun, { r: 2.6, m: Math.round(rand(rng, 300, 420)), c: 0xd1603d });
  padByBody(lv, lv.bodies[ear], sun, rand(rng, 8, 10));
  lv.homeIdx = ear;
  const targetIdx = slot < 3 ? ven : slot < 6 ? mer : mar;
  goalByBody(lv, lv.bodies[targetIdx], sun, rand(rng, 9, 11), +rand(rng, 4.9, 5.5).toFixed(1));
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 16, 14)) return null;
  if (slot >= 2) for (let i = 0; i < 1 + (slot >= 4 ? 1 : 0); i++) addDerelict(rng, lv);
  if (slot >= 6) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 3 — Outer Planets: gas giants with moons; station routes. Static.
// ---------------------------------------------------------------------------
function sampleOuter(rng, slot) {
  const E = 70;
  const lv = { extent: E, ship: { x: Math.round(rand(rng, -0.35, 0.35) * E), z: Math.round(0.72 * E) }, goal: { x: Math.round(rand(rng, -0.4, 0.4) * E), z: Math.round(-0.73 * E), r: +rand(rng, 4.6, 5.4).toFixed(1) }, maxLaunch: Math.round(rand(rng, 44, 49)), fuel: 3.5, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2600, 3400);
  const Rj = sun.radius + rand(rng, 12, 16);
  const Rs = Rj + rand(rng, 13, 17);
  const jup = mkPlanet(lv, 'Jupiter', Rj, rand(rng, 0, 6.28), sun, gas(rng, 0xd9a066));
  const sat = mkPlanet(lv, 'Saturn', Rs, rand(rng, 0, 6.28), sun, { ...gas(rng, 0xe3c896), r: +rand(rng, 5.2, 5.8).toFixed(1) });
  if (slot >= 4 && Rs + 14 < E * 0.62) {
    mkPlanet(lv, pick(rng, ['Uranus', 'Neptune']), Rs + rand(rng, 12, 15), rand(rng, 0, 6.28), sun, iceGiant(rng, pick(rng, [0x9ad1d4, 0x5b7fde])));
  }
  // moons hug their giants (static snapshots of their orbits)
  const moonNames = [['Io', 'Europa', 'Ganymede'], ['Titan', 'Rhea', 'Enceladus']];
  [jup, sat].forEach((pi, k) => {
    if (rng() < 0.6) {
      const parent = lv.bodies[pi];
      const ang = rand(rng, 0, 6.28);
      const d = parent.radius + rand(rng, 7, 10);
      const idx = mkPlanet(lv, pick(rng, moonNames[k]), 0, 0, { x: parent.x + Math.cos(ang) * d, z: parent.z + Math.sin(ang) * d, radius: 0 }, small(rng, 0xd8d8d8));
      lv.bodies[idx].moonOf = pi;
    }
  });
  if (!levelGeometryOk(lv, 15, 12)) return null;
  if (slot >= 4 && !addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  if (slot >= 2 && rng() < 0.6) addDerelict(rng, lv);
  if (slot >= 7) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 4 — Asteroid Belt: rock fields between Mars and Jupiter; cargo hauls.
// ---------------------------------------------------------------------------
function sampleBelt(rng, slot) {
  const E = 70;
  const lv = { extent: E, ship: { x: Math.round(rand(rng, -0.35, 0.35) * E), z: Math.round(0.72 * E) }, goal: { x: Math.round(rand(rng, -0.4, 0.4) * E), z: Math.round(-0.73 * E), r: +rand(rng, 4.8, 5.2).toFixed(1) }, maxLaunch: Math.round(rand(rng, 42, 48)), fuel: 4, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000);
  mkPlanet(lv, 'Mars', sun.radius + rand(rng, 8, 11), rand(rng, 0, 6.28), sun, { r: 2.6, m: Math.round(rand(rng, 300, 420)), c: 0xd1603d });
  mkPlanet(lv, 'Jupiter', sun.radius + rand(rng, 34, 40), rand(rng, 0, 6.28), sun, gas(rng, 0xd9a066));
  if (!levelGeometryOk(lv, 15, 12)) return null;
  if (slot >= 3) {
    if (!addWaypoints(rng, lv, [{ t: 0.35, r: 4.5, type: 'cargo' }, { t: 0.7, r: 4.5, type: 'dropoff' }])) return null;
  } else if (slot >= 1 && rng() < 0.5) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  }
  // the belt itself: static rocks in an annulus between the two planets
  const nRocks = 7 + Math.min(slot, 5);
  let placed = 0;
  lv.hazards = lv.hazards || [];
  for (let i = 0; i < nRocks * 6 && placed < nRocks; i++) {
    const R = sun.radius + rand(rng, 15, 31);
    const ang = rand(rng, 0, 6.28);
    const h = {
      kind: 'asteroid', radius: +rand(rng, 1.5, 2.5).toFixed(1),
      x: Math.round(sun.x + Math.cos(ang) * R), z: Math.round(sun.z + Math.sin(ang) * R),
    };
    if (hazardOk(lv, h, 10)) { lv.hazards.push(h); placed++; }
  }
  if (placed < 5) return null;
  if (slot >= 5) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 5 — New Star Systems: alien suns, moving orbits, exotic objects.
// ---------------------------------------------------------------------------
function sampleAlien(rng, slot) {
  const E = Math.round(rand(rng, 68, 76));
  const lv = { extent: E, ship: { x: Math.round(rand(rng, -0.45, 0.45) * E * 0.9), z: Math.round(0.72 * E) }, goal: { x: Math.round(rand(rng, -0.5, 0.5) * E * 0.9), z: Math.round(-0.73 * E), r: +rand(rng, 4.2, 4.6).toFixed(1) }, maxLaunch: Math.round(rand(rng, 38, 46)), fuel: 5, bodies: [] };
  const name = namer(rng);
  const sun = mkSun(rng, lv, pick(rng, ['Helios', 'Aurum', 'Tsuki', 'Vera', 'Kestrel', 'Rana']), 2600, 3800);
  const planetIdxs = [];
  let orbR = sun.radius + rand(rng, 11, 15);
  const nPl = 3 + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < nPl; i++) {
    if (orbR > E * 0.62) break;
    const size = rng() < 0.4 ? { ...gas(rng, pick(rng, PLANET_COLORS)), r: +rand(rng, 5, 6).toFixed(1) } : rocky(rng, pick(rng, PLANET_COLORS));
    planetIdxs.push(lv.bodies.length);
    lv.bodies.push({
      name: name(ALIEN_NAMES), mass: size.m, radius: size.r, color: size.c,
      orbit: { cx: sun.x, cz: sun.z, radius: +orbR.toFixed(1), omega: +(sign(rng) * rand(rng, 0.22, 0.55)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    orbR += Math.max(16, rand(rng, 0.16, 0.2) * E);
  }
  if (!planetIdxs.length) return null;
  let moons = 0;
  for (const pIdx of planetIdxs) {
    if (moons >= 2 || rng() >= 0.45) continue;
    const parent = lv.bodies[pIdx];
    lv.bodies.push({
      name: name(ALIEN_NAMES), mass: Math.round(rand(rng, 80, 220)),
      radius: +rand(rng, 1.4, 2).toFixed(1), color: 0xe2e2e2,
      orbit: { parent: pIdx, radius: +(parent.radius + rand(rng, 5.5, 8)).toFixed(1), omega: +(sign(rng) * rand(rng, 0.8, 1.2)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    moons++;
  }
  const outer = lv.bodies[planetIdxs[planetIdxs.length - 1]].orbit.radius;
  if (rng() < 0.45) {
    const ang = rand(rng, 0, Math.PI * 2);
    const d = outer + rand(rng, 12, 20);
    lv.bodies.push({
      name: name(HOLE_NAMES), mass: Math.round(rand(rng, 3500, 4800)),
      radius: 3, horizon: +rand(rng, 5.5, 6.5).toFixed(1), color: 0x1a1a2e, type: 'blackhole',
      x: Math.round(sun.x + Math.cos(ang) * d), z: Math.round(sun.z + Math.sin(ang) * d),
    });
  }
  if (rng() < 0.35) {
    const ang = rand(rng, 0, Math.PI * 2);
    const d = outer + rand(rng, 13, 22);
    lv.bodies.push({
      name: name(ANTIMATTER_NAMES), mass: -Math.round(rand(rng, 500, 1000)),
      radius: +rand(rng, 3.5, 4.5).toFixed(1), color: 0xc77dff,
      x: Math.round(sun.x + Math.cos(ang) * d), z: Math.round(sun.z + Math.sin(ang) * d),
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
// Sets
// ---------------------------------------------------------------------------
const ORIGINALS = {
  horizon: { name: 'Event Horizon', hint: 'Nothing escapes the red ring. Skim close for a huge slingshot — but not TOO close.', extent: 64, ship: { x: -38, z: 44 }, goal: { x: 34, z: -44, r: 4.5 }, maxLaunch: 44, fuel: 4, bodies: [{ name: 'Maw', mass: 5200, radius: 3.5, horizon: 6.5, color: 0x1a1a2e, x: 0, z: 0, type: 'blackhole' }] },
  grandtour: { name: 'Grand Tour', hint: 'Everything at once. Take your time — plot the long way round.', extent: 74, ship: { x: 30, z: 56 }, goal: { x: -34, z: -50, r: 5 }, maxLaunch: 48, fuel: 5, bodies: [{ name: 'Titan', mass: 1700, radius: 6, color: 0xffd166, x: 26, z: 14 }, { name: 'Wisp', mass: 420, radius: 2.5, color: 0xe2e2e2, orbit: { parent: 0, radius: 15, omega: 0.8, phase: 2.1 } }, { name: 'Umbra', mass: -900, radius: 4.5, color: 0xc77dff, x: 2, z: -4 }, { name: 'Maw II', mass: 4200, radius: 3, horizon: 5.5, color: 0x1a1a2e, x: -26, z: -18, type: 'blackhole' }] },
};

const SETS = [
  {
    name: 'Earthrise', difficulty: 1, sample: sampleEarthrise, band: [1.1, 2.7],
    originals: [],
    hint: 'You launch from Earth. Every well between here and the target bends your shot.',
    slotHints: {
      0: 'Welcome aboard! Drag back from your ship to launch from Earth to the Moon.',
      3: 'Venus this time — swing around Sol and mind its huge well.',
      6: 'All the way to Mars. Use the Sun\'s well; don\'t fall in.',
    },
    names: ['Earthrise', 'To the Moon', 'Lunar Loop', 'Venus Bound', 'Morning Star', 'Transit of Venus', 'Halfway to Mars', 'Red Planet', 'Dusty Landing', 'Escape Velocity'],
  },
  {
    name: 'Inner System', difficulty: 2, sample: sampleInner, band: [0.6, 1.8],
    originals: [],
    hint: 'The inner system: tight, hot orbits around a heavy Sun.',
    slotHints: {
      2: 'Derelict ships drift in the lanes — one touch and it\'s over.',
      3: 'Mercury dive: skim Sol\'s well without falling in.',
      6: 'That ship is on patrol. Watch its route arrow before you launch.',
    },
    names: ['Inner Ring', 'Crossing Venus', 'Sunward', 'Mercury Dive', 'Perihelion', 'Solar Wind', 'Retrograde', 'Hot Lap', 'Twin Transfer', 'Inner Mastery'],
  },
  {
    name: 'Outer Planets', difficulty: 3, sample: sampleOuter, band: [0.4, 1.35],
    originals: [],
    hint: 'Gas giants ahead: huge wells, huge slingshots.',
    slotHints: { 4: 'Dock at the station 🛰 first. Stops never refuel — grab cells on the way.' },
    names: ['Jovian Leap', 'Eye of Jupiter', 'Ring Runner', 'Saturn Swing', 'Titan Stop', 'Ice Giants', 'Sideways Uranus', 'Neptune Deep', 'Kuiper Edge', 'Grand Cruise'],
  },
  {
    name: 'Asteroid Belt', difficulty: 4, sample: sampleBelt, band: [0.25, 1.1], timing: 6,
    originals: [],
    hint: 'The belt: thread the rocks between Mars and Jupiter.',
    slotHints: {
      3: 'Grab the cargo 📦 and haul it to the dropoff 📥 — and the fuel cells are NOT optional.',
      6: 'Patrol lanes cross the belt. Time your launch around their arrows.',
    },
    names: ['Into the Belt', 'Rock Hopping', 'Ceres Approach', 'First Haul', 'Cargo Convoy', 'Rubble Field', 'Dodging Stones', 'Vesta Run', 'Dense Cluster', 'Belt Baron'],
  },
  {
    name: 'New Star Systems', difficulty: 5, sample: sampleAlien, band: [0.08, 0.9], timing: 3,
    originals: [{ level: ORIGINALS.horizon, slot: 0 }, { level: ORIGINALS.grandtour, slot: 1 }],
    hint: 'Alien systems: antimatter stars, black holes, weak engines. Ride the orbits — launch windows matter.',
    slotHints: {
      3: 'Your engine can\'t brute-force this one. Wait for a planet to swing by and steal its momentum.',
      5: 'Cargo runs in a moving system, and stops never refuel. Plan the whole route.',
    },
    names: ['Event Horizon', 'Grand Tour', 'Star System', 'Dark Passage', 'Planetfall', 'The Gauntlet', 'Singularity', 'Far Shore', 'Last Light', 'GravityLoop'],
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
      const rng = mulberry32(4e6 + s * 100003 + slot * 1009 + attempt);
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
    tuneFuelEconomy(chosen.rng, chosen.level, chosen.res);
    chosen.level.name = set.names[slot];
    chosen.level.hint = set.slotHints[slot] || set.hint;
    slots[slot] = chosen.level;
    const r = chosen.res;
    console.log(
      `[set ${s + 1}] slot ${slot} generated ${set.names[slot].padEnd(18)} rates [${r.rates.map(x => x.toFixed(2)).join(', ')}]%` +
      ` legs ${r.legs}${needsTiming ? ` timing ${r.conc.toFixed(2)}` : ''}` +
      `${(chosen.level.pickups || []).length ? ` pickups ${chosen.level.pickups.length}` : ''}` +
      `${chosen.level.fuelRequired ? ' fuel-gated' : ''}` +
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
// mass < 0 makes an antimatter star (a hill instead of a well).

export const SETS = ${JSON.stringify(setsOut, null, 2)};

export const LEVELS = ${JSON.stringify(allLevels, null, 2)};
`;
js = js.replace(/"color": (\d+)/g, (_, n) => `"color": 0x${Number(n).toString(16)}`);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'levels.js');
fs.writeFileSync(out, js);
console.log(`\nWrote ${allLevels.length} levels to ${out}`);
