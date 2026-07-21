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
    (level.hazards || []).some(h => h.orbit || h.patrol || h.comet);
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
    const isHome = level.homeIdx === i || bi.moonOf === level.homeIdx;
    const isTarget = level.targetIdx === i || bi.moonOf === level.targetIdx;
    const padM = isHome ? 3 : moving ? Math.min(padClear, 10) : padClear;
    const goalM = isTarget ? 3 : moving ? Math.min(goalClear, 8) : goalClear;
    if (pointToAnnulus(a, level.ship.x, level.ship.z) < bi.radius + padM) return false;
    if (pointToAnnulus(a, level.goal.x, level.goal.z) < bi.radius + goalM) return false;
    for (const wp of level.waypoints || []) {
      if (pointToAnnulus(a, wp.x, wp.z) < bi.radius + (moving ? 6 : 10)) return false;
    }
    for (let j = i + 1; j < level.bodies.length; j++) {
      const bj = level.bodies[j];
      const oi = bi.orbit, oj = bj.orbit;
      if ((oj && oj.parent === i) || (oi && oi.parent === j)) continue;
      if (bi.moonOf === j || bj.moonOf === i ||
          (bi.moonOf != null && bi.moonOf === bj.moonOf)) {
        if (dist(a.x, a.z, annulus(level, j).x, annulus(level, j).z) < bi.radius + bj.radius + 2) return false;
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
  if (h.comet) {
    const c = h.comet, out = [];
    for (let k = 0; k < 12; k++) {
      const th = (k / 12) * Math.PI * 2;
      const px = Math.cos(th) * c.a, pz = Math.sin(th) * c.b;
      const cos = Math.cos(c.rot || 0), sin = Math.sin(c.rot || 0);
      out.push({ x: c.cx + px * cos - pz * sin, z: c.cz + px * sin + pz * cos });
    }
    return out;
  }
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
// Bodies: realistic size tiers. The Sun dwarfs gas giants, which dwarf rocky
// planets, which dwarf moons — and every Sol level carries the complete
// planetary inventory inward of its theme.
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

// Sol-system catalog (sizes roughly tiered like the real thing)
const CAT = {
  mercury: { name: 'Mercury', r: 1.5, m: 120, c: 0xb5a642 },
  venus: { name: 'Venus', r: 2.5, m: 380, c: 0xe8c07d },
  earth: { name: 'Earth', r: 2.6, m: 420, c: 0x4d9de0 },
  moon: { name: 'Moon', r: 1.0, m: 60, c: 0xd8d8d8 },
  mars: { name: 'Mars', r: 1.9, m: 220, c: 0xd1603d },
  jupiter: { name: 'Jupiter', r: 6.5, m: 1500, c: 0xd9a066 },
  saturn: { name: 'Saturn', r: 5.7, m: 1250, c: 0xe3c896 },
};
const JUP_MOONS = ['Io', 'Europa', 'Ganymede'];
const SAT_MOONS = ['Titan', 'Rhea', 'Enceladus'];

function pushBody(lv, spec, x, z, extra = {}) {
  lv.bodies.push({ name: spec.name, mass: spec.m, radius: spec.r, color: spec.c, x: Math.round(x), z: Math.round(z), ...extra });
  return lv.bodies.length - 1;
}

// Static moon parked beside its parent (a snapshot of its orbit).
function pushMoonOf(rng, lv, parentIdx, spec, gap = null, ang = null) {
  const p = lv.bodies[parentIdx];
  const a = ang != null ? ang : rand(rng, 0, 6.28);
  const d = p.radius + (gap != null ? gap : rand(rng, 3.2, 4.6));
  return pushBody(lv, spec, p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, { moonOf: parentIdx });
}

function mkSun(rng, lv, name2, mLo, mHi, rLo = 11, rHi = 13) {
  const E = lv.extent;
  const body = {
    name: name2, mass: Math.round(rand(rng, mLo, mHi)),
    radius: +rand(rng, rLo, rHi).toFixed(1), color: pick(rng, SUN_COLORS),
    x: Math.round(sign(rng) * rand(rng, 0.02, 0.06) * E),
    z: Math.round(rand(rng, -0.05, 0.03) * E),
    type: 'sun',
  };
  lv.bodies.push(body);
  return body;
}

// The complete Sol inventory inward of `through`, with random ring angles.
// Returns { idx: {mercury, venus, earth, moon, mars, jupiter, saturn}, rings }.
function buildSol(rng, lv, through, earthAng) {
  const sun = lv.bodies[0];
  const idx = {}, rings = {};
  let R = sun.radius + rand(rng, 8, 10);
  rings.mercury = R;
  idx.mercury = pushBody(lv, CAT.mercury, ...Object.values(ringPos(sun, R, rand(rng, 0, 6.28))));
  R += rand(rng, 9, 11);
  rings.venus = R;
  idx.venus = pushBody(lv, CAT.venus, ...Object.values(ringPos(sun, R, rand(rng, 0, 6.28))));
  R += rand(rng, 9, 11);
  rings.earth = R;
  const ep = ringPos(sun, R, earthAng != null ? earthAng : rand(rng, 0, 6.28));
  idx.earth = pushBody(lv, CAT.earth, ep.x, ep.z);
  idx.moon = pushMoonOf(rng, lv, idx.earth, CAT.moon, rand(rng, 3.6, 5));
  if (through === 'earth') return { idx, rings, sun };
  R += rand(rng, 9, 11);
  rings.mars = R;
  idx.mars = pushBody(lv, CAT.mars, ...Object.values(ringPos(sun, R, rand(rng, 0, 6.28))));
  if (through === 'mars') return { idx, rings, sun };
  R += through === 'beltjupiter' ? rand(rng, 22, 25) : rand(rng, 14.5, 16.5);
  rings.jupiter = R;
  idx.jupiter = pushBody(lv, CAT.jupiter, ...Object.values(ringPos(sun, R, rand(rng, 0, 6.28))));
  const nJm = 2 + (rng() < 0.5 ? 1 : 0);
  const jBase = rand(rng, 0, 6.28);
  for (let i = 0; i < nJm; i++) {
    pushMoonOf(rng, lv, idx.jupiter, { name: JUP_MOONS[i], r: +rand(rng, 1, 1.3).toFixed(1), m: Math.round(rand(rng, 60, 120)), c: 0xd8d8d8 }, 3 + i * 2.4, jBase + i * rand(rng, 1.8, 2.3));
  }
  if (through === 'jupiter' || through === 'beltjupiter') return { idx, rings, sun };
  R += rand(rng, 18.5, 20.5);
  rings.saturn = R;
  idx.saturn = pushBody(lv, CAT.saturn, ...Object.values(ringPos(sun, R, rand(rng, 0, 6.28))));
  const sBase = rand(rng, 0, 6.28);
  for (let i = 0; i < 2; i++) {
    pushMoonOf(rng, lv, idx.saturn, { name: SAT_MOONS[i], r: +rand(rng, 1, 1.3).toFixed(1), m: Math.round(rand(rng, 60, 120)), c: 0xd8d8d8 }, 2.8 + i * 2.4, sBase + i * rand(rng, 1.9, 2.4));
  }
  return { idx, rings, sun };
}

// pad just off a body (radially outward from the sun unless dir given)
function padByBody(lv, body, from, gap) {
  const u = unit(body.x - from.x, body.z - from.z);
  lv.ship = { x: Math.round(body.x + u.x * (body.radius + gap)), z: Math.round(body.z + u.z * (body.radius + gap)) };
}
function goalByBody(lv, body, from, gap, r) {
  const u = unit(body.x - from.x, body.z - from.z);
  lv.goal = { x: Math.round(body.x + u.x * (body.radius + gap)), z: Math.round(body.z + u.z * (body.radius + gap)), r };
}

// Comet: lethal, massless, slow LARGE elliptical orbit around the sun.
function addComet(rng, lv) {
  const E = lv.extent, sun = lv.bodies[0];
  for (let tries = 0; tries < 30; tries++) {
    const h = {
      radius: 1.2,
      comet: {
        cx: sun.x, cz: sun.z,
        a: +(rand(rng, 0.5, 0.72) * E).toFixed(1),
        b: +(rand(rng, 0.2, 0.34) * E).toFixed(1),
        rot: +rand(rng, 0, 3.14).toFixed(2),
        omega: +(sign(rng) * rand(rng, 0.04, 0.09)).toFixed(3),
        phase: +rand(rng, 0, 6.28).toFixed(2),
      },
    };
    const pts = hazardPoints(h);
    const ok = pts.every(p => Math.hypot(p.x, p.z) <= E * 0.93 && bodyClearance(lv, p.x, p.z) >= h.radius + 2) &&
      pts.every(p => keyPoints(lv).every(kp => dist(p.x, p.z, kp.x, kp.z) >= 9));
    if (ok) { (lv.hazards = lv.hazards || []).push(h); return; }
  }
}

// ---------------------------------------------------------------------------
// Set 1 — Earthrise: full inner inventory; launch from Earth. Static.
// ---------------------------------------------------------------------------
function sampleEarthrise(rng, slot) {
  const E = 66;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 6 }, maxLaunch: Math.round(rand(rng, 48, 52)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2000, 2600);
  const sol = buildSol(rng, lv, slot < 6 ? 'earth' : 'mars', rand(rng, 0, 6.28));
  const earth = lv.bodies[sol.idx.earth];
  lv.homeIdx = sol.idx.earth;
  let targetIdx;
  if (slot < 3) {
    // to the Moon: pad on the FAR side of Earth, so home gravity is in play
    const moon = lv.bodies[sol.idx.moon];
    const mu = unit(moon.x - earth.x, moon.z - earth.z);
    lv.ship = { x: Math.round(earth.x - mu.x * (earth.radius + rand(rng, 7, 9))), z: Math.round(earth.z - mu.z * (earth.radius + rand(rng, 7, 9))) };
    targetIdx = sol.idx.moon;
    lv.goal = { x: Math.round(moon.x + mu.x * (moon.radius + rand(rng, 8, 10))), z: Math.round(moon.z + mu.z * (moon.radius + rand(rng, 8, 10))), r: +(6.4 - slot * 0.15).toFixed(1) };
  } else {
    padByBody(lv, earth, sun, rand(rng, 7, 9));
    targetIdx = slot < 6 ? sol.idx.venus : sol.idx.mars;
    goalByBody(lv, lv.bodies[targetIdx], sun, rand(rng, 9, 11), +(6.2 - slot * 0.12).toFixed(1));
  }
  lv.targetIdx = targetIdx;
  return levelGeometryOk(lv, 15, 13) ? lv : null;
}

// ---------------------------------------------------------------------------
// Set 2 — Inner System: everything through Mars, wrecks, first comet. Static.
// ---------------------------------------------------------------------------
function sampleInner(rng, slot) {
  const E = 70;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 5.2 }, maxLaunch: Math.round(rand(rng, 46, 50)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000);
  const sol = buildSol(rng, lv, 'mars', rand(rng, 0, 6.28));
  padByBody(lv, lv.bodies[sol.idx.earth], sun, rand(rng, 7, 9));
  lv.homeIdx = sol.idx.earth;
  const targetIdx = slot < 3 ? sol.idx.venus : slot < 6 ? sol.idx.mercury : sol.idx.mars;
  goalByBody(lv, lv.bodies[targetIdx], sun, rand(rng, 9, 11), +rand(rng, 4.9, 5.5).toFixed(1));
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 15, 13)) return null;
  if (slot >= 2) for (let i = 0; i < 1 + (slot >= 5 ? 1 : 0); i++) addDerelict(rng, lv);
  if (slot >= 4) addComet(rng, lv);
  if (slot >= 7) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 3 — Outer Planets: full inventory through Jupiter/Saturn. Static.
