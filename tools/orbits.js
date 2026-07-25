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
import { predict, legStart, legCount, bodiesAt, anchorX, anchorZ } from '../src/physics.js';
import { LEVELS, SETS } from '../src/levels.js';

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
// Which orbiting bodies sweep a pad or station they are not carrying. Empty
// means the level is clear.
function offenders(level, anchors) {
  const bad = new Set();
  const spots = keepOuts(level, anchors);
  const riders = [
    { spot: level.ship, r: 3, own: anchors.ship && anchors.ship.body },
    { spot: level.goal, r: level.goal.r + 1, own: anchors.goal && anchors.goal.body },
    ...(level.waypoints || []).map((wp, i) => ({ spot: wp, r: wp.r + 1, own: anchors.waypoints[i] && anchors.waypoints[i].body })),
  ].filter(x => x.own != null);
  for (let t = 0; t <= 120; t += 0.5) {
    const ps = bodiesAt(level, t);
    for (let i = 0; i < ps.length; i++) {
      const b = level.bodies[i];
      if (!b.orbit) continue;
      for (const s of spots) {
        if (Math.hypot(ps[i].x - s.x, ps[i].z - s.z) < b.radius + s.r) bad.add(i);
      }
      for (const rd of riders) {
        if (rd.own === i) continue;                       // its own host is fine
        const sx = anchorX(rd.spot, ps), sz = anchorZ(rd.spot, ps);
        if (Math.hypot(ps[i].x - sx, ps[i].z - sz) < b.radius + rd.r) bad.add(i);
      }
    }
  }
  return bad;
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
  // Freeze the specific bodies that would sweep a pad or station — slowing
  // them down never helps, it only delays the collision.
  const frozen = new Set();
  for (let pass = 0; pass < 8; pass++) {
    const bad = offenders(withOrbits(level, 1, anchors, frozen), anchors);
    if (!bad.size) break;
    bad.forEach(i => frozen.add(i));
  }
  for (const scale of BACKOFF) {
    const cand = withOrbits(level, scale, anchors, frozen);
    if (!cand.bodies.some(b => b.orbit)) {
      return { index, scale: null, skipped: 'no orbitable bodies', bodies: [] };
    }
    if (offenders(cand, anchors).size) continue;
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
