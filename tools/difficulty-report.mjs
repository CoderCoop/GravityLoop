// What the shipped campaign actually demands of a player.
//
// The generator reports these numbers while it searches, but a level goes
// through two more stages after that — orbits.js sets everything moving and
// targets.js shrinks the docking rings, each re-solving and backing off where
// a level would otherwise become unwinnable. So the numbers the generator
// printed are not the numbers that ship. This measures the file as shipped.
//
//   node tools/difficulty-report.mjs [--json]
//
// Per level: how far the straightest winning route has to bend, how many
// worlds it passes that are neither the one it launches from nor the one it
// is aiming at, and whether ANY route reaches the goal without stealing from
// something on the way ("direct"). A level with no direct route cannot be
// brute-forced at any engine power.
import { LEVELS } from '../src/levels.js';
import { predict, legStart, legCount, bodiesAt } from '../src/physics.js';

const arg = k => process.argv.includes(k);

function isEnd(level, key, i, b) {
  const end = level[key];
  return end != null && (i === end || b.moonOf === end);
}

// Where a body sits at time t, as a disc the route can pass close to.
function discAt(level, i, t) {
  const ps = bodiesAt(level, t);
  return { x: ps[i].x, z: ps[i].z, r: level.bodies[i].radius };
}

// The same search grid solve.js uses, and for the same reason: a claim about
// the shipped levels has to be measured the way the gate measures them. A
// coarser sweep here (10 seconds of flight instead of 12, one launch time
// instead of ten, a pad that does not ride its planet) found no winners at all
// on two levels CI had just certified winnable — and a level with no winners
// looks identical to a level with no direct route unless you say so.
const dynamicLevel = level => level.bodies.some(b => b.orbit) ||
  (level.hazards || []).some(h => h.orbit || h.patrol || h.comet);

function legReport(level, stage) {
  const times = dynamicLevel(level) ? Array.from({ length: 11 }, (_, i) => i * 0.9) : [0];
  let minTurn = Infinity, bestVia = 0, direct = false, assisted = false;
  let wins = 0;
  for (const t0 of times) {
    const start = legStart(level, stage, bodiesAt(level, t0));
    for (let ang = 0; ang < 360; ang += 3) {
    const rad = (ang * Math.PI) / 180;
    for (let sp = 10; sp <= level.maxLaunch; sp += 4) {
      const r = predict(level, start.x, start.z, Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12, stage);
      if (r.outcome !== 'goal' && r.outcome !== 'waypoint') continue;
      wins++;
      // total absolute turning along the path
      let turn = 0;
      for (let k = 2; k < r.points.length; k++) {
        const a = r.points[k - 2], b = r.points[k - 1], c = r.points[k];
        const h1 = Math.atan2(b.z - a.z, b.x - a.x), h2 = Math.atan2(c.z - b.z, c.x - b.x);
        let d = h2 - h1;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        turn += Math.abs(d);
      }
      let via = 0;
      for (let bi = 0; bi < level.bodies.length; bi++) {
        const b = level.bodies[bi];
        if (isEnd(level, 'homeIdx', bi, b) || isEnd(level, 'targetIdx', bi, b)) continue;
        for (let k = 0; k < r.points.length; k += 4) {
          const p = r.points[k];
          const d = discAt(level, bi, p.t != null ? p.t : 0);
          if (Math.hypot(p.x - d.x, p.z - d.z) < d.r + 8) { via++; break; }
        }
      }
      if (via > 0) assisted = true; else direct = true;
      if (turn < minTurn) { minTurn = turn; bestVia = via; }
    }
    }
  }
  return { wins, minTurn: minTurn === Infinity ? 0 : minTurn, via: bestVia, direct, assisted };
}

const rows = LEVELS.map((lv, i) => {
  const legs = legCount(lv);
  const per = [];
  for (let s = 0; s < legs; s++) per.push(legReport(lv, s));
  return {
    n: i + 1, name: lv.name, legs,
    turn: +per.reduce((a, p) => a + p.minTurn, 0).toFixed(2),
    via: per.reduce((a, p) => a + p.via, 0),
    // a level is brute-forceable only if EVERY leg has a direct win
    forced: per.every(p => p.wins > 0) && !per.every(p => p.direct),
    // no route found at this grid resolution: says nothing about the level,
    // only about the sweep, and must never be counted as a hard level
    unmeasured: per.some(p => p.wins === 0),
    fuel: lv.fuel, maxLaunch: lv.maxLaunch,
  };
});

if (arg('--json')) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  console.log('  #  level                legs  turn  via  gravity assist');
  for (const r of rows) {
    console.log(
      `${String(r.n).padStart(3)}  ${r.name.padEnd(20)} ${String(r.legs).padStart(4)}  ` +
      `${r.turn.toFixed(2).padStart(5)} ${String(r.via).padStart(4)}  ` +
      `${r.unmeasured ? 'no route found' : r.forced ? 'REQUIRED' : 'optional'}`
    );
  }
  const seen = rows.filter(r => !r.unmeasured);
  const forced = seen.filter(r => r.forced).length;
  const viaAny = seen.filter(r => r.via > 0).length;
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`\n${forced}/${seen.length} measured levels cannot be won by any direct shot at any engine power`);
  console.log(`${viaAny}/${seen.length} have the straightest winning route pass a third-party world`);
  console.log(`median turning ${med(seen.map(r => r.turn)).toFixed(2)} rad, median worlds passed ${med(seen.map(r => r.via))}`);
  if (rows.length !== seen.length) {
    console.log(`${rows.length - seen.length} level(s) found no route at this grid and are excluded: ` +
      rows.filter(r => r.unmeasured).map(r => `${r.n} ${r.name}`).join(', '));
  }
}
