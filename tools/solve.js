// Headless level checker: brute-forces launch angle/power (and release time
// for levels with moving bodies or patrols) through the real physics, leg by
// leg, to verify each level is winnable and estimate difficulty. Exits
// nonzero if any leg of any level is unsolvable.
//
//   node tools/solve.js [--fast] [levelIndex]
//
// --fast uses the coarse grid (the one CI and the generator use); the default
// fine grid is ~8x slower but gives smoother difficulty estimates.
import { predict, legStart, legCount } from '../src/physics.js';
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
  const dynamic = level.bodies.some(b => b.orbit) ||
    (level.hazards || []).some(h => h.orbit || h.patrol);
  const times = dynamic ? range(0, 9, T_STEP) : [0];
  const angles = range(0, 360 - ANG_STEP, ANG_STEP);
  const speeds = range(10, level.maxLaunch, SP_STEP);
  const legs = legCount(level);

  let minRate = Infinity, minWins = Infinity, dead = false;
  for (let leg = 0; leg < legs; leg++) {
    const start = legStart(level, leg);
    let total = 0, wins = 0;
    for (const t0 of times) {
      for (const ang of angles) {
        const rad = (ang * Math.PI) / 180;
        for (const sp of speeds) {
          total++;
          const r = predict(level, start.x, start.z,
            Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12, leg);
          if (r.outcome === 'goal' || r.outcome === 'waypoint') wins++;
        }
      }
    }
    minRate = Math.min(minRate, (wins / total) * 100);
    minWins = Math.min(minWins, wins);
    if (wins === 0) dead = true;
  }
  const set = SETS[Math.floor(li / 10)] || { difficulty: 0 };
  const stars = '★'.repeat(set.difficulty);
  console.log(
    `L${String(li + 1).padStart(2)} ${stars.padEnd(5)} ${(level.name || '?').padEnd(20)} legs ${legs}  min-leg ${minRate.toFixed(2)}% (${minWins} wins)` +
    (dead ? '  *** UNSOLVABLE ***' : '')
  );
  if (dead) unsolvable++;
}

if (unsolvable > 0) {
  console.error(`\n${unsolvable} level(s) have an unsolvable leg — failing.`);
  process.exitCode = 1;
}

function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(v);
  return out;
}
