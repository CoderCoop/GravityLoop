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
import { sweepPlan, requiredGap, drawRadius } from './sweep.mjs';

const VERBOSE = process.argv.includes('--verbose');


// Every drawn disc at simulation time t: {x, z, r, what, anchor}
function discsAt(level, t) {
  const ps = bodiesAt(level, t);
  const out = [];
  level.bodies.forEach((b, i) => {
    out.push({ x: ps[i].x, z: ps[i].z, r: drawRadius(b), what: `body ${b.name}`, idx: i, dust: false, target: false });
  });
  const hs = hazardsAt ? hazardsAt(level, t) : null;
  (level.hazards || []).forEach((h, k) => {
    const p = hs ? hs[k] : h;
    if (p && p.x != null) {
      out.push({ x: p.x, z: p.z, r: h.radius, what: `${h.kind || 'hazard'} ${k}`, dust: h.kind === 'asteroid', target: false });
    }
  });
  out.push({
    x: anchorX(level.ship, ps), z: anchorZ(level.ship, ps), r: 1.2, dust: false, target: true,
    what: 'launch pad', host: level.ship.anchor ? level.ship.anchor.body : null,
  });
  out.push({
    x: anchorX(level.goal, ps), z: anchorZ(level.goal, ps), r: level.goal.r, dust: false, target: true,
    what: 'goal', host: level.goal.anchor ? level.goal.anchor.body : null,
  });
  (level.waypoints || []).forEach((w, k) => {
    out.push({
      x: anchorX(w, ps), z: anchorZ(w, ps), r: w.r, dust: false, target: true,
      what: `waypoint ${k}`, host: w.anchor ? w.anchor.body : null,
    });
  });
  return out;
}

let worst = [];
for (const [li, level] of LEVELS.entries()) {
  const seen = new Map();      // pair key -> deepest overlap seen
  const { T, step } = sweepPlan(level);
  for (let t = 0; t <= T; t += step) {
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
  console.log(`No overlaps across ${LEVELS.length} levels, each swept over its slowest full orbital period.`);
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
