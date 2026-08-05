// Nothing the player sees may sit inside anything else the player sees.
//
//   node tools/overlap-check.mjs [--verbose]
//
// Worlds, asteroids, launch pads, docking rings and the goal are all drawn as
// discs on the gravity surface. Two of them intersecting reads as a rendering
// fault — a moon buried in a planet, a docking ring you cannot fly through
// because a rock fills it. Bodies move, so every pair is checked across a
// sweep of simulation times rather than at t=0 only.
//
// Anchored objects (pads and targets ride a body) are exempt from their own
// anchor body: they are deliberately parked alongside it, kept clear by
// STATION_GAP rather than by the general rule.
import { LEVELS } from '../src/levels.js';
import { bodiesAt, anchorX, anchorZ, hazardsAt } from '../src/physics.js';

const VERBOSE = process.argv.includes('--verbose');
// Simulation seconds sampled per level. Orbits are slow, so a long sweep is
// what actually exercises the geometry; the generator's own annulus checks
// only bound the extremes.
const T_MAX = 240;
const T_STEP = 1.5;
// Clearance required between two drawn discs, in world units.
const GAP = 0.6;
// A station parked beside its own anchor body needs less, but not none.
const STATION_GAP = 0.35;

function bodyDrawRadius(b) {
  return b.type === 'blackhole' ? Math.max(b.radius, b.horizon || 0) : b.radius;
}

// Every drawn disc at simulation time t: {x, z, r, what, anchor}
function discsAt(level, t) {
  const ps = bodiesAt(level, t);
  const out = [];
  level.bodies.forEach((b, i) => {
    out.push({ x: ps[i].x, z: ps[i].z, r: bodyDrawRadius(b), what: `body ${b.name}`, idx: i });
  });
  const hs = hazardsAt ? hazardsAt(level, t) : null;
  (level.hazards || []).forEach((h, k) => {
    const p = hs ? hs[k] : h;
    if (p && p.x != null) {
      out.push({ x: p.x, z: p.z, r: h.radius, what: `${h.kind || 'hazard'} ${k}`, dust: h.kind === 'asteroid' });
    }
  });
  out.push({
    x: anchorX(level.ship, ps), z: anchorZ(level.ship, ps), r: 1.2,
    what: 'launch pad', anchor: level.ship.anchor ? level.ship.anchor.body : null,
  });
  out.push({
    x: anchorX(level.goal, ps), z: anchorZ(level.goal, ps), r: level.goal.r,
    what: 'goal', anchor: level.goal.anchor ? level.goal.anchor.body : null,
  });
  (level.waypoints || []).forEach((w, k) => {
    out.push({
      x: anchorX(w, ps), z: anchorZ(w, ps), r: w.r,
      what: `waypoint ${k}`, anchor: w.anchor ? w.anchor.body : null,
    });
  });
  return out;
}

// A moon and its planet, or two moons of one planet, are drawn as a system:
// they are allowed to be close, but never to intersect. An asteroid field is
// a cloud of grains by design, so grains may sit against one another — but
// nothing else may sit inside one. Returns null when the pair is exempt.
//
// tools/orbits.js applies the same rules when it decides which worlds to
// freeze, so what that tool accepts and what this gate accepts agree.
function requiredGap(level, a, b) {
  if (a.anchor != null && a.anchor === b.idx) return STATION_GAP;
  if (b.anchor != null && b.anchor === a.idx) return STATION_GAP;
  if (a.dust && b.dust) return null;
  if (kin(level, a, b)) return 0;
  return GAP;
}

function kin(level, a, b) {
  if (a.idx == null || b.idx == null) return false;
  const bi = level.bodies[a.idx], bj = level.bodies[b.idx];
  const pi = bi.moonOf != null ? bi.moonOf : (bi.orbit && bi.orbit.parent);
  const pj = bj.moonOf != null ? bj.moonOf : (bj.orbit && bj.orbit.parent);
  return pi === b.idx || pj === a.idx || (pi != null && pi === pj);
}

let worst = [];
for (const [li, level] of LEVELS.entries()) {
  const seen = new Map();      // pair key -> deepest overlap seen
  for (let t = 0; t <= T_MAX; t += T_STEP) {
    const d = discsAt(level, t);
    for (let i = 0; i < d.length; i++) {
      for (let j = i + 1; j < d.length; j++) {
        const req = requiredGap(level, d[i], d[j]);
        if (req === null) continue;
        const gap = Math.hypot(d[i].x - d[j].x, d[i].z - d[j].z) - (d[i].r + d[j].r + req);
        if (gap >= 0) continue;
        const key = `${d[i].what} | ${d[j].what}`;
        const prev = seen.get(key);
        if (!prev || gap < prev.gap) seen.set(key, { gap, t, pair: key });
      }
    }
  }
  for (const v of seen.values()) worst.push({ level: li + 1, name: level.name, ...v });
}

worst.sort((a, b) => a.gap - b.gap);
if (!worst.length) {
  console.log(`No overlaps across ${LEVELS.length} levels, t = 0..${T_MAX}s.`);
  process.exit(0);
}

const byLevel = new Map();
for (const w of worst) byLevel.set(w.level, (byLevel.get(w.level) || 0) + 1);
console.error(`${worst.length} overlapping pair(s) across ${byLevel.size} level(s):\n`);
for (const w of (VERBOSE ? worst : worst.slice(0, 40))) {
  console.error(`  L${String(w.level).padStart(2)} ${w.name.padEnd(18)} ${w.pair}`);
  console.error(`      overlaps by ${(-w.gap).toFixed(2)}u at t=${w.t.toFixed(1)}s`);
}
if (!VERBOSE && worst.length > 40) console.error(`  ... and ${worst.length - 40} more (--verbose)`);
process.exit(1);
