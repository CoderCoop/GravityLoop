// Put every planet and moon in motion.
//
// Adds a circular `orbit` to each body of each level (phase chosen so the
// body sits exactly where the static layout put it at t=0, keeping every
// generated layout intact), with a per-set speed ramp: barely-drifting early
// systems up to genuinely timing-dependent late ones. Set 5 already moves —
// its generated orbits are left alone.
//
// The speed is then VERIFIED, not assumed: a level keeps its target speed
// only if the solver still finds MIN_WINS winning launches on every leg and
// no body sweeps through the launch pad, a waypoint or the goal. Otherwise
// the level's orbits are slowed step by step until it passes (or dropped).
//
//   node tools/orbits.js --level=N --out=f.json   # one level (CI matrix job)
//   node tools/orbits.js --apply=DIR              # merge results -> levels.js
//   node tools/orbits.js --level=N                # print, don't write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { predict, legStart, legCount, bodiesAt, hazardsAt, anchorX, anchorZ } from '../src/physics.js';
import { LEVELS, SETS } from '../src/levels.js';
import { sweepPlan, requiredGap, drawRadius, isRoving, BODY_GAP } from './sweep.mjs';

// Degrees a mid-distance planet sweeps during a 10s flight, per set.
// Set 5 is untouched (it ships with fast alien orbits already).
const SWEEP_DEG = [4, 11, 18, 25];
const REF_R = 28;              // orbit radius the sweep target refers to
const MIN_WINS = 3;            // same coarse floor solve.js --fast enforces
const BACKOFF = [1, 0.62, 0.38, 0.22, 0.12];
const HORIZON = 12;            // seconds of flight the solver simulates
const T_SAMPLES = 11;          // launch times the solver tries (matches --fast)

function isSun(b) {
  return b.type === 'sun' || b.type === 'blackhole' || b.mass < 0;
}

// Pads and stations are structures parked beside a world, so they ride it:
// anything sitting within ANCHOR_GAP of a body's surface is anchored to that
// body and keeps its offset as the body orbits. Deep-space stations that
// belong to no world stay where they are.
const ANCHOR_GAP = 12;
function anchorTo(level, spot) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i];
    if (b.x == null) continue;                 // already-orbiting body
    const d = Math.hypot(spot.x - b.x, spot.z - b.z) - b.radius;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > ANCHOR_GAP) return null;
  const b = level.bodies[best];
  return { body: best, dx: +(spot.x - b.x).toFixed(3), dz: +(spot.z - b.z).toFixed(3) };
}
function anchorsFor(level) {
  const out = { ship: anchorTo(level, level.ship), goal: anchorTo(level, level.goal), waypoints: [] };
  for (const wp of level.waypoints || []) out.waypoints.push(anchorTo(level, wp));
  return out;
}

// Pads/stations anchored to body `pi`, as offsets from it.
function ridersOf(level, anchors, pi) {
  const out = [];
  const add = (a, r) => { if (a && a.body === pi) out.push({ dx: a.dx, dz: a.dz, r }); };
  add(anchors.ship, 3);
  add(anchors.goal, level.goal.r + 1);
  (level.waypoints || []).forEach((wp, i) => add(anchors.waypoints[i], wp.r + 1));
  return out;
}

// Fixed points a body must never sweep over: only the ones NOT riding it.
function keepOuts(level, anchors) {
  const spots = [];
  if (!anchors.ship) spots.push({ x: level.ship.x, z: level.ship.z, r: 3 });
  if (!anchors.goal) spots.push({ x: level.goal.x, z: level.goal.z, r: level.goal.r + 1 });
  (level.waypoints || []).forEach((wp, i) => {
    if (!anchors.waypoints[i]) spots.push({ x: wp.x, z: wp.z, r: wp.r + 1 });
  });
  return spots;
}

