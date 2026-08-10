// Can a route in this campaign actually wrap a world?
//
//   node tools/flyby-check.mjs
//
// A ship only comes round a body if that body can bend it. For a hyperbolic
// flyby the deflection is
//
//     sin(d/2) = 1 / (1 + B),      B = r_p * v_inf^2 / (G m)
//
// and the speed that belongs in B is the *approach* speed, not the speed at
// closest approach — those differ by exactly the well the ship fell down:
//
//     v_p^2 = v_inf^2 + 2 G m / r_p     =>    r_p v_p^2 / (G m) = B + 2
//
// so measuring with the local speed inflates B by 2 and makes every flyby look
// far weaker than it is. This measures B properly, on the laziest winning route
// of every level, against the bodies it actually passes.
//
// v_inf^2 <= 0 means the ship is *bound* to that body as it goes by: it is on a
// closed arc around it and a full wrap is available, which is the thing the
// campaign wants and cannot get from any hyperbola.
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

// Home and target are not flybys. The ship launches from beside one and docks
// beside the other, so it passes both on every route and is all but bound to
// the target as it arrives — counting them makes a trivial docking look like a
// wrap. Only third-party worlds say anything about the route.
function isEnd(lv, key, i, b) {
  const end = lv[key];
  if (end == null) return false;
  return i === end || b.moonOf === end || (b.orbit && b.orbit.parent === end);
}

// velocity of body bi at time t, by central difference on the orbit
function bodyVel(lv, bi, t) {
  const h = 1 / 60;
  const a = bodiesAt(lv, Math.max(t - h, 0))[bi], c = bodiesAt(lv, t + h)[bi];
  const dt = t - h < 0 ? h : 2 * h;
  return { x: (c.x - a.x) / dt, z: (c.z - a.z) / dt };
}

const rows = [];
for (const [i, lv] of LEVELS.entries()) {
  let bestDefl = 0, bestName = '', bestB = Infinity, bestNeed = 0, bound = false;
  for (let stage = 0; stage < legCount(lv); stage++) {
    const w = laziest(lv, stage);
    if (!w) continue;
    for (let bi = 0; bi < lv.bodies.length; bi++) {
      const b = lv.bodies[bi];
      if (b.mass <= 0) continue;
      if (isEnd(lv, 'homeIdx', bi, b) || isEnd(lv, 'targetIdx', bi, b)) continue;
      // closest approach, and the ship's speed there *relative to the body*
      let rp = Infinity, vRel = 0;
      for (let k = 1; k < w.pts.length; k++) {
        const p = w.pts[k], q = w.pts[k - 1];
        const t = (w.t0 || 0) + (p.t != null ? p.t : 0);
        const ps = bodiesAt(lv, t)[bi];
        const d = Math.hypot(p.x - ps.x, p.z - ps.z);
        if (d < rp) {
          rp = d;
          const dt = (p.t != null && q.t != null) ? (p.t - q.t) : 1 / 40;
          const bv = bodyVel(lv, bi, t);
          vRel = Math.hypot((p.x - q.x) / Math.max(dt, 1e-6) - bv.x,
                            (p.z - q.z) / Math.max(dt, 1e-6) - bv.z);
        }
      }
      if (!isFinite(rp) || rp > b.radius + 40) continue;
      // strip the well the ship fell down to recover the approach speed
      const vInf2 = vRel * vRel - (2 * G * b.mass) / Math.max(rp, 1e-6);
      if (vInf2 <= 0) { bound = true; bestDefl = Math.PI * 2; bestName = b.name; bestB = 0; bestNeed = 0; continue; }
      const B = (rp * vInf2) / (G * b.mass);
      const d = deflect(B);
      if (!bound && d > bestDefl) {
        bestDefl = d; bestName = b.name; bestB = B;
        bestNeed = (rp * vInf2) / G; // mass for a 60 deg bend (B = 1)
      }
    }
  }
  rows.push({ n: i + 1, name: lv.name, defl: bestDefl, body: bestName, B: bestB, need: bestNeed, bound,
    mass: (LEVELS[i].bodies.find(b => b.name === bestName) || {}).mass || 0 });
  process.stderr.write(`\r  ${i + 1}/50`);
}
process.stderr.write('\n');

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const deg = r => r.bound ? 'wrap' : `${(r.defl * 180 / Math.PI).toFixed(0)} deg`;
console.log('  #  level                best flyby        B     deflection   mass now -> needed for 120 deg');
for (const r of rows.slice(0, 14)) {
  const need120 = r.need / 0.1547; // B = 0.1547 gives a 120 deg bend
  console.log(`${String(r.n).padStart(3)}  ${r.name.padEnd(20)} ${r.body.padEnd(10)} ${r.B.toFixed(2).padStart(7)}  ${deg(r).padStart(8)}   ${String(r.mass).padStart(6)} -> ${r.bound ? '-' : need120.toFixed(0)}`);
}
const free = rows.filter(r => !r.bound);
console.log(`\nmedian deflection available ${(med(free.map(r => r.defl)) * 180 / Math.PI).toFixed(0)} deg`);
console.log(`median B ${med(free.map(r => r.B)).toFixed(2)}  (B=1 gives 60 deg, B=0.155 gives 120 deg, B=0 is the hyperbolic limit)`);
const r120 = free.filter(r => r.mass > 0).map(r => (r.need / 0.1547) / r.mass);
console.log(`mass multiple needed for a 120 deg bend: median ${med(r120).toFixed(1)}x`);
console.log(`levels with a >=120 deg bend already available: ${rows.filter(r => r.defl >= Math.PI * 2 / 3).length}/50`);
console.log(`levels where the route is BOUND to a world at closest approach (a full wrap is on): ${rows.filter(r => r.bound).length}/50`);
