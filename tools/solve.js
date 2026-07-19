// Headless level checker: brute-forces launch angle/power (and release time for
// levels with moving bodies) through the real physics to verify each level is
// winnable and estimate difficulty. Exits nonzero if any level is unsolvable.
//
//   node tools/solve.js [--fast] [levelIndex]
//
// --fast uses the coarse grid (the one CI and the generator use); the default
// fine grid is ~8x slower but gives smoother difficulty estimates.
import { predict } from '../src/physics.js';
import { LEVELS, SETS } from '../src/levels.js';

const args = process.argv.slice(2).filter(a => a !== '--fast');
const fast = process.argv.includes('--fast');
const only = args[0] != null ? Number(args[0]) : null;

const ANG_STEP = fast ? 3 : 1.5;
const SP_STEP = fast ? 4 : 2;
const T_STEP = fast ? 0.9 : 0.45;

let unsolvable = 0;

for (let li = 0; li < LEVELS.length; li++) {
  if (only != null && li !== only) continue;
  const level = LEVELS[li];
  const dynamic = level.bodies.some(b => b.orbit);
  const times = dynamic ? range(0, 9, T_STEP) : [0];
  const angles = range(0, 360 - ANG_STEP, ANG_STEP);
  const speeds = range(10, level.maxLaunch, SP_STEP);

  let total = 0, wins = 0;
  let best = null;
  for (const t0 of times) {
    for (const ang of angles) {
      const rad = (ang * Math.PI) / 180;
      for (const sp of speeds) {
        total++;
        const r = predict(level, level.ship.x, level.ship.z,
          Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12);
        if (r.outcome === 'goal') {
          wins++;
          if (!best || r.time < best.time) best = { ang, sp, t0, time: r.time };
        }
      }
    }
  }
  const pct = ((wins / total) * 100).toFixed(2);
  const set = SETS[Math.floor(li / 10)] || { difficulty: 0 };
  const stars = '★'.repeat(set.difficulty);
  console.log(
    `L${String(li + 1).padStart(2)} ${stars.padEnd(5)} ${(level.name || '?').padEnd(20)} wins ${String(wins).padStart(4)}/${total} (${pct}%)` +
    (best ? `  best: ang=${best.ang}° v=${best.sp} t0=${best.t0.toFixed(2)} flight=${best.time.toFixed(1)}s` : '  *** UNSOLVABLE ***')
  );
  if (!best) unsolvable++;
}

if (unsolvable > 0) {
  console.error(`\n${unsolvable} level(s) have no ballistic solution — failing.`);
  process.exitCode = 1;
}

function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(v);
  return out;
}