// Orbit for body i of `level`, or null if it should stay put.
function orbitFor(level, i, scale, anchors, frozen) {
  const b = level.bodies[i];
  if (b.orbit || isSun(b) || i === 0 || (frozen && frozen.has(i))) return null;
  const pi = b.moonOf != null ? b.moonOf : 0;
  const p = level.bodies[pi];
  if (!p || p.x == null) return null;
  const dx = b.x - p.x, dz = b.z - p.z;
  const r = Math.hypot(dx, dz);
  if (r < 1) return null;
  // A circle that passes over an unattached pad/station sweeps it sooner or
  // later no matter how slow it turns — that body stays put.
  for (const s of keepOuts(level, anchors)) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (Math.abs(d - r) < b.radius + s.r + 1) return null;
  }
  // Same test in parent-relative space for stations riding this same parent
  // (a moon and a station on the one planet keep a fixed relative geometry,
  // so if the moon's ring crosses the station it always will).
  for (const s of ridersOf(level, anchors, pi)) {
    const d = Math.hypot(s.dx, s.dz);
    if (Math.abs(d - r) < b.radius + s.r + 1) return null;
  }
  // Same again for parked obstacles — a derelict, a patrol's line, a comet's
  // ellipse. A ring that crosses one hits it eventually, which is exact and
  // cheap to rule out here rather than hoping a time sample lands on it.
  // Asteroid grains are exempt: the field is a diffuse cloud on the grid, and
  // a world floats above it.
  for (const h of level.hazards || []) {
    if (h.kind === 'asteroid' || h.x == null) continue;
    const d = Math.hypot(h.x - p.x, h.z - p.z);
    if (Math.abs(d - r) < b.radius + h.radius + BODY_GAP + 0.5) return null;
  }
  const set = Math.min(Math.floor(level.difficulty ? level.difficulty - 1 : 0), 3);
  const base = (SWEEP_DEG[set] * Math.PI) / 180 / 10;
  // inner orbits sweep faster (Kepler-ish), moons faster still
  const kepler = Math.min(Math.max(Math.sqrt(REF_R / Math.max(r, 6)), 0.45), 2.2);
  const omega = base * kepler * (b.moonOf != null ? 2.2 : 1) * scale;
  return {
    parent: pi, cx: p.x, cz: p.z, radius: +r.toFixed(3),
    phase: +Math.atan2(dz, dx).toFixed(4), omega: +omega.toFixed(5),
  };
}

// A planet and its moons move as one rigid system or not at all. Parking a
// moon while its planet keeps orbiting leaves the moon behind in empty space
// and eventually runs the planet straight over it, so freezing either end of
// that relationship freezes the whole system.
function freezeKin(level, frozen) {
  for (let pass = 0; pass < level.bodies.length; pass++) {
    const before = frozen.size;
    level.bodies.forEach((b, i) => {
      if (b.moonOf == null) return;
      if (frozen.has(i)) frozen.add(b.moonOf);
      if (frozen.has(b.moonOf)) frozen.add(i);
    });
    if (frozen.size === before) return;
  }
}

function withOrbits(level, scale, anchors, frozen) {
  const out = { ...level, bodies: level.bodies.map(b => ({ ...b })) };
  for (let i = 0; i < out.bodies.length; i++) {
    const o = orbitFor(level, i, scale, anchors, frozen);
    if (!o) continue;
    delete out.bodies[i].x;
    delete out.bodies[i].z;
    out.bodies[i].orbit = o;
  }
  // pads and stations ride the body they were parked beside — but only if
  // that body actually ended up moving
  const rides = a => a && !!out.bodies[a.body].orbit;
  out.ship = rides(anchors.ship) ? { ...level.ship, anchor: anchors.ship } : level.ship;
  out.goal = rides(anchors.goal) ? { ...level.goal, anchor: anchors.goal } : level.goal;
  if (level.waypoints) {
    out.waypoints = level.waypoints.map((wp, i) =>
      (rides(anchors.waypoints[i]) ? { ...wp, anchor: anchors.waypoints[i] } : wp));
  }
  return out;
}


