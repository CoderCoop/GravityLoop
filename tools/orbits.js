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
import { predict, legStart, legCount, bodiesAt } from '../src/physics.js';
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

// Orbit for body i of `level`, or null if it should stay put.
function orbitFor(level, i, scale) {
  const b = level.bodies[i];
  if (b.orbit || isSun(b) || i === 0) return null;
  const pi = b.moonOf != null ? b.moonOf : 0;
  const p = level.bodies[pi];
  if (!p || p.x == null) return null;
  const dx = b.x - p.x, dz = b.z - p.z;
  const r = Math.hypot(dx, dz);
  if (r < 1) return null;
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

function withOrbits(level, scale) {
  const out = { ...level, bodies: level.bodies.map(b => ({ ...b })) };
  for (let i = 0; i < out.bodies.length; i++) {
    const o = orbitFor(level, i, scale);
    if (!o) continue;
    delete out.bodies[i].x;
    delete out.bodies[i].z;
    out.bodies[i].orbit = o;
  }
  return out;
}

// No body may sweep over the pad, a waypoint or the goal during a flight.
function keepsClear(level) {
  const spots = [{ x: level.ship.x, z: level.ship.z, r: 3 },
                 { x: level.goal.x, z: level.goal.z, r: level.goal.r + 1 }];
  for (const wp of level.waypoints || []) spots.push({ x: wp.x, z: wp.z, r: wp.r + 1 });
  for (let t = 0; t <= 40; t += 0.5) {
    const ps = bodiesAt(level, t);
    for (let i = 0; i < ps.length; i++) {
      const b = level.bodies[i];
      if (!b.orbit) continue;
      for (const s of spots) {
        if (Math.hypot(ps[i].x - s.x, ps[i].z - s.z) < b.radius + s.r) return false;
      }
    }
  }
  return true;
}

// Coarse solver sweep, identical in shape to solve.js --fast.
function minWinsOf(level) {
  const legs = legCount(level);
  let worst = Infinity;
  for (let leg = 0; leg < legs; leg++) {
    const start = legStart(level, leg);
    let wins = 0;
    for (let ti = 0; ti < T_SAMPLES; ti++) {
      const t0 = ti * 0.9;
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
  for (const scale of BACKOFF) {
    const cand = withOrbits(level, scale);
    if (!cand.bodies.some(b => b.orbit)) {
      return { index, scale: null, skipped: 'no orbitable bodies', bodies: [] };
    }
    if (!keepsClear(cand)) continue;
    const wins = minWinsOf(cand);
    if (wins >= MIN_WINS) {
      const bodies = cand.bodies.map((b, i) => (b.orbit ? { i, orbit: b.orbit } : null)).filter(Boolean);
      return { index, scale, minWins: wins, bodies };
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
    moved++;
    console.log(`L${String(i + 1).padStart(2)} ${(levels[i].name || '').padEnd(20)} speed ${(r.scale * 100).toFixed(0)}% of target  min-leg ${r.minWins} wins`);
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