// ---------------------------------------------------------------------------
function sampleOuter(rng, slot) {
  const through = slot < 5 ? 'jupiter' : 'saturn';
  const E = through === 'jupiter' ? 84 : 98;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: +rand(rng, 4.6, 5.4).toFixed(1) }, maxLaunch: Math.round(rand(rng, 44, 49)), fuel: 3.5, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2600, 3200, 10, 11.5);
  const sol = buildSol(rng, lv, through, rand(rng, 0, 6.28));
  padByBody(lv, lv.bodies[sol.idx.earth], sun, rand(rng, 7, 9));
  lv.homeIdx = sol.idx.earth;
  const targetIdx = through === 'jupiter' ? sol.idx.jupiter : sol.idx.saturn;
  goalByBody(lv, lv.bodies[targetIdx], sun, rand(rng, 10, 13), lv.goal.r);
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 15, 12)) return null;
  if (slot >= 4 && !addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  if (slot >= 2 && rng() < 0.6) addDerelict(rng, lv);
  if (slot >= 3) addComet(rng, lv);
  if (slot >= 8) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 4 — Asteroid Belt: a dense rock wall between Mars and Jupiter with
// 1-2 narrow passages. Full inventory through Jupiter.
// ---------------------------------------------------------------------------
function sampleBelt(rng, slot) {
  const E = 92;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: +rand(rng, 4.8, 5.2).toFixed(1) }, maxLaunch: Math.round(rand(rng, 42, 48)), fuel: 4, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000, 10, 11.5);
  const sol = buildSol(rng, lv, 'beltjupiter', rand(rng, 0, 6.28));
  padByBody(lv, lv.bodies[sol.idx.earth], sun, rand(rng, 7, 9));
  lv.homeIdx = sol.idx.earth;
  lv.targetIdx = sol.idx.jupiter;
  goalByBody(lv, lv.bodies[sol.idx.jupiter], sun, rand(rng, 10, 13), lv.goal.r);
  if (!levelGeometryOk(lv, 15, 12)) return null;
  if (slot >= 3) {
    if (!addWaypoints(rng, lv, [{ t: 0.35, r: 4.5, type: 'cargo' }, { t: 0.7, r: 4.5, type: 'dropoff' }])) return null;
  } else if (slot >= 1 && rng() < 0.5) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  }
  // the belt wall: an annulus of rocks between Mars and Jupiter, with
  // narrow angular passages left open
  const bandLo = sol.rings.mars + 6, bandHi = sol.rings.jupiter - 9;
  const nGaps = slot < 5 ? 2 : 1;
  const gaps = [];
  for (let gi = 0; gi < nGaps; gi++) gaps.push({ a: rand(rng, 0, 6.28), w: rand(rng, 0.3, 0.45) });
  const inGap = ang => gaps.some(gp => {
    const d = Math.abs(((ang - gp.a + Math.PI) % (2 * Math.PI)) - Math.PI);
    return d < gp.w / 2;
  });
  const nRocks = 30 + slot * 2;
  let placed = 0;
  lv.hazards = lv.hazards || [];
  for (let i = 0; i < nRocks * 8 && placed < nRocks; i++) {
    const ang = rand(rng, 0, 6.28);
    if (inGap(ang)) continue;
    const R = rand(rng, bandLo, bandHi);
    const h = {
      kind: 'asteroid', radius: +rand(rng, 0.8, 1.6).toFixed(1),
      x: Math.round(sun.x + Math.cos(ang) * R), z: Math.round(sun.z + Math.sin(ang) * R),
    };
    if (Math.hypot(h.x, h.z) > E * 0.93) continue;
    if (bodyClearance(lv, h.x, h.z) < h.radius + 2) continue;
    if (!keyPoints(lv).every(kp => dist(h.x, h.z, kp.x, kp.z) >= 8)) continue;
    if (!lv.hazards.every(o => o.kind !== 'asteroid' || dist(h.x, h.z, o.x, o.z) >= h.radius + o.radius + 1.2)) continue;
    lv.hazards.push(h);
    placed++;
  }
  if (placed < nRocks * 0.6) return null;
  if (slot >= 2) addComet(rng, lv);
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
  const sun = mkSun(rng, lv, pick(rng, ['Helios', 'Aurum', 'Tsuki', 'Vera', 'Kestrel', 'Rana']), 2600, 3800, 10, 12);
  const planetIdxs = [];
  let orbR = sun.radius + rand(rng, 8, 11);
  const nPl = 3 + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < nPl; i++) {
    if (orbR > E * 0.62) break;
    const isGas = rng() < 0.4;
    planetIdxs.push(lv.bodies.length);
    lv.bodies.push({
      name: name(ALIEN_NAMES),
      mass: isGas ? Math.round(rand(rng, 1000, 1500)) : Math.round(rand(rng, 250, 550)),
      radius: isGas ? +rand(rng, 5, 6).toFixed(1) : +rand(rng, 2, 3.2).toFixed(1),
      color: pick(rng, PLANET_COLORS),
      orbit: { cx: sun.x, cz: sun.z, radius: +orbR.toFixed(1), omega: +(sign(rng) * rand(rng, 0.22, 0.55)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    orbR += Math.max(14, rand(rng, 0.15, 0.19) * E);
  }
  if (!planetIdxs.length) return null;
  let moons = 0;
  for (const pIdx of planetIdxs) {
    if (moons >= 2 || rng() >= 0.45) continue;
    const parent = lv.bodies[pIdx];
    lv.bodies.push({
      name: name(ALIEN_NAMES), mass: Math.round(rand(rng, 50, 130)),
      radius: +rand(rng, 1, 1.5).toFixed(1), color: 0xe2e2e2,
      orbit: { parent: pIdx, radius: +(parent.radius + rand(rng, 3.5, 5.5)).toFixed(1), omega: +(sign(rng) * rand(rng, 0.8, 1.2)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
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
  if (slot >= 1 && rng() < 0.5) addComet(rng, lv);
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
    hint: 'You launch from Earth — the whole inner system is out there bending your shot.',
    slotHints: {
      0: 'Welcome aboard! Drag back from your ship to launch from Earth to the lunar station.',
      3: 'Venus this time — swing past Sol\'s huge well without falling in.',
      6: 'All the way to Mars station. Plot carefully.',
    },
    names: ['Earthrise', 'To the Moon', 'Lunar Loop', 'Venus Bound', 'Morning Star', 'Transit of Venus', 'Halfway to Mars', 'Red Planet', 'Dusty Landing', 'Escape Velocity'],
  },
  {
    name: 'Inner System', difficulty: 2, sample: sampleInner, band: [0.6, 1.8],
    originals: [],
    hint: 'The inner system: tight, hot orbits around a heavy Sun.',
    slotHints: {
      2: 'Derelict ships drift in the lanes — one touch and it\'s over.',
      3: 'Mercury station: skim Sol\'s well without falling in.',
      4: 'A comet crosses these lanes on a long ellipse. Watch its arrow.',
    },
    names: ['Inner Ring', 'Crossing Venus', 'Sunward', 'Mercury Dive', 'Comet Crossing', 'Solar Wind', 'Retrograde', 'Hot Lap', 'Twin Transfer', 'Inner Mastery'],
  },
  {
    name: 'Outer Planets', difficulty: 3, sample: sampleOuter, band: [0.4, 1.35],
    originals: [],
    hint: 'Gas giants ahead: huge wells, huge slingshots — and the whole inner system behind you.',
    slotHints: {
      4: 'Dock at the waystation 🛰 first. Stops never refuel — grab cells on the way.',
      5: 'Saturn now. Jupiter is still out there, bending everything.',
    },
    names: ['Jovian Leap', 'Eye of Jupiter', 'Io Flyby', 'Europa Run', 'Callisto Stop', 'Saturn Swing', 'Titan Station', 'Ring Runner', 'Enceladus Deep', 'Grand Cruise'],
  },
  {
    name: 'Asteroid Belt', difficulty: 4, sample: sampleBelt, band: [0.25, 1.1], timing: 6,
    originals: [],
    hint: 'A wall of rock rings the Sun between Mars and Jupiter. Find the passages — or go around.',
    slotHints: {
      3: 'Haul the cargo 📦 through the belt to the dropoff 📥 — fuel cells are NOT optional.',
      6: 'Patrols and comets cross the passages. Time your launch around their arrows.',
    },
    names: ['Into the Belt', 'Rock Hopping', 'Ceres Approach', 'First Haul', 'Cargo Convoy', 'Rubble Wall', 'The Passage', 'Vesta Run', 'Dense Cluster', 'Belt Baron'],
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