// Backstop for the geometric check above: moons ride a moving parent, and an
// anchored station must never be swept by a body OTHER than its own.
//
// Everything drawn on the surface is checked against everything else — worlds
// against worlds, worlds against asteroids, worlds against pads and docking
// rings. Checking only worlds-against-stations left moons buried in planets
// and docking rings sitting inside Jupiter. Returns the orbiting bodies
// implicated; empty means the level is clear.
function offenders(level, anchors) {
  const bad = new Set();
  const drawR = drawRadius;
  // Everything the player sees, at time t, with the orbiting bodies each disc
  // depends on. Blaming those is how a collision becomes actionable: freeze
  // the world and the disc stops moving into things.
  const discsAt = t => {
    const ps = bodiesAt(level, t);
    const hs = hazardsAt(level, t);
    const out = [];
    level.bodies.forEach((b, i) => {
      out.push({ x: ps[i].x, z: ps[i].z, r: drawR(b), idx: i, dust: false, target: false, blame: b.orbit ? [i] : [] });
    });
    (level.hazards || []).forEach((h, k) => {
      const p = hs[k];
      if (p) out.push({ x: p.x, z: p.z, r: h.radius, dust: h.kind === 'asteroid', target: false, roving: isRoving(h), blame: [] });
    });
    const station = (spot, r, a, key) => {
      const host = a && level.bodies[a.body].orbit ? a.body : null;
      out.push({
        x: anchorX(host != null ? { ...spot, anchor: a } : spot, ps),
        z: anchorZ(host != null ? { ...spot, anchor: a } : spot, ps),
        r, dust: false, target: true, host, rider: host != null ? key : null,
        blame: host != null ? [host] : [],
      });
    };
    station(level.ship, 3, anchors.ship, 'ship');
    station(level.goal, level.goal.r + 1, anchors.goal, 'goal');
    (level.waypoints || []).forEach((wp, i) => station(wp, wp.r + 1, anchors.waypoints[i], `wp${i}`));
    return out;
  };
  // Collisions a riding station is involved in are reported separately: a
  // station that sweeps into things can simply stop riding, which costs one
  // level a moving pad. Freezing its host world instead stops every planet on
  // the level, which is how belt levels came out completely static.
  const riders = new Set();
  const { T, step } = sweepPlan(level);
  for (let t = 0; t <= T; t += step) {
    const d = discsAt(t);
    for (let i = 0; i < d.length; i++) {
      for (let j = i + 1; j < d.length; j++) {
        const gap = requiredGap(level, d[i], d[j]);
        if (gap === null) continue;
        if (Math.hypot(d[i].x - d[j].x, d[i].z - d[j].z) >= d[i].r + d[j].r + gap) continue;
        if (d[i].rider || d[j].rider) {
          if (d[i].rider) riders.add(d[i].rider);
          if (d[j].rider) riders.add(d[j].rider);
          continue;
        }
        for (const k of d[i].blame) bad.add(k);
        for (const k of d[j].blame) bad.add(k);
      }
    }
  }
  return { bodies: bad, riders };
}

// Coarse solver sweep, identical in shape to solve.js --fast.
function minWinsOf(level) {
  const legs = legCount(level);
  let worst = Infinity;
  for (let leg = 0; leg < legs; leg++) {
    let wins = 0;
    for (let ti = 0; ti < T_SAMPLES; ti++) {
      const t0 = ti * 0.9;
      const start = legStart(level, leg, bodiesAt(level, t0));
      for (let ang = 0; ang < 360; ang += 3) {
        const rad = (ang * Math.PI) / 180;
        for (let sp = 10; sp <= level.maxLaunch; sp += 4) {
          const r = predict(level, start.x, start.z,
            Math.cos(rad) * sp, Math.sin(rad) * sp, t0, HORIZON, leg);
          if (r.outcome === 'goal' || r.outcome === 'waypoint') wins++;
        }
      }
    }
    worst = Math.min(worst, wins);
    if (worst < MIN_WINS) break;
  }
  return worst;
}

