// Headless level checker: brute-forces launch angle/power (and release time for
// levels with moving bodies) through the real physics to verify each level is
// winnable and estimate difficulty. Run: node tools/solve.js [levelIndex]
import { predict } from '../src/physics.js';
import { LEVELS } from '../src/levels.js';

const only = process.argv[2] != null ? Number(process.argv[2]) : null;

for (let li = 0; li < LEVELS.length; li++) {
  if (only != null && li !== only) continue;
  const level = LEVELS[li];
  const dynamic = level.bodies.some(b => b.orbit);
  const times = dynamic ? range(0, 9, 0.45) : [0];
  const angles = range(0, 360, 1.5);
  const speeds = range(10, level.maxLaunch, 2);

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
  console.log(
    `L${li + 1} ${level.name.padEnd(16)} wins ${String(wins).padStart(4)}/${total} (${pct}%)` +
    (best ? `  best: ang=${best.ang}° v=${best.sp} t0=${best.t0.toFixed(2)} flight=${best.time.toFixed(1)}s` : '  *** UNSOLVABLE ***')
  );
}

function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(v);
  return out;
}
