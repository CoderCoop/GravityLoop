// Can a route in this campaign actually wrap a world?
//
//   node tools/flyby-check.mjs
//
// A ship only comes round a body if that body can bend it. For a hyperbolic
// flyby the deflection is
//
//     sin(d/2) = 1 / (1 + r_p * v_inf^2 / (G m))
//
// so the whole question is the dimensionless group  B = r_p v^2 / (G m)  at
// closest approach: B near 0 wraps the ship right round, B >> 1 barely nudges
// it. This measures B on the laziest winning route of every level, against the
// bodies it actually passes, and reports the deflection that implies — plus
// what the body's mass would have to be for a half turn.
//
// The point is to decide whether wrapping trajectories are reachable by moving
// things around, or whether the masses and distances rule them out no matter
// where anything is placed.
import { LEVELS } from '../src/levels.js';
import { predict, legStart, legCount, bodiesAt, G } from '../src/physics.js';

const dynamic = lv => lv.bodies.some(b => b.orbit) ||
  (lv.hazards || []).some(h => h.orbit || h.patrol || h.comet);

// deflection of a hyperbolic flyby with impact parameter implied by periapsis
const deflect = B => 2 * Math.asin(1 / (1 + Math.max(B, 1e-9)));

function laziest(lv, stage) {
  const times = dynamic(lv) ? Array.from({ length: 11 }, (_, i) => i * 0.9) : [0];
  let best = null;
  for (const t0 of times) {
    const s = legStart(lv, stage, bodiesAt(lv, t0));
    for (let ang = 0; ang < 360; ang += 3) {
      const rad = (ang * Math.PI) / 180;
      for (let sp = 10; sp <= lv.maxLaunch; sp += 4) {
        const r = predict(lv, s.x, s.z, Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12, stage);
        if (r.outcome !== 'goal' && r.outcome !== 'waypoint') continue;
        let turn = 0;
        for (let k = 2; k < r.points.length; k++) {
          const a = r.points[k - 2], b = r.points[k - 1], c = r.points[k];
          let d = Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x);
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          turn += Math.abs(d);
        }
        if (!best || turn < best.turn) best = { turn, pts: r.points, t0 };
      }
    }
  }
  return best;
}

const rows = [];
for (const [i, lv] of LEVELS.entries()) {
  let bestDefl = 0, bestName = '', bestB = Infinity, bestNeed = 0;
  for (let stage = 0; stage < legCount(lv); stage++) {
    const w = laziest(lv, stage);
    if (!w) continue;
    // speed along the path, sampled from consecutive points
    for (let bi = 0; bi < lv.bodies.length; bi++) {
      const b = lv.bodies[bi];
      if (b.mass <= 0) continue;
      let rp = Infinity, vAt = 0;
      for (let k = 1; k < w.pts.length; k++) {
        const p = w.pts[k], q = w.pts[k - 1];
        const t = p.t != null ? p.t : 0;
        const ps = bodiesAt(lv, (w.t0 || 0) + t)[bi];
        const d = Math.hypot(p.x - ps.x, p.z - ps.z);
        if (d < rp) {
          rp = d;
          const dt = (p.t != null && q.t != null) ? (p.t - q.t) : 1 / 40;
          vAt = Math.hypot(p.x - q.x, p.z - q.z) / Math.max(dt, 1e-6);
        }
      }
      if (!isFinite(rp) || rp > b.radius + 40) continue;
      const B = (rp * vAt * vAt) / (G * b.mass);
      const d = deflect(B);
      if (d > bestDefl) {
        bestDefl = d; bestName = b.name; bestB = B;
        // mass needed at this speed and periapsis for a half turn (B = 1)
        bestNeed = (rp * vAt * vAt) / G;
      }
    }
  }
  rows.push({ n: i + 1, name: lv.name, defl: bestDefl, body: bestName, B: bestB, need: bestNeed,
    mass: (LEVELS[i].bodies.find(b => b.name === bestName) || {}).mass || 0 });
  process.stderr.write(`\r  ${i + 1}/50`);
}
process.stderr.write('\n');

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('  #  level                best flyby      B      deflection   mass now -> needed for 180 deg');
for (const r of rows.slice(0, 14)) {
  console.log(`${String(r.n).padStart(3)}  ${r.name.padEnd(20)} ${r.body.padEnd(10)} ${r.B.toFixed(1).padStart(7)}  ${(r.defl * 180 / Math.PI).toFixed(0).padStart(5)} deg   ${String(r.mass).padStart(6)} -> ${r.need.toFixed(0)}`);
}
console.log(`\nmedian deflection available ${(med(rows.map(r => r.defl)) * 180 / Math.PI).toFixed(0)} deg`);
console.log(`median B ${med(rows.map(r => r.B)).toFixed(1)}  (B=1 gives 60 deg, B=0.15 gives 120 deg, B->0 wraps)`);
const ratio = rows.filter(r => r.mass > 0).map(r => r.need / r.mass);
console.log(`mass multiple needed for a half-turn: median ${med(ratio).toFixed(1)}x`);
console.log(`levels where a >=180 deg bend is already available: ${rows.filter(r => r.defl >= Math.PI).length}/50`);