function solveLevel(index) {
  const level = LEVELS[index];
  const already = level.bodies.some(b => b.orbit);
  if (already) {
    return { index, scale: null, skipped: 'already moving', bodies: [] };
  }
  const anchors = anchorsFor(level);
  // Resolve geometry in the order that costs the least motion. Slowing an
  // orbit never helps — it only delays the collision — so the choice is which
  // thing stops moving:
  //   1. a station that sweeps into something stops riding its world,
  //   2. only then is a world itself frozen (and its moons with it).
  // Doing (2) first turned whole belt levels static, because one goal riding
  // a planet through the rocks condemned every planet on the level.
  const frozen = new Set();
  for (let pass = 0; pass < 10; pass++) {
    const { bodies: bad, riders } = offenders(withOrbits(level, 1, anchors, frozen), anchors);
    if (!bad.size && !riders.size) break;
    if (riders.size) {
      if (riders.has('ship')) anchors.ship = null;
      if (riders.has('goal')) anchors.goal = null;
      anchors.waypoints = anchors.waypoints.map((a, i) => (riders.has(`wp${i}`) ? null : a));
      continue;                       // re-measure before freezing anything
    }
    bad.forEach(i => frozen.add(i));
    freezeKin(level, frozen);
  }
  for (const scale of BACKOFF) {
    const cand = withOrbits(level, scale, anchors, frozen);
    if (!cand.bodies.some(b => b.orbit)) {
      return { index, scale: null, skipped: 'no orbitable bodies', bodies: [] };
    }
    const off = offenders(cand, anchors);
    if (off.bodies.size || off.riders.size) continue;
    const wins = minWinsOf(cand);
    if (wins >= MIN_WINS) {
      const bodies = cand.bodies.map((b, i) => (b.orbit ? { i, orbit: b.orbit } : null)).filter(Boolean);
      const rides = a => a && bodies.some(x => x.i === a.body);
      return {
        index, scale, minWins: wins, bodies,
        ship: rides(anchors.ship) ? anchors.ship : null,
        goal: rides(anchors.goal) ? anchors.goal : null,
        waypoints: (level.waypoints || []).map((_, i) => (rides(anchors.waypoints[i]) ? anchors.waypoints[i] : null)),
      };
    }
  }
  return { index, scale: 0, skipped: 'stays static (no speed kept it winnable)', bodies: [] };
}

// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];

const applyDir = arg('apply');
if (applyDir) {
  const levels = LEVELS.map(l => ({ ...l, bodies: l.bodies.map(b => ({ ...b })) }));
  let moved = 0, statics = [];
  for (let i = 0; i < levels.length; i++) {
    const f = path.join(applyDir, `orbit-${i}.json`);
    if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
    const r = JSON.parse(fs.readFileSync(f));
    if (!r.bodies.length) { if (r.scale === 0) statics.push(i + 1); continue; }
    for (const { i: bi, orbit } of r.bodies) {
      delete levels[i].bodies[bi].x;
      delete levels[i].bodies[bi].z;
      levels[i].bodies[bi].orbit = orbit;
    }
    if (r.ship) levels[i].ship = { ...levels[i].ship, anchor: r.ship };
    if (r.goal) levels[i].goal = { ...levels[i].goal, anchor: r.goal };
    (r.waypoints || []).forEach((a, wi) => {
      if (a) levels[i].waypoints[wi] = { ...levels[i].waypoints[wi], anchor: a };
    });
    const rid = [r.ship && 'pad', r.goal && 'goal', (r.waypoints || []).filter(Boolean).length && 'stations'].filter(Boolean);
    moved++;
    console.log(`L${String(i + 1).padStart(2)} ${(levels[i].name || '').padEnd(20)} speed ${(r.scale * 100).toFixed(0)}%  min-leg ${String(r.minWins).padStart(3)} wins  riding: ${rid.join('+') || 'none'}`);
  }
  const setsOut = SETS.map(s => ({ name: s.name, difficulty: s.difficulty }));
  let js = `// GravityLoop — level data (50 levels in 5 themed sets of 10).
// GENERATED by tools/generate.js — edit that file and re-run:
//   node tools/generate.js
// Orbits added by tools/orbits.js (per-set speed ramp, solver-verified).
// Coordinates: x is right, z is toward the camera (ship starts at +z).
// mass < 0 makes an antimatter star (a hill instead of a well).

export const SETS = ${JSON.stringify(setsOut, null, 2)};

export const LEVELS = ${JSON.stringify(levels, null, 2)};
`;
  js = js.replace(/"color": (\d+)/g, (_, n) => `"color": 0x${Number(n).toString(16)}`);
  fs.writeFileSync(path.join(HERE, '..', 'src', 'levels.js'), js);
  console.log(`\n${moved} levels set in motion` + (statics.length ? `; left static: ${statics.join(', ')}` : ''));
} else {
  const idx = Number(arg('level'));
  if (!Number.isInteger(idx)) throw new Error('use --level=N or --apply=DIR');
  const r = solveLevel(idx);
  const label = r.skipped || `speed ${(r.scale * 100).toFixed(0)}% of target, min-leg ${r.minWins} wins`;
  console.log(`L${idx + 1} ${LEVELS[idx].name || ''}: ${label}`);
  const out = arg('out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r));
  }
}
