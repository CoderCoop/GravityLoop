// GravityLoop — level generator.
// Samples themed levels with a seeded RNG, keeps only candidates whose every
// leg the brute-force solver confirms is winnable inside the set's difficulty
// band, then writes the full 50-level roster to src/levels.js.
//
//   node tools/generate.js
//
// Deterministic: same seeds -> same levels.
//
// Campaign: the game starts at Earth and works outward —
//   set 1 Earthrise        launch from Earth to the Moon, Venus, Mars (static)
//   set 2 Inner System     Mercury..Mars around a heavy Sun (static)
//   set 3 Outer Planets    gas giants + moons, station routes (static)
//   set 4 Asteroid Belt    rock fields, cargo hauls, patrol lanes
//   set 5 New Star Systems alien suns, antimatter stars, black holes (moving)
import { predict, legStart, legCount, launchFuelCost, bodiesAt } from '../src/physics.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, a, b) => a + rng() * (b - a);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const sign = rng => (rng() < 0.5 ? -1 : 1);
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// ---------------------------------------------------------------------------
// Coarse per-leg solver (same grid CI uses via `solve.js --fast`)
// ---------------------------------------------------------------------------
function isDynamic(level) {
  return level.bodies.some(b => b.orbit) ||
    (level.hazards || []).some(h => h.orbit || h.patrol || h.comet);
}

// Heading change along a trajectory, both ways of counting it:
//   abs — total turning regardless of direction: ~0 for a straight shot,
//         ~pi for a strong slingshot curve, ~2pi for a full loop.
//   net — signed total. A loop keeps net ~= abs; an S-curve that bends one
//         way and then back cancels out to a small net despite a large abs.
// The pair is what separates one route shape from another, so levels in a
// set can be made to demand genuinely different flying instead of all
// converging on "bend as hard as possible".
function pathTurning(pts) {
  let abs = 0, net = 0, pang = 0, have = false;
  let px = pts[0].x, pz = pts[0].z;
  for (let i = 4; i < pts.length; i += 4) {
    const dx = pts[i].x - px, dz = pts[i].z - pz;
    if (dx * dx + dz * dz < 1e-6) continue;
    const a = Math.atan2(dz, dx);
    if (have) {
      let d = a - pang;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      abs += Math.abs(d);
      net += d;
    }
    pang = a; have = true;
    px = pts[i].x; pz = pts[i].z;
  }
  return { abs, net: Math.abs(net) };
}

// Route shapes a level can be built to demand. Slots cycle through these so
// consecutive levels in a set cannot all be solved the same way — the
// complaint that levels 1-3 play as one level with the furniture moved.
//   arc    a single sustained bend
//   sling  a hard slingshot past something heavy
//   loop   most of a revolution around a body
//   ess    bends one way then back the other
//   cruise a long route that keeps meeting new terrain
// Thresholds are in radians of heading change and are what a set-1 layout can
// actually deliver — measured, not guessed. A first pass asked set 1 for 4.2
// radians of loop and missed by 5+ on every candidate, which just burns the
// search budget that the other shapes need. SHAPE_RAMP scales these up for
// the later sets, where the layouts can support it.
const SHAPES = {
  arc: { absLo: 1.0, absHi: 2.8, netLo: 0.75, interest: 1.0 },
  sling: { absLo: 2.2, absHi: 4.4, netLo: 0.7, interest: 1.0 },
  loop: { absLo: 4.6, absHi: 99, netLo: 0.78, interest: 1.0 },
  ess: { absLo: 2.6, absHi: 99, netHi: 0.45, interest: 1.0 },
  cruise: { absLo: 1.8, absHi: 99, netLo: 0.0, interest: 2.0 },
};
// Which shape each slot of a set must satisfy. Rotated by set so the same
// slot number is not the same shape campaign-wide.
const SHAPE_ORDER = ['arc', 'sling', 'ess', 'loop', 'cruise', 'sling', 'arc', 'loop', 'ess', 'cruise'];
// How much of whatever shape it asks for each set demands. Scaled to the
// turning its geometry can actually produce, measured: sets 1-4 come in at
// 1.2-2.6 radians on a single-leg level, set 5 at 0.29-0.73 because it flies
// from open space to open space with no pair of wells to wrap around.
//
// This used to ramp monotonically to 1.6 at set 5, which asked the set with the
// LEAST curvature for the most: its slots were told to fly an S-curve of 4.2
// radians and missed by 8.35. A shape target the geometry cannot reach is not a
// difficulty setting, it is a guaranteed relaxation — and a relaxed rung asks
// for nothing at all.
const SHAPE_RAMP = [1, 1.1, 1.25, 1.1, 0.85];
function shapeFor(setIdx, slot) {
  const base = SHAPES[SHAPE_ORDER[(slot + setIdx) % SHAPE_ORDER.length]];
  const k = SHAPE_RAMP[Math.min(setIdx, SHAPE_RAMP.length - 1)];
  return { ...base, absLo: +(base.absLo * k).toFixed(2), absHi: base.absHi > 90 ? base.absHi : +(base.absHi * k).toFixed(2) };
}

// How far a winning route strays from the shape asked for. Zero when it fits.
function shapeMiss(shape, t) {
  let miss = 0;
  if (t.abs < shape.absLo) miss += (shape.absLo - t.abs) * 3;
  if (t.abs > shape.absHi) miss += (t.abs - shape.absHi) * 0.6;
  const ratio = t.abs > 1e-6 ? t.net / t.abs : 1;
  if (shape.netLo != null && ratio < shape.netLo) miss += (shape.netLo - ratio) * 4;
  if (shape.netHi != null && ratio > shape.netHi) miss += (ratio - shape.netHi) * 4;
  return miss;
}

// Is body `bi` one of the level's two ends — the world the pad sits on, or the
// one the goal orbits — or a moon of it?
//
// The `!= null` guard is the whole point. Alien levels put the pad and goal at
// free points in space and never set homeIdx/targetIdx, so the obvious
// `b.moonOf === level.homeIdx` compared undefined to undefined and came out
// TRUE for every planet that is not a moon. On set 5 that made every world
// count as home: pad and goal clearance collapsed from 14/11 units to 3, and
// no route could ever be credited with passing a third-party world.
function isEnd(level, key, bi, b) {
  const end = level[key];
  if (end == null) return false;
  // Kinship is recorded two ways: the Sol sets park a static moon beside its
  // planet with `moonOf`, while alien moons genuinely orbit theirs and say so
  // with `orbit.parent`. Checking only the first made a home world's own moon
  // count as a stranger, so a pad tucked beside its planet was rejected for
  // being too close to the moon going round it.
  return bi === end || b.moonOf === end || (b.orbit && b.orbit.parent === end);
}

function solveLeg(level, stage, shape) {
  const dynamic = isDynamic(level);
  const times = dynamic ? Array.from({ length: 11 }, (_, i) => i * 0.9) : [0];
  const start = legStart(level, stage);
  let wins = 0, total = 0;
  const byT0 = dynamic ? new Array(times.length).fill(0) : null;
  const winners = [];
  const turns = [];
  const misses = [];
  let cheapAssist = Infinity, cheapDirect = Infinity;
  for (let ti = 0; ti < times.length; ti++) {
    const t0 = times[ti];
    for (let ang = 0; ang < 360; ang += 3) {
      const rad = (ang * Math.PI) / 180;
      for (let sp = 10; sp <= level.maxLaunch; sp += 4) {
        total++;
        const r = predict(level, start.x, start.z,
          Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 10, stage);
        if (r.outcome === 'goal' || r.outcome === 'waypoint') {
          wins++;
          if (byT0) byT0[ti]++;
          const turn = pathTurning(r.points);
          turns.push(turn.abs);
          if (shape) misses.push(shapeMiss(shape, turn));
          // Did this route steal from a world ON THE WAY, or just leave home and
          // arrive? The home world and the target are touched by every route
          // trivially - the pad sits on one and the goal beside the other - so
          // counting them made every level look like it already forced an
          // assist, and the engine cap never fired. Only worlds passed in
          // between count.
          let wells = 0, via = 0;
          for (let bi = 0; bi < level.bodies.length; bi++) {
            const an = annulus(level, bi);
            for (let k = 0; k < r.points.length; k += 4) {
              if (pointToAnnulus(an, r.points[k].x, r.points[k].z) < level.bodies[bi].radius + 8) {
                wells++;
                const b = level.bodies[bi];
                const home = isEnd(level, 'homeIdx', bi, b);
                const tgt = isEnd(level, 'targetIdx', bi, b);
                if (!home && !tgt) via++;
                break;
              }
            }
          }
          if (via > 0) cheapAssist = Math.min(cheapAssist, sp);
          else cheapDirect = Math.min(cheapDirect, sp);
          if (winners.length < 40) winners.push({ ang, sp, t0, turn: turn.abs, wells });
        }
      }
    }
  }
  turns.sort((a, b) => a - b);
  const minTurn = turns.length ? turns[0] : 0;
  const medTurn = turns.length ? turns[Math.floor(turns.length / 2)] : 0;
  // The player finds the easiest way through, so the route that fits the
  // level's shape best is what decides whether the level really has that
  // shape — but every winner still has to bend (minTurn), or a straight shot
  // sneaks past.
  misses.sort((a, b) => a - b);
  const shapeFit = misses.length ? misses[0] : Infinity;
  return { wins, rate: (wins / total) * 100, byT0, winners, minTurn, medTurn, shapeFit,
    cheapAssist, cheapDirect };
}

// Gravity-assist timing sensitivity: how much of the leg's wins concentrate
// in the best 4 of 11 launch-time buckets (0.36 = timing-insensitive).
function concentration(byT0) {
  const total = byT0.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const sorted = [...byT0].sort((a, b) => b - a);
  return (sorted[0] + sorted[1] + sorted[2] + sorted[3]) / total;
}

// Route interest: how much terrain a leg's typical winning routes sweep —
// bodies passed close by plus a curvature bonus. Successful routes crossing
// varied terrain are what make levels distinct; candidates whose winners fly
// through empty space score low and are penalized in evaluate().
function legInterest(level, stage, legWinners) {
  const start = legStart(level, stage);
  const vals = [], wells = [];
  for (const w of legWinners.slice(0, 10)) {
    const rad = (w.ang * Math.PI) / 180;
    const r = predict(level, start.x, start.z, Math.cos(rad) * w.sp, Math.sin(rad) * w.sp, w.t0, 10, stage);
    const pts = r.points;
    if (pts.length < 4) continue;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i].x, pts[i].z, pts[i - 1].x, pts[i - 1].z);
    const end = pts[pts.length - 1];
    const straight = Math.max(dist(start.x, start.z, end.x, end.z), 1e-6);
    // `near` is everything the route sweeps, home and target included — that
    // is what makes a flight interesting to look at. `via` is the honest
    // difficulty number: worlds passed that are NEITHER end. Gating on `near`
    // measured almost nothing, because the pad sits on the home world and the
    // goal beside the target, so every winner passes both — and their moons
    // too. Set 3 reported the laziest route passing five worlds while having
    // no assisted route at all: all five were Earth, the Moon, Jupiter and two
    // Jovian moons.
    let near = 0, via = 0;
    for (let i = 0; i < level.bodies.length; i++) {
      const a = annulus(level, i);
      for (let k = 0; k < pts.length; k += 4) {
        if (pointToAnnulus(a, pts[k].x, pts[k].z) < level.bodies[i].radius + 8) {
          near++;
          const b = level.bodies[i];
          const home = isEnd(level, 'homeIdx', i, b);
          const tgt = isEnd(level, 'targetIdx', i, b);
          if (!home && !tgt) via++;
          break;
        }
      }
    }
    vals.push(near + Math.min(len / straight - 1, 1));
    wells.push(via);
  }
  if (!vals.length) return { med: 0, min: 0, wellsMin: 0 };
  wells.sort((a, b) => a - b);
  vals.sort((a, b) => a - b);
  // The median says what a typical winning route sweeps; the minimum says
  // what the laziest one does. A level where you can simply fly wide around
  // the whole system and skip the terrain has a fine median and a floor of
  // nearly zero — so the floor is what has to be gated on.
  // wellsMin is the plain count of worlds the LAZIEST winning route passes
  // close to — the number the hard bar is set on.
  return { med: vals[Math.floor(vals.length / 2)], min: vals[0], wellsMin: wells[0] };
}

// Per-leg verdict: every leg in band, legs of comparable difficulty, route
// interest above the set's floor, and (when required) timing-window
// sensitivity on the first launch. Aborts early once a candidate cannot beat
// the best found so far.
function evaluate(set, needsTiming, level, bestDist = Infinity, shape = null, req = null) {
  const legs = legCount(level);
  const low = set.band[0], high = set.band[1] * (legs > 1 ? 2.2 : 1);
  const rates = [], winners = [];
  let dist2 = 0, minWins = Infinity, conc = 0;
  let evalMinTurn = Infinity, evalMedTurn = Infinity, shapeFit = 0;
  let evalAssist = 0, evalDirect = Infinity;
  // `req` is the hard bar this slot must clear. Everything below it also feeds
  // the soft score, which still ranks the survivors — but a candidate that
  // misses the bar is rejected outright rather than ranked. Summing everything
  // into one distance and keeping the best is what made the campaign easy:
  // when no candidate satisfied the floors, the search shipped the closest
  // miss and printed "(closest to band)". It did that on 9 slots out of 10.
  const reject = { minWins: 0, rates: [], dist: Infinity, conc: 0, legs, winners: [], rejected: true };
  for (let s = 0; s < legs; s++) {
    const r = solveLeg(level, s, shape);
    if (req) {
      if (r.minTurn < req.turn) return reject;       // a near-straight shot wins
      if (shape && r.shapeFit > req.shape) return reject;
      // The level must REQUIRE a gravity assist. Putting mass near the straight
      // line does not achieve that - gravity deflects a trajectory away from
      // mass, so routes thread between the wells instead of through them, and a
      // corridor of four worlds still produced two-well routes.
      //
      // What does achieve it is energy. If the cheapest win that touches a well
      // is slower than the cheapest win that touches nothing, the engine can be
      // capped between the two: the direct shot no longer has the speed to
      // arrive, and the only way there is to steal momentum from a world.
      if (req.assist > 0) {
        if (r.cheapAssist === Infinity) return reject;             // no assisted route at all
        if (r.cheapDirect - r.cheapAssist < req.assist) return reject;
      }
    }
    // Weighted above the turn floor below: the shape is the level's identity,
    // the floor only rules out straight shots. Left equal, the search trades
    // the shape away to shave the floor and every level ends up alike again.
    if (shape) { shapeFit = Math.max(shapeFit, r.shapeFit); dist2 += r.shapeFit * 3; }
    minWins = Math.min(minWins, r.wins);
    if (r.wins < MIN_WINS) return { minWins, rates, dist: Infinity, conc, legs, winners };
    rates.push(r.rate);
    winners.push(r.winners);
    // Summed over legs for the same reason wells is: the bar is on the route a
    // player flies, and a route with stops is still one route. Minimised, the
    // final approach vetoed everything — it is a few units of coasting on
    // almost every level, so a three-leg tour reported 0.01 radians while its
    // other two legs were bending properly.
    evalMinTurn = evalMinTurn === Infinity ? r.minTurn : evalMinTurn + r.minTurn;
    evalAssist = Math.max(evalAssist, r.cheapAssist);   // slowest leg sets the cap floor
    evalDirect = Math.min(evalDirect, r.cheapDirect);   // fastest direct win sets the ceiling
    evalMedTurn = Math.min(evalMedTurn, r.medTurn);
    if (r.rate < low) dist2 += low - r.rate;
    else if (r.rate > high) dist2 += r.rate - high;
    // gravity is the point: reject layouts where a straight shot can win —
    // even the straightest winning route must bend by the set's floor, and
    // the typical route should bend well past it
    if (set.turnMin && r.minTurn < set.turnMin) dist2 += (set.turnMin - r.minTurn) * 2;
    if (s === 0 && needsTiming) {
      conc = r.byT0 ? concentration(r.byT0) : 0;
      if (conc < 0.5) dist2 += (0.5 - conc) * 6;     // demand launch windows
    }
    if (dist2 >= bestDist) return { minWins, rates, dist: dist2, conc, legs, winners };
  }
  if (legs > 1) {
    const ratio = Math.max(...rates) / Math.max(Math.min(...rates), 1e-9);
    if (ratio > 2.5) dist2 += ratio - 2.5;           // legs must be comparable
  }
  let interest = 0, interestMin = Infinity, wellsMin = Infinity;
  if (set.interest) {
    for (let s = 0; s < legs; s++) {
      const iv = legInterest(level, s, winners[s]);
      interest += iv.med;
      interestMin = Math.min(interestMin, iv.min);
      // Summed over legs, not minimised across them. The bar asks that the
      // winning PATH navigate wells; a journey with a stop is one path, and
      // taking the worst leg judged it on whichever hop happened to be short.
      // Every two- and three-leg level in the campaign scored 0 that way — the
      // approach to the goal is a few units of coasting on almost any of them,
      // so the whole route was written off however much work the other legs
      // did. Turn is still taken per leg (a trivially straight leg is a real
      // weakness), just scaled by how many legs there are.
      wellsMin = wellsMin === Infinity ? iv.wellsMin : wellsMin + iv.wellsMin;
    }
    interest /= legs;
    if (interest < set.interest) dist2 += (set.interest - interest) * 1.2;
    // and no leg may offer a way through that meets nothing
    const floor = set.interestMin != null ? set.interestMin : Math.max(set.interest - 1.4, 1);
    if (interestMin < floor) dist2 += (floor - interestMin) * 2.5;
    // The hard bar is on WELLS, counted whole: the easiest way through a leg
    // has to pass close to this many worlds. Route interest blends a body
    // count with path elongation, so a long lazy arc could score its way past
    // a floor without going near anything.
    if (req && wellsMin < req.wells) return reject;
  }
  // How hard this candidate is BEYOND the floors it had to clear. `dist` only
  // measures conformance — whether the win rate sits in band and the soft
  // floors are met — and it stops improving the moment a candidate is merely
  // acceptable. So a route bending 3 radians through four worlds scored
  // identically to one bending 1.3 through one, and the search took whichever
  // it happened to reach first. This is the number that separates them.
  const hard =
    // Turning is weighted heavily because a loop IS turning: a full wrap of a
    // world is 2*pi radians, and it is the trajectory this campaign is built to
    // ask for. At weight 1 it was one term among four and a wrapping candidate
    // scored barely above a lazy arc, so the search had no reason to hunt for
    // one. Cubed-ish weighting makes a 4-radian route worth more than any
    // amount of the other terms combined.
    (evalMinTurn === Infinity ? 0 : evalMinTurn) * 3
    + (wellsMin === Infinity ? 0 : wellsMin) * 1.2
    // no direct route at all is the strongest form, worth the full bonus
    + (!isFinite(evalDirect) ? 1.5
      : isFinite(evalAssist) ? Math.min(Math.max(evalDirect - evalAssist, 0) / 8, 1.5) : 0)
    + Math.min(interestMin === Infinity ? 0 : interestMin, 6) * 0.25;
  return { minWins, rates, dist: dist2, hard, conc, legs, winners, interest, interestMin, wellsMin,
    shapeFit, minTurn: evalMinTurn, medTurn: evalMedTurn,
    cheapAssist: evalAssist, cheapDirect: evalDirect };
}

// ---------------------------------------------------------------------------
// Geometry. A moving body's possible positions form an annulus around its
// root center — clearance is distance to the band. The designated home body
// (Earth, next to the pad) and target body (next to the goal) are exempt
// from the usual big margins.
// ---------------------------------------------------------------------------
function annulus(level, i) {
  const b = level.bodies[i];
  if (!b.orbit) return { x: b.x, z: b.z, minR: 0, maxR: 0 };
  const o = b.orbit;
  if (o.parent != null) {
    const p = annulus(level, o.parent);
    return { x: p.x, z: p.z, minR: Math.max(0, p.minR - o.radius), maxR: p.maxR + o.radius };
  }
  return { x: o.cx || 0, z: o.cz || 0, minR: o.radius, maxR: o.radius };
}

function pointToAnnulus(a, x, z) {
  const d = dist(a.x, a.z, x, z);
  return d < a.minR ? a.minR - d : d > a.maxR ? d - a.maxR : 0;
}

function annulusGap(a, b) {
  const d = dist(a.x, a.z, b.x, b.z);
  return Math.max(0, d - a.maxR - b.maxR, a.minR - d - b.maxR, b.minR - d - a.maxR);
}

function bodyClearance(level, x, z) {
  let min = Infinity;
  for (let i = 0; i < level.bodies.length; i++) {
    const a = annulus(level, i);
    min = Math.min(min, pointToAnnulus(a, x, z) - level.bodies[i].radius);
  }
  return min;
}

function keyPoints(level) {
  return [
    { x: level.ship.x, z: level.ship.z },
    { x: level.goal.x, z: level.goal.z },
    ...(level.waypoints || []),
  ];
}

// Worlds sitting in the corridor between the pad and the goal, counted at
// sample time — before any solving, so a layout that cannot support a
// multi-well route is thrown away cheaply.
//
// This is the ceiling on difficulty, and it is set by the layout, not by how
// strictly routes are judged afterwards. Measured on the campaign: the most
// wells ANY winning route could reach was a median of 3, and on 16 levels the
// best possible route reached under 3 — on four of them (32, 46, 47, 50) it
// reached NONE. No acceptance bar can conjure a route through mass that is not
// in the way; raising the bar there only makes the search reject everything and
// fall back to the easiest candidate it saw.
// Worlds required in the corridor, per set. Kept deliberately low: demanding
// four here rejected 799 layouts out of 800 before any of them were solved, and
// it did not buy difficulty anyway - routes thread BETWEEN corridor worlds
// rather than through them, because gravity deflects a trajectory away from
// mass. This now only rules out layouts with nothing at all in the way; the
// assist requirement in HARD is what actually makes a level hard.
const CORRIDOR = [1, 2, 2, 2, 2];
function corridorOk(level, setIdx) {
  return corridorBodies(level, level.ship, level.goal) >= CORRIDOR[setIdx]
    || no('nothing in the corridor');
}

function corridorBodies(level, pad, goal, margin = 10) {
  const vx = goal.x - pad.x, vz = goal.z - pad.z;
  const L2 = vx * vx + vz * vz;
  if (L2 < 1) return 0;
  let n = 0;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i];
    const a = annulus(level, i);
    const px = a.x, pz = a.z;
    let t = ((px - pad.x) * vx + (pz - pad.z) * vz) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = pad.x + vx * t, cz = pad.z + vz * t;
    if (Math.hypot(px - cx, pz - cz) < b.radius + a.maxR + margin) n++;
  }
  return n;
}

// Why layouts are being thrown away. A sampler that rejects everything looks
// identical to a sampler that is merely unlucky, and guessing at the cause
// cost three blind iterations (separation, sun offset, ring radii — 0/800
// each) before a two-minute tally gave the real answer in one run. Set
// GEN_WHY=1 and every rejection is counted by reason and by the body that
// caused it, printed per slot.
const WHY = !!process.env.GEN_WHY;
const whyTally = new Map();
function no(reason) {
  if (WHY) whyTally.set(reason, (whyTally.get(reason) || 0) + 1);
  return false;
}
function whyReport() {
  if (!WHY || !whyTally.size) return '';
  const rows = [...whyTally].sort((a, b) => b[1] - a[1]).slice(0, 6);
  whyTally.clear();
  return '\n    rejected: ' + rows.map(([r, n]) => `${r} x${n}`).join(', ');
}

function levelGeometryOk(level, padClear, goalClear) {
  const E = level.extent;
  for (let i = 0; i < level.bodies.length; i++) {
    const bi = level.bodies[i];
    const a = annulus(level, i);
    const moving = !!bi.orbit;
    if (Math.hypot(a.x, a.z) + a.maxR + bi.radius > E * 0.95) return no(`${bi.name} off map`);
    const isHome = isEnd(level, 'homeIdx', i, bi);
    const isTarget = isEnd(level, 'targetIdx', i, bi);
    const padM = isHome ? 3 : moving ? Math.min(padClear, 10) : padClear;
    const goalM = isTarget ? 3 : moving ? Math.min(goalClear, 8) : goalClear;
    // A pad or goal bolted to this world is meant to be beside it, and keeps a
    // fixed offset so it can never drift into it. It also sits ON that world's
    // ring, which for an orbiting body is what annulus() measures against — so
    // without this it is rejected for being exactly where it belongs.
    const rides = k => k && k.anchor && k.anchor.body === i;
    if (!rides(level.ship) && pointToAnnulus(a, level.ship.x, level.ship.z) < bi.radius + padM) return no(`pad near ${bi.name}`);
    if (!rides(level.goal) && pointToAnnulus(a, level.goal.x, level.goal.z) < bi.radius + goalM) return no(`goal near ${bi.name}`);
    for (const wp of level.waypoints || []) {
      // a stop that RIDES this world is meant to be beside it — it keeps a
      // fixed offset, so it can never drift into the planet it is bolted to
      if (wp.anchor && wp.anchor.body === i) continue;
      // A stop must be allowed INSIDE the radius a route is credited for
      // passing (bodies.radius + 8), or the two rules contradict each other:
      // stops were being parked at radius + 11..19 to satisfy a clearance of
      // radius + 10, which is just outside the radius that counts them — so a
      // level whose station sat beside Mars still scored as passing no world
      // at all. Clearance is now only what keeps the two discs visibly apart.
      if (pointToAnnulus(a, wp.x, wp.z) < bi.radius + (moving ? 3 : 3.5)) return no(`waypoint near ${bi.name}`);
    }
    for (let j = i + 1; j < level.bodies.length; j++) {
      const bj = level.bodies[j];
      const oi = bi.orbit, oj = bj.orbit;
      if ((oj && oj.parent === i) || (oi && oi.parent === j)) continue;
      if (bi.moonOf === j || bj.moonOf === i ||
          (bi.moonOf != null && bi.moonOf === bj.moonOf)) {
        if (dist(a.x, a.z, annulus(level, j).x, annulus(level, j).z) < bi.radius + bj.radius + 2) return no(`${bi.name}/${bj.name} touch`);
        continue;
      }
      if (oi && oj && oi.parent == null && oj.parent == null &&
          (oi.cx || 0) === (oj.cx || 0) && (oi.cz || 0) === (oj.cz || 0) && oi.omega === oj.omega) {
        continue;
      }
      if (annulusGap(a, annulus(level, j)) < bi.radius + bj.radius + 6) return no(`${bi.name}/${bj.name} rings close`);
    }
  }
  const sep = level.extent >= 66 ? 20 : 24;
  const kps = keyPoints(level);
  for (let i = 0; i < kps.length; i++) {
    for (let j = i + 1; j < kps.length; j++) {
      if (dist(kps[i].x, kps[i].z, kps[j].x, kps[j].z) < sep) return no('key points crowded');
    }
  }
  return true;
}

function hazardPoints(h) {
  if (h.comet) {
    const c = h.comet, out = [];
    for (let k = 0; k < 12; k++) {
      const th = (k / 12) * Math.PI * 2;
      const px = Math.cos(th) * c.a, pz = Math.sin(th) * c.b;
      const cos = Math.cos(c.rot || 0), sin = Math.sin(c.rot || 0);
      out.push({ x: c.cx + px * cos - pz * sin, z: c.cz + px * sin + pz * cos });
    }
    return out;
  }
  if (h.orbit) return null;
  if (h.patrol) {
    const p = h.patrol, out = [];
    for (let k = 0; k <= 4; k++) out.push({ x: p.x1 + (p.x2 - p.x1) * (k / 4), z: p.z1 + (p.z2 - p.z1) * (k / 4) });
    return out;
  }
  return [{ x: h.x, z: h.z }];
}

function hazardOk(level, h, keyMargin = 12) {
  const E = level.extent;
  const clear = (x, z) => {
    if (Math.hypot(x, z) > E * 0.88) return false;
    if (bodyClearance(level, x, z) < h.radius + 3) return false;
    for (const kp of keyPoints(level)) {
      if (dist(x, z, kp.x, kp.z) < keyMargin) return false;
    }
    for (const other of level.hazards || []) {
      for (const p of hazardPoints(other) || [{ x: other.orbit.cx, z: other.orbit.cz }]) {
        if (dist(x, z, p.x, p.z) < h.radius + other.radius + 3) return false;
      }
    }
    return true;
  };
  if (h.orbit) {
    const o = h.orbit;
    if (Math.hypot(o.cx, o.cz) + o.radius > E * 0.88) return false;
    const ann = { x: o.cx, z: o.cz, minR: o.radius, maxR: o.radius };
    for (const kp of keyPoints(level)) {
      if (pointToAnnulus(ann, kp.x, kp.z) < h.radius + 10) return false;
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (bodyClearance(level, o.cx + Math.cos(a) * o.radius, o.cz + Math.sin(a) * o.radius) < h.radius + 2) return false;
    }
    return true;
  }
  return hazardPoints(h).every(p => clear(p.x, p.z));
}

function pickupOk(level, x, z) {
  const E = level.extent;
  if (Math.hypot(x, z) > E * 0.85) return false;
  if (bodyClearance(level, x, z) < 4) return false;
  for (const kp of keyPoints(level)) {
    if (dist(x, z, kp.x, kp.z) < 9) return false;
  }
  for (const other of level.pickups || []) {
    if (dist(x, z, other.x, other.z) < 9) return false;
  }
  for (const h of level.hazards || []) {
    for (const p of hazardPoints(h) || [{ x: h.orbit.cx, z: h.orbit.cz }]) {
      if (dist(x, z, p.x, p.z) < 7) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mechanic add-ons
// ---------------------------------------------------------------------------
// Fuel cells sit far OFF the easiest winning route: for each fueled leg we
// find the cheapest winning trajectory, then the winning trajectory whose
// path strays farthest from it, and drop the cell at the point of maximum
// separation. Flying the cheap line means missing the cell — and the tank
// (tuneFuelEconomy) is too small to finish without it.
function placePickupsOffRoute(rng, level, winnersByLeg) {
  level.pickups = [];
  const lastLeg = winnersByLeg.length - 1;
  let detourCost0 = null;
  for (let leg = 0; leg < lastLeg; leg++) {
    const ws = winnersByLeg[leg];
    if (!ws.length) continue;
    const start = legStart(level, leg);
    const paths = ws.slice(0, 25).map(w => {
      const rad = (w.ang * Math.PI) / 180;
      return { w, pts: predict(level, start.x, start.z, Math.cos(rad) * w.sp, Math.sin(rad) * w.sp, w.t0, 10, leg).points };
    });
    let easy = null, easyCost = Infinity;
    for (const p of paths) {
      const c = launchFuelCost(p.w.sp, level.maxLaunch);
      if (c < easyCost - 1e-9 || (Math.abs(c - easyCost) < 1e-9 && easy && p.pts.length < easy.pts.length)) { easy = p; easyCost = c; }
    }
    const offDist = (x, z) => {
      let m = Infinity;
      for (let i = 0; i < easy.pts.length; i += 3) m = Math.min(m, dist(x, z, easy.pts[i].x, easy.pts[i].z));
      return m;
    };
    const cands = [];
    for (const p of paths) {
      if (p === easy) continue;
      let bestD = -1, bestPt = null;
      for (let i = 6; i < p.pts.length - 6; i += 2) {
        const d = offDist(p.pts[i].x, p.pts[i].z);
        if (d > bestD) { bestD = d; bestPt = p.pts[i]; }
      }
      if (bestPt) cands.push({ d: bestD * (1 + (p.w.turn || 0) / 3), pt: bestPt, cost: launchFuelCost(p.w.sp, level.maxLaunch) });
    }
    cands.sort((a, b) => b.d - a.d);
    placed: for (const c of cands.slice(0, 8)) {
      for (let j = 0; j < 12; j++) {
        const x = Math.round(c.pt.x + rand(rng, -2.5, 2.5));
        const z = Math.round(c.pt.z + rand(rng, -2.5, 2.5));
        if (pickupOk(level, x, z)) {
          level.pickups.push({ x, z, fuel: 1.5 });
          if (leg === 0) detourCost0 = c.cost;
          break placed;
        }
      }
    }
  }
  if (!level.pickups.length) delete level.pickups;
  return detourCost0;
}

function addDerelict(rng, level) {
  for (let tries = 0; tries < 30; tries++) {
    const h = {
      radius: 2,
      x: Math.round(rand(rng, -0.6, 0.6) * level.extent),
      z: Math.round(rand(rng, -0.5, 0.5) * level.extent),
    };
    if (hazardOk(level, h)) {
      (level.hazards = level.hazards || []).push(h);
      return;
    }
  }
}

function addPatrol(rng, level) {
  for (let tries = 0; tries < 30; tries++) {
    if (rng() < 0.5) {
      const h = {
        radius: 2,
        orbit: {
          cx: Math.round(rand(rng, -0.3, 0.3) * level.extent),
          cz: Math.round(rand(rng, -0.3, 0.3) * level.extent),
          radius: +rand(rng, 10, 20).toFixed(1),
          omega: +(sign(rng) * rand(rng, 0.35, 0.7)).toFixed(2),
          phase: +rand(rng, 0, 6.28).toFixed(2),
        },
      };
      if (hazardOk(level, h)) { (level.hazards = level.hazards || []).push(h); return; }
    } else {
      const x1 = Math.round(rand(rng, -0.6, 0.6) * level.extent);
      const z1 = Math.round(rand(rng, -0.4, 0.4) * level.extent);
      const h = {
        radius: 2,
        patrol: {
          x1, z1,
          x2: Math.round(x1 + rand(rng, -0.35, 0.35) * level.extent),
          z2: Math.round(z1 + rand(rng, -0.35, 0.35) * level.extent),
          period: +rand(rng, 4, 8).toFixed(1),
          phase: +rand(rng, 0, 1).toFixed(2),
        },
      };
      if (dist(h.patrol.x1, h.patrol.z1, h.patrol.x2, h.patrol.z2) > 14 && hazardOk(level, h)) {
        (level.hazards = level.hazards || []).push(h);
        return;
      }
    }
  }
}

// A stop is a detour or it is nothing. Scattering it near the pad->goal line
// and hoping it landed by a world produced the easiest levels in the game:
// measured, the multi-leg slots came out at turn 0.03-0.21 with the laziest
// route passing zero third-party worlds, because each stop sat on the way and
// simply chopped one flight into two shorter, straighter ones.
//
// So anchor every stop to a world and hang it off the FLANK of the direct
// line — the side, at a distance that keeps it in that world's well. Docking
// then costs a real deviation, and both the leg in and the leg out have to be
// flown through the world's gravity.
function addWaypoints(rng, level, specs) {
  const wps = [];
  const px = level.goal.x - level.ship.x, pz = level.goal.z - level.ship.z;
  const L = Math.max(Math.hypot(px, pz), 1);
  const ux = -pz / L, uz = px / L;            // unit perpendicular to the chord
  const star = level.bodies.find(b => b.type === 'sun') || { x: 0, z: 0 };
  const anchors = level.bodies
    .map((b, i) => ({ b, i, a: annulus(level, i) }))
    // Never the two ends. A stop parked beside the TARGET turns the last leg
    // into a few units of straight coasting, and every metric a level is judged
    // on takes its worst leg: set 3's two-leg slots measured turn 0.16 with the
    // laziest route passing no third-party world, because the station was
    // sitting next to Jupiter and leg two was a hop. Anchoring to a world that
    // is neither end is what makes the stop a place you have to go via.
    .filter(({ b, i }) => b.type !== 'sun' && b.type !== 'blackhole' && b.mass > 0
      && !isEnd(level, 'homeIdx', i, b) && !isEnd(level, 'targetIdx', i, b))
    .map(o => ({ ...o, t: ((o.a.x - level.ship.x) * px + (o.a.z - level.ship.z) * pz) / (L * L) }))
    .filter(o => o.t > 0.1 && o.t < 0.95);
  // A stop with nothing to anchor to falls back to scattering along the chord,
  // which is the placement this function exists to replace — so say so rather
  // than silently reverting.
  if (WHY && !anchors.length) whyTally.set('stop had no anchor world', (whyTally.get('stop had no anchor world') || 0) + 1);
  for (const spec of specs) {
    // work outward from the world nearest this stop's share of the route
    const near = anchors.slice().sort((A, B) => Math.abs(A.t - spec.t) - Math.abs(B.t - spec.t));
    let placed = false;
    for (let tries = 0; tries < 140 && !placed; tries++) {
      const anchor = near.length ? near[Math.min(near.length - 1, Math.floor(tries / 24))] : null;
      let x, z;
      if (anchor && anchor.a.maxR > 0) {
        // An orbiting world is not at a place, it is a ring — and annulus()
        // reports the ORBIT CENTRE with the ring radius, not the planet. So
        // "beside it" means beside the band: park just outside or just inside,
        // at the azimuth where the route crosses. Offsetting from a.x/a.z as
        // though it were the planet threw the stop a full orbital radius clear
        // of the system, which is how set 5's tours ended up flying around the
        // outside in a straight line.
        const cx = level.ship.x + px * spec.t, cz = level.ship.z + pz * spec.t;
        const az = Math.atan2(cz - anchor.a.z, cx - anchor.a.x) + rand(rng, -0.35, 0.35);
        const off = anchor.b.radius + rand(rng, 4, 7);
        const R = anchor.a.maxR + (tries % 2 === 0 ? off : -off);
        if (R < 8) continue;
        x = Math.round(anchor.a.x + Math.cos(az) * R);
        z = Math.round(anchor.a.z + Math.sin(az) * R);
      } else if (anchor) {
        // a static world: clear of the drawn disc, but still inside its well
        const d = anchor.b.radius + rand(rng, 4, 7);
        // Which flank? With home and target on opposite sides of the star the
        // chord runs past it, so one of the two offsets points straight at the
        // sun — that single choice was 80% of all waypoint rejections. Take
        // the outward one by default, and try the inward one occasionally in
        // case that is where the room is.
        const away = (anchor.a.x + ux * d - star.x) ** 2 + (anchor.a.z + uz * d - star.z) ** 2
          >= (anchor.a.x - ux * d - star.x) ** 2 + (anchor.a.z - uz * d - star.z) ** 2 ? 1 : -1;
        const s = tries % 3 === 2 ? -away : away;
        x = Math.round(anchor.a.x + ux * s * d);
        z = Math.round(anchor.a.z + uz * s * d);
      } else {
        const t = spec.t + rand(rng, -0.08, 0.08);
        x = Math.round(level.ship.x + px * t + rand(rng, -0.42, 0.42) * level.extent);
        z = Math.round(level.ship.z + pz * t + rand(rng, -0.16, 0.16) * level.extent);
      }
      if (Math.hypot(x, z) > level.extent * 0.85) continue;
      const cand = { x, z, r: spec.r, type: spec.type };
      const test = { ...level, waypoints: [...wps, cand] };
      if (levelGeometryOk(test, 9, 7)) {
        wps.push(cand);
        placed = true;
      }
    }
    if (!placed) return false;
  }
  level.waypoints = wps;
  return true;
}

// ---------------------------------------------------------------------------
// Fuel economy: fuel (and fuel cells) only exist on multi-hop levels. The
// tank covers the DETOUR launch that flies over the leg-0 cell (plus a
// thrust reserve) but sits below the sum of the cheapest per-leg launches —
// so skipping the cell means running dry before the goal.
// ---------------------------------------------------------------------------
// Put the engine cap between the cheapest assisted win and the cheapest direct
// one, so the direct shot simply does not have the speed to arrive. This is
// what makes the gravity route the only route rather than merely the tidy one,
// and it is why fuel bites: the launch you can afford is the one that uses a
// world, not the one that ignores them.
function capEngineBelowDirect(level, res, set, needsTiming) {
  // Bind the engine to the route, on EVERY level.
  //
  // This used to fire only where a direct shot existed, so it could sit just
  // under what that shot cost. But `cap = max(min(d - 2, maxLaunch), a + 3)`
  // collapses to maxLaunch when d is Infinity — and d is Infinity precisely on
  // the levels where no direct route exists, which is most of them. Measured on
  // the shipped campaign: 1 level of 50 had its engine capped. On the other 49
  // the ship could simply power across at full throttle, and a high-energy
  // trajectory is a straight one, which is why the laziest winning route bent a
  // median of 1.75 radians on a campaign built to demand gravity assists.
  //
  // The cheapest winning launch is the efficient route by definition: it is the
  // one that lets gravity do the work. Cap just above it and that route is the
  // only one affordable, so the curve stops being optional.
  const cheapest = Math.min(res.cheapAssist, res.cheapDirect);
  if (!isFinite(cheapest)) return;
  const full = level.maxLaunch;
  // Back off if the cap costs the level its winnability, the way targets.js
  // grows a ring back rather than shipping something nobody can finish.
  for (const head of [3, 5, 8, 12, 18]) {
    const cap = Math.round(Math.min(cheapest + head, full));
    if (cap >= full) return;
    level.maxLaunch = cap;
    const r = evaluate(set, needsTiming, level);
    if (!r.rejected && r.minWins >= MIN_WINS && r.dist !== Infinity) {
      level.assistOnly = cap < full;
      level.cappedFrom = full;
      level.postCapTurn = r.minTurn;
      return;
    }
  }
  level.maxLaunch = full;
}


function tuneFuelEconomy(rng, level, res) {
  if (res.legs <= 1) {
    // single leg: the tank sits between the efficient slingshot cost and the
    // brute-force cost — overpowering the curve is unaffordable, flying the
    // gravity line is. Small reserve covers mid-flight thrusters.
    const w = res.winners[0] || [];
    if (!w.length) return;
    const cs = w.map(x => launchFuelCost(x.sp, level.maxLaunch)).sort((a, b) => a - b);
    const p25 = cs[Math.floor(cs.length * 0.25)];
    level.fuel = +Math.max(cs[0] + 0.3, Math.min(p25 + 0.2, cs[0] + 0.8)).toFixed(2);
    level.legMinCosts = [+cs[0].toFixed(2)];
    return;
  }
  const detourCost0 = placePickupsOffRoute(rng, level, res.winners);
  const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const costs = res.winners.map(w => w.map(x => launchFuelCost(x.sp, level.maxLaunch)));
  level.legMinCosts = costs.map(c => +(c.length ? Math.min(...c) : 0.4).toFixed(2));
  const med = costs.map(c => (c.length ? median(c) : 0.8));
  const medTotal = med.reduce((a, b) => a + b, 0);
  if ((level.pickups || []).length) {
    // Gate against the CHEAPEST way through, not the typical one. This used to
    // use median winner costs, on the reasoning that near-free slow-lob routes
    // exist on almost every level so a hard minimum is unattainable — true
    // while the engine ran at full throttle, because then the cheap slow route
    // was one option among many. With the engine bound to the efficient route
    // the cheapest way through IS the way through, so the minimum is the number
    // that decides whether the cell is optional.
    //
    // Measured before this change: of 18 levels carrying a fuel cell, 7 did not
    // need it, and the tank was routinely several times the whole route's cost
    // — level 25 gave 1.89 for a route costing 0.44.
    const minTotal = (level.legMinCosts || []).reduce((a, b) => a + b, 0);
    const base = detourCost0 != null ? detourCost0 : med[0];
    // enough to reach the cell, never enough to finish without it
    const want = Math.min(base + 0.6, minTotal - 0.05);
    level.fuel = +Math.max(base + 0.25, want).toFixed(2);
  } else {
    level.fuel = +Math.min(5, medTotal + 1.2).toFixed(1);
  }
  // honest about which it is: the cell is required only if the tank cannot
  // cover the cheapest complete route without it
  const minTotal2 = (level.legMinCosts || []).reduce((a, b) => a + b, 0);
  level.fuelRequired = (level.pickups || []).length ? level.fuel < minTotal2 - 1e-9
    : level.fuel < medTotal - 1e-9;
}

// ---------------------------------------------------------------------------
// Bodies: realistic size tiers. The Sun dwarfs gas giants, which dwarf rocky
// planets, which dwarf moons — and every Sol level carries the complete
// planetary inventory inward of its theme.
// ---------------------------------------------------------------------------
const SUN_COLORS = [0xffd166, 0xffb703, 0xff9e6b];
const ALIEN_NAMES = ['Vesta', 'Lyra', 'Atlas', 'Rhea', 'Iris', 'Quartz', 'Echo', 'Opal', 'Dune', 'Frost',
  'Jasper', 'Koa', 'Lumen', 'Mica', 'Nova', 'Onyx', 'Pip', 'Zephyr', 'Cinder', 'Willow'];
const PLANET_COLORS = [0x8ecae6, 0x7ae582, 0xff8fa3, 0xffd166, 0xf4a261, 0x90e0ef, 0xbde0fe, 0xc8b6ff, 0xffc8dd, 0x95d5b2];
const ANTIMATTER_NAMES = ['Nulla', 'Antara', 'Umbra', 'Vex', 'Inverse', 'Aversa'];
const HOLE_NAMES = ['Maw', 'Gulp', 'Void', 'Abyss', 'Hush'];

function namer(rng) {
  const used = new Set();
  return pool => {
    for (let k = 0; k < 20; k++) {
      const n = pick(rng, pool);
      if (!used.has(n)) { used.add(n); return n; }
    }
    return pick(rng, pool) + ' II';
  };
}

const ringPos = (c, R, a) => ({ x: Math.round(c.x + Math.cos(a) * R), z: Math.round(c.z + Math.sin(a) * R) });
const unit = (dx, dz) => { const d = Math.max(Math.hypot(dx, dz), 1e-9); return { x: dx / d, z: dz / d }; };

// Sol-system catalog (sizes roughly tiered like the real thing)
const CAT = {
  mercury: { name: 'Mercury', r: 1.5, m: 120, c: 0xb5a642 },
  venus: { name: 'Venus', r: 2.5, m: 380, c: 0xe8c07d },
  earth: { name: 'Earth', r: 2.6, m: 420, c: 0x4d9de0 },
  moon: { name: 'Moon', r: 1.0, m: 60, c: 0xd8d8d8 },
  mars: { name: 'Mars', r: 1.9, m: 220, c: 0xd1603d },
  jupiter: { name: 'Jupiter', r: 6.5, m: 1500, c: 0xd9a066 },
  saturn: { name: 'Saturn', r: 5.7, m: 1250, c: 0xe3c896 },
};
const JUP_MOONS = ['Io', 'Europa', 'Ganymede'];
const SAT_MOONS = ['Titan', 'Rhea', 'Enceladus'];

function pushBody(lv, spec, x, z, extra = {}) {
  lv.bodies.push({ name: spec.name, mass: spec.m, radius: spec.r, color: spec.c, x: Math.round(x), z: Math.round(z), ...extra });
  return lv.bodies.length - 1;
}

// Static moon parked beside its parent (a snapshot of its orbit).
function pushMoonOf(rng, lv, parentIdx, spec, gap = null, ang = null) {
  const p = lv.bodies[parentIdx];
  const a = ang != null ? ang : rand(rng, 0, 6.28);
  const d = p.radius + (gap != null ? gap : rand(rng, 3.2, 4.6));
  return pushBody(lv, spec, p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, { moonOf: parentIdx });
}

// offRange pushes the sun toward an edge (fraction of extent) so the local
// planetary neighborhood — where the actual flying happens — gets the rest
// of the map.
function mkSun(rng, lv, name2, mLo, mHi, rLo = 11, rHi = 13, offRange = [0.02, 0.06]) {
  const E = lv.extent;
  const a = rand(rng, 0, 6.28);
  const off = rand(rng, offRange[0], offRange[1]) * E;
  const body = {
    name: name2, mass: Math.round(rand(rng, mLo, mHi)),
    radius: +rand(rng, rLo, rHi).toFixed(1), color: pick(rng, SUN_COLORS),
    x: Math.round(Math.cos(a) * off),
    z: Math.round(Math.sin(a) * off),
    type: 'sun',
  };
  lv.bodies.push(body);
  return body;
}

// The complete Sol inventory inward of `through`.
// `layout` shapes where the space goes: `ang` gives absolute placement angles
// per planet (default random), `earthRing` overrides Earth's ring radius
// (Venus then splits the Mercury-Earth gap), `moonGap`/`moonAng` size and aim
// the Earth-Moon hop.
// Returns { idx: {mercury, venus, earth, moon, mars, jupiter, saturn}, rings }.
function buildSol(rng, lv, through, layout = {}) {
  const sun = lv.bodies[0];
  const A = layout.ang || {};
  const ang = key => (A[key] != null ? A[key] : rand(rng, 0, 6.28));
  const idx = {}, rings = {};
  rings.mercury = sun.radius + rand(rng, 8, 10);
  idx.mercury = pushBody(lv, CAT.mercury, ...Object.values(ringPos(sun, rings.mercury, ang('mercury'))));
  if (layout.earthRing) {
    rings.earth = layout.earthRing;
    rings.venus = (rings.mercury + rings.earth) / 2 + rand(rng, -3, 3);
  } else {
    rings.venus = rings.mercury + rand(rng, 9, 11);
    rings.earth = rings.venus + rand(rng, 9, 11);
  }
  idx.venus = pushBody(lv, CAT.venus, ...Object.values(ringPos(sun, rings.venus, ang('venus'))));
  const ep = ringPos(sun, rings.earth, ang('earth'));
  idx.earth = pushBody(lv, CAT.earth, ep.x, ep.z);
  const mg = layout.moonGap || [3.6, 5];
  idx.moon = pushMoonOf(rng, lv, idx.earth, CAT.moon, rand(rng, mg[0], mg[1]), layout.moonAng);
  if (through === 'earth') return { idx, rings, sun };
  let R = rings.earth + rand(rng, 9, 11);
  rings.mars = R;
  idx.mars = pushBody(lv, CAT.mars, ...Object.values(ringPos(sun, R, ang('mars'))));
  if (through === 'mars') return { idx, rings, sun };
  R += through === 'beltjupiter' ? rand(rng, 22, 25) : rand(rng, 14.5, 16.5);
  rings.jupiter = R;
  idx.jupiter = pushBody(lv, CAT.jupiter, ...Object.values(ringPos(sun, R, ang('jupiter'))));
  const nJm = 2 + (rng() < 0.5 ? 1 : 0);
  const jBase = rand(rng, 0, 6.28);
  for (let i = 0; i < nJm; i++) {
    pushMoonOf(rng, lv, idx.jupiter, { name: JUP_MOONS[i], r: +rand(rng, 1, 1.3).toFixed(1), m: Math.round(rand(rng, 60, 120)), c: 0xd8d8d8 }, 3.6 + i * 2.4, jBase + i * rand(rng, 1.8, 2.3));
  }
  if (through === 'jupiter' || through === 'beltjupiter') return { idx, rings, sun };
  R += rand(rng, 18.5, 20.5);
  rings.saturn = R;
  idx.saturn = pushBody(lv, CAT.saturn, ...Object.values(ringPos(sun, R, ang('saturn'))));
  const sBase = rand(rng, 0, 6.28);
  for (let i = 0; i < 2; i++) {
    pushMoonOf(rng, lv, idx.saturn, { name: SAT_MOONS[i], r: +rand(rng, 1, 1.3).toFixed(1), m: Math.round(rand(rng, 60, 120)), c: 0xd8d8d8 }, 3.7 + i * 2.4, sBase + i * rand(rng, 1.9, 2.4));
  }
  return { idx, rings, sun };
}

// pad just off a body (radially outward from the sun unless dir given)
function padByBody(lv, body, from, gap) {
  const u = unit(body.x - from.x, body.z - from.z);
  lv.ship = { x: Math.round(body.x + u.x * (body.radius + gap)), z: Math.round(body.z + u.z * (body.radius + gap)) };
}
// Put the goal in its world's SHADOW, and put it close.
//
// Hiding the goal directly behind the target relative to the pad is what makes
// a route come round rather than straight in — but the depth of that shadow
// decides whether it has to wrap or can simply arc past at a distance. At a
// 6-10 unit standoff the shadow is shallow and a wide bend clears it, which is
// why the campaign's laziest routes bent about 1.8 radians. Tucked in close,
// the approach has to arrive nearly tangential to the surface, and the only way
// to do that from the far side is to come round the body — which is the loop.
//
// `tight` pulls the goal in to a couple of ship-widths off the surface. It is
// applied where the caller asks for it, so levels that want an open approach
// can still have one.
function goalByBody(lv, body, from, gap, r, tight = false) {
  const u = unit(body.x - from.x, body.z - from.z);
  const off = tight ? body.radius + Math.max(r + 2.2, 3.2) : body.radius + gap;
  lv.goal = { x: Math.round(body.x + u.x * off), z: Math.round(body.z + u.z * off), r };
}

// Comet: lethal, massless, slow LARGE elliptical orbit around the sun.
function addComet(rng, lv) {
  const E = lv.extent, sun = lv.bodies[0];
  for (let tries = 0; tries < 30; tries++) {
    const h = {
      radius: 1.2,
      comet: {
        cx: sun.x, cz: sun.z,
        a: +(rand(rng, 0.5, 0.72) * E).toFixed(1),
        b: +(rand(rng, 0.2, 0.34) * E).toFixed(1),
        rot: +rand(rng, 0, 3.14).toFixed(2),
        omega: +(sign(rng) * rand(rng, 0.04, 0.09)).toFixed(3),
        phase: +rand(rng, 0, 6.28).toFixed(2),
      },
    };
    const pts = hazardPoints(h);
    const ok = pts.every(p => Math.hypot(p.x, p.z) <= E * 0.93 && bodyClearance(lv, p.x, p.z) >= h.radius + 2) &&
      pts.every(p => keyPoints(lv).every(kp => dist(p.x, p.z, kp.x, kp.z) >= 9));
    if (ok) { (lv.hazards = lv.hazards || []).push(h); return; }
  }
}

// ---------------------------------------------------------------------------
// Set 1 — Earthrise: full inner inventory; launch from Earth. Static.
// Frontier scale: Sol sits at the far edge, Earth's ring reaches past map
// center so the Earth-Moon neighborhood owns the open half; Venus/Mars
// targets swing to the opposite side of Sol from Earth.
// ---------------------------------------------------------------------------
// Angular separation between the home world and the target, about the sun.
// This is what decides whether anything sits between the two ends of a level.
// It used to be ~1.0-1.35 radians (60-77 degrees), which puts home and target
// on the SAME side of the system with clear space between them - so a route
// flew straight across and touched nothing on the way. Measured on set 2:
// zero of 696 valid layouts had a winning route passing any world other than
// home and target.
//
// Near-opposite instead (roughly 130-175 degrees) puts the sun, and whatever
// orbits inside the target's ring, squarely in the way. A route has to go
// around or steal from them.
const SEPARATION = [2.3, 3.0];
// How far off-centre the sun sits, as a fraction of the map extent. It used to
// be pushed to 0.48-0.62 so the flying happened across open space away from it
// — which is precisely the empty space that makes routes touch nothing. With
// the two ends of a level near-opposite about the sun, the far one lands off
// the map entirely at those offsets: 0 of 800 layouts passed. Centred, the
// sun's well sits between the ends and both fit.
const SUN_OFF = [0.06, 0.20];

function sampleEarthrise(rng, slot) {
  const E = 80;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 6 }, maxLaunch: Math.round(rand(rng, 48, 52)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2000, 2600, 11, 13, SUN_OFF);
  const center = Math.atan2(-sun.z, -sun.x);
  const off = Math.hypot(sun.x, sun.z);
  const dA = sign(rng) * rand(rng, SEPARATION[0], SEPARATION[1]);
  // The Earth-Moon hop is the tutorial and nothing more. Measured over 800
  // layouts each, the three Moon slots were the only weak levels in the set:
  // the straightest winning route bent 0.41-0.48 radians and no assisted route
  // existed at all, against 0.93-2.05 and a real assist on every Venus/Mars
  // slot. Home and target sit a few tens of units apart with the rest of the
  // system elsewhere, so there is nothing for a route to work. One slot of it,
  // then out to the inner planets.
  const moonSlot = slot < 1;
  const venusSlot = slot >= 1 && slot < 5;
  // Home on the centre line, destination near-opposite it. The Mars slots used
  // to put Earth at center + 0.45..0.7 dA instead, leaving the two ends only
  // 88-150 degrees apart: measured, every one of them came out with the
  // laziest route passing NO third-party world and no assist available, while
  // the fully opposed Venus slots delivered one world and a forced assist —
  // and passed geometry twice as often besides.
  const sd = Math.sign(dA);
  const targetAng = center - dA;
  const ang = {
    mercury: center + sd * rand(rng, 1.4, 2.2),
    venus: venusSlot ? targetAng : center - sd * rand(rng, 0.7, 1.2),
    earth: center + rand(rng, -0.2, 0.2),
    mars: venusSlot || moonSlot ? center + sd * rand(rng, 0.7, 1.2) : targetAng,
  };
  const inner = moonSlot || venusSlot;
  const past = inner ? [0.34, 0.46] : [0.30, 0.40];  // rings wide of a centred sun
  const sol = buildSol(rng, lv, inner ? 'earth' : 'mars', {
    ang, earthRing: rand(rng, past[0], past[1]) * E,
    moonGap: moonSlot ? [14, 18] : [6, 9],
    // Hang the Moon off Earth's flank rather than straight out from the sun.
    // The pad goes on the far side of Earth from the Moon, so a radial Moon
    // put the pad on Earth's sunward side — around 20 units from a sun that
    // now sits near the middle of the map, inside its clearance on 787 of
    // every 800 layouts. Tangentially, pad and Moon both stay out at roughly
    // Earth's own orbital radius, and the hop crosses the sun's field
    // sideways instead of diving at it.
    moonAng: moonSlot ? ang.earth + sign(rng) * (Math.PI / 2 + rand(rng, -0.3, 0.3)) : null,
  });
  const earth = lv.bodies[sol.idx.earth];
  lv.homeIdx = sol.idx.earth;
  let targetIdx;
  if (moonSlot) {
    // to the Moon: pad on the FAR side of Earth, so home gravity is in play
    const moon = lv.bodies[sol.idx.moon];
    const mu = unit(moon.x - earth.x, moon.z - earth.z);
    lv.ship = { x: Math.round(earth.x - mu.x * (earth.radius + rand(rng, 7, 9))), z: Math.round(earth.z - mu.z * (earth.radius + rand(rng, 7, 9))) };
    targetIdx = sol.idx.moon;
    lv.goal = { x: Math.round(moon.x + mu.x * (moon.radius + rand(rng, 8, 10))), z: Math.round(moon.z + mu.z * (moon.radius + rand(rng, 8, 10))), r: +(6.4 - slot * 0.15).toFixed(1) };
  } else {
    targetIdx = venusSlot ? sol.idx.venus : sol.idx.mars;
    // pad tucked behind Earth (away from the target), goal tucked behind the
    // target (away from Earth): every route must curve around both wells
    padByBody(lv, earth, lv.bodies[targetIdx], rand(rng, 7, 9));
    goalByBody(lv, lv.bodies[targetIdx], { x: lv.ship.x, z: lv.ship.z }, rand(rng, 6, 8), +(6.2 - slot * 0.12).toFixed(1), true);
  }
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 9, 7) || !corridorOk(lv, 0)) return null;
  return lv;
}

// ---------------------------------------------------------------------------
// Set 2 — Inner System: everything through Mars, wrecks, first comet. Static.
// ---------------------------------------------------------------------------
function sampleInner(rng, slot) {
  const E = 90;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: 5.2 }, maxLaunch: Math.round(rand(rng, 46, 50)), fuel: 3, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000, 11, 13, SUN_OFF);
  const center = Math.atan2(-sun.z, -sun.x);
  const off = Math.hypot(sun.x, sun.z);
  const dA = sign(rng) * rand(rng, SEPARATION[0], SEPARATION[1]);
  const targetKey = slot < 3 ? 'venus' : slot < 6 ? 'mercury' : 'mars';
  const ang = {
    mercury: targetKey === 'mercury' ? center - dA : center + rand(rng, -1.4, 1.4),
    venus: targetKey === 'venus' ? center - dA : center + rand(rng, -1.1, 1.1),
    earth: center + (targetKey === 'mars' ? dA * rand(rng, 0.5, 0.75) : rand(rng, -0.2, 0.2)),
    mars: center - dA,
  };
  const sol = buildSol(rng, lv, 'mars', {
    ang, earthRing: rand(rng, 0.34, 0.44) * E, moonGap: [6, 9],
  });
  lv.homeIdx = sol.idx.earth;
  const targetIdx = sol.idx[targetKey];
  padByBody(lv, lv.bodies[sol.idx.earth], lv.bodies[targetIdx], rand(rng, 7, 9));
  goalByBody(lv, lv.bodies[targetIdx], { x: lv.ship.x, z: lv.ship.z }, rand(rng, 6, 8), +rand(rng, 4.9, 5.5).toFixed(1));
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 9, 7) || !corridorOk(lv, 1)) return null;
  if (slot >= 2) for (let i = 0; i < 1 + (slot >= 5 ? 1 : 0); i++) addDerelict(rng, lv);
  if (slot >= 4) addComet(rng, lv);
  if (slot >= 7) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 3 — Outer Planets: full inventory through Jupiter/Saturn. Static.
// ---------------------------------------------------------------------------
function sampleOuter(rng, slot) {
  const through = slot < 5 ? 'jupiter' : 'saturn';
  // Saturn's ring lands near 84 units out and the sun sits up to a fifth of
  // the map off-centre, so a 106-unit map put Saturn past the edge on most
  // layouts — 18 of every ~36 rejections on the Saturn slots were exactly
  // that. The map has to be wide enough for the ring the level is named after.
  const E = through === 'jupiter' ? 100 : 126;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: +rand(rng, 4.6, 5.4).toFixed(1) }, maxLaunch: Math.round(rand(rng, 44, 49)), fuel: 3.5, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2600, 3200, 10, 11.5, SUN_OFF);
  const center = Math.atan2(-sun.z, -sun.x);
  const dA = sign(rng) * rand(rng, SEPARATION[0], SEPARATION[1]);
  const sd = Math.sign(dA);
  // Home near the centre line, target near-opposite it, everything else
  // filling the space between. The old ladder placed Earth at center + dA and
  // the giant at center - 0.85..1.1 dA, which with the current separation
  // wraps most of the way round: Earth and Jupiter came out as little as a few
  // degrees apart, on the SAME side of the sun. Routes then flew the gap
  // directly and the laziest winner passed zero worlds other than the two ends
  // — the level looked busy (five bodies swept) only because Jupiter's own
  // moons were being counted.
  const sol = buildSol(rng, lv, through, {
    ang: {
      mercury: center + sd * rand(rng, 1.4, 2.2),
      venus: center - sd * rand(rng, 0.7, 1.2),
      earth: center + rand(rng, -0.2, 0.2),
      mars: center + sd * rand(rng, 0.7, 1.2),
      jupiter: through === 'jupiter' ? center - dA : center + sd * rand(rng, 1.9, 2.4),
      saturn: center - dA,
    },
    moonGap: [6, 9],
    moonAng: center + Math.PI + rand(rng, -1.0, 1.0),   // sunward: clear of the pad
  });
  lv.homeIdx = sol.idx.earth;
  const targetIdx = through === 'jupiter' ? sol.idx.jupiter : sol.idx.saturn;
  padByBody(lv, lv.bodies[sol.idx.earth], lv.bodies[targetIdx], rand(rng, 7, 9));
  goalByBody(lv, lv.bodies[targetIdx], { x: lv.ship.x, z: lv.ship.z }, rand(rng, 8, 11), lv.goal.r);
  lv.targetIdx = targetIdx;
  if (!levelGeometryOk(lv, 9, 7) || !corridorOk(lv, 2)) return null;
  if (slot >= 4 && !addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  if (slot >= 2 && rng() < 0.6) addDerelict(rng, lv);
  if (slot >= 3) addComet(rng, lv);
  if (slot >= 8) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Set 4 — Asteroid Belt: a dense rock wall between Mars and Jupiter with
// 1-2 narrow passages. Full inventory through Jupiter.
// ---------------------------------------------------------------------------
function sampleBelt(rng, slot) {
  const E = 110;
  const lv = { extent: E, ship: { x: 0, z: 0 }, goal: { x: 0, z: 0, r: +rand(rng, 4.8, 5.2).toFixed(1) }, maxLaunch: Math.round(rand(rng, 42, 48)), fuel: 4, bodies: [] };
  const sun = mkSun(rng, lv, 'Sol', 2400, 3000, 10, 11.5, SUN_OFF);
  const center = Math.atan2(-sun.z, -sun.x);
  const dA = sign(rng) * rand(rng, SEPARATION[0], SEPARATION[1]);
  // same opposed layout as sampleOuter: home on the centre line, target
  // near-opposite it, the rest of the inventory filling the space between
  const sd = Math.sign(dA);
  const sol = buildSol(rng, lv, 'beltjupiter', {
    ang: {
      mercury: center + sd * rand(rng, 1.4, 2.2),
      venus: center - sd * rand(rng, 0.7, 1.2),
      earth: center + rand(rng, -0.2, 0.2),
      mars: center + sd * rand(rng, 0.7, 1.2),
      jupiter: center - dA,
    },
    moonGap: [6, 9],
    moonAng: center + Math.PI + rand(rng, -1.0, 1.0),   // sunward: clear of the pad
  });
  lv.homeIdx = sol.idx.earth;
  lv.targetIdx = sol.idx.jupiter;
  padByBody(lv, lv.bodies[sol.idx.earth], lv.bodies[sol.idx.jupiter], rand(rng, 7, 9));
  goalByBody(lv, lv.bodies[sol.idx.jupiter], { x: lv.ship.x, z: lv.ship.z }, rand(rng, 8, 11), lv.goal.r);
  if (!levelGeometryOk(lv, 9, 7) || !corridorOk(lv, 3)) return null;
  if (slot >= 3) {
    if (!addWaypoints(rng, lv, [{ t: 0.35, r: 4.5, type: 'cargo' }, { t: 0.7, r: 4.5, type: 'dropoff' }])) return null;
  } else if (slot >= 1 && rng() < 0.5) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4.5, type: 'station' }])) return null;
  }
  // the belt wall: an annulus of rocks between Mars and Jupiter, with
  // narrow angular passages left open
  const bandLo = sol.rings.mars + 6, bandHi = sol.rings.jupiter - 9;
  const nGaps = slot < 5 ? 2 : 1;
  const gaps = [];
  for (let gi = 0; gi < nGaps; gi++) gaps.push({ a: rand(rng, 0, 6.28), w: rand(rng, 0.3, 0.45) });
  const inGap = ang => gaps.some(gp => {
    const d = Math.abs(((ang - gp.a + Math.PI) % (2 * Math.PI)) - Math.PI);
    return d < gp.w / 2;
  });
  const nRocks = 30 + slot * 2;
  let placed = 0;
  lv.hazards = lv.hazards || [];
  for (let i = 0; i < nRocks * 8 && placed < nRocks; i++) {
    const ang = rand(rng, 0, 6.28);
    if (inGap(ang)) continue;
    const R = rand(rng, bandLo, bandHi);
    const h = {
      kind: 'asteroid', radius: +rand(rng, 0.22, 0.45).toFixed(2),
      x: Math.round(sun.x + Math.cos(ang) * R), z: Math.round(sun.z + Math.sin(ang) * R),
    };
    if (Math.hypot(h.x, h.z) > E * 0.93) continue;
    if (bodyClearance(lv, h.x, h.z) < h.radius + 2) continue;
    if (!keyPoints(lv).every(kp => dist(h.x, h.z, kp.x, kp.z) >= 8)) continue;
    if (!lv.hazards.every(o => o.kind !== 'asteroid' || dist(h.x, h.z, o.x, o.z) >= h.radius + o.radius + 1.2)) continue;
    lv.hazards.push(h);
    placed++;
  }
  if (placed < nRocks * 0.6) return null;
  if (slot >= 2) addComet(rng, lv);
  if (slot >= 5) addPatrol(rng, lv);
  return lv;
}


// Cargo tours in moving systems: stops are spread around the sun the LONG way
// from pad to goal, so every leg arcs across the system instead of hopping
// along the map edge, and each one is parked ALONGSIDE a planet's orbital ring
// — close enough to be inside that world's pull when it comes round.
//
// Two earlier placements both produced the same dead level. A service ring
// outside every orbit made the tour a lap of the map edge through empty space;
// the midpoint of the gap between two rings is, by construction, the one place
// in the system with no mass near it. Both measured at 0.03-0.07 radians of
// bend per leg with route interest of 1.0 — a straight line touching nothing.
// Beside a ring is where the gravity is.
function addTourWaypoints(rng, lv, outerR, specs) {
  const sun = lv.bodies[0];
  const azS = Math.atan2(lv.ship.z - sun.z, lv.ship.x - sun.x);
  const azG = Math.atan2(lv.goal.z - sun.z, lv.goal.x - sun.x);
  let sweep = azG - azS;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  if (Math.abs(sweep) < Math.PI * 0.9) sweep -= Math.sign(sweep || 1) * 2 * Math.PI;
  // In a system where everything moves, a FIXED point is never reliably near
  // anything. Parked beside a ring it is beside a planet only on the fraction
  // of the orbit when that planet happens to be at that azimuth; the rest of
  // the time it is void, which is why ring-adjacent stops measured the same
  // dead 0.04-0.07 radians as the service ring did.
  //
  // So bolt the stop to a world and let it ride: physics.js already resolves
  // `anchor` against live positions, which is how launch pads follow their
  // planet. Now the stop is beside that world by construction, and both the
  // leg in and the leg out are flown against its gravity — and where the world
  // will BE when you arrive becomes the question the level asks.
  const hosts = lv.bodies
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.orbit && b.orbit.parent == null);
  const at0 = bodiesAt(lv, 0);
  const wps = [];
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k];
    let placed = false;
    for (let tries = 0; tries < 120 && !placed; tries++) {
      let cand;
      if (tries < 90 && hosts.length) {
        const h = hosts[(k + Math.floor(tries / 12)) % hosts.length];
        const dir = rand(rng, 0, 6.28);
        const off = h.b.radius + rand(rng, 4, 7);
        const dx = +(Math.cos(dir) * off).toFixed(1), dz = +(Math.sin(dir) * off).toFixed(1);
        const p = at0[h.i];
        cand = { x: Math.round(p.x + dx), z: Math.round(p.z + dz), r: spec.r, type: spec.type,
          anchor: { body: h.i, dx, dz } };
      } else {
        // last resort: the old fixed service ring, spread the long way round
        const az = azS + sweep * ((k + 1) / (specs.length + 1)) + rand(rng, -0.25, 0.25);
        const R = outerR + rand(rng, 9, 14);
        cand = { x: Math.round(sun.x + Math.cos(az) * R), z: Math.round(sun.z + Math.sin(az) * R),
          r: spec.r, type: spec.type };
      }
      if (Math.hypot(cand.x, cand.z) > lv.extent * 0.85) continue;
      const test = { ...lv, waypoints: [...wps, cand] };
      if (levelGeometryOk(test, 9, 7)) { wps.push(cand); placed = true; }
    }
    if (!placed) return false;
  }
  lv.waypoints = wps;
  return true;
}
// ---------------------------------------------------------------------------
// Set 5 — New Star Systems: alien suns, moving orbits, exotic objects.
// ---------------------------------------------------------------------------
function sampleAlien(rng, slot) {
  const E = Math.round(rand(rng, 72, 80));
  const lv = { extent: E, ship: { x: Math.round(rand(rng, -0.45, 0.45) * E * 0.9), z: Math.round(0.72 * E) }, goal: { x: Math.round(rand(rng, -0.5, 0.5) * E * 0.9), z: Math.round(-0.73 * E), r: +rand(rng, 4.2, 4.6).toFixed(1) }, maxLaunch: Math.round(rand(rng, 38, 46)), fuel: 5, bodies: [] };
  const name = namer(rng);
  const sun = mkSun(rng, lv, pick(rng, ['Helios', 'Aurum', 'Tsuki', 'Vera', 'Kestrel', 'Rana']), 2600, 3800, 10, 12, [0.16, 0.28]);
  const sunOff = Math.hypot(sun.x, sun.z);
  const planetIdxs = [];
  const nPl = 3 + (rng() < 0.4 ? 1 : 0);
  // Decide the whole inventory before spacing the rings. The ring step used to
  // be a flat max(14, 0.15-0.19 E), which on a 72-80 unit map is at most 15.2
  // — while two neighbouring gas giants need their swept discs 6 units apart,
  // so 5 + 6 + 6 = 17. Adjacent giants were therefore ALWAYS rejected, and a
  // moon (whose swept ring is its planet's ring widened by its own orbit) made
  // it worse. Only about one layout in fifty survived, which left the search
  // nothing to choose between: set 5 shipped whatever geometry it could get
  // rather than the hardest it could find.
  const plan = [];
  let moonBudget = 2;
  for (let i = 0; i < nPl; i++) {
    const isGas = rng() < 0.4;
    const radius = isGas ? +rand(rng, 5, 6).toFixed(1) : +rand(rng, 2, 3.2).toFixed(1);
    const wantsMoon = moonBudget > 0 && rng() < 0.45;
    if (wantsMoon) moonBudget--;
    const moonOrb = wantsMoon ? +(radius + rand(rng, 3.5, 5.5)).toFixed(1) : 0;
    const moonRad = wantsMoon ? +rand(rng, 1, 1.5).toFixed(1) : 0;
    plan.push({
      isGas, radius, wantsMoon, moonOrb, moonRad,
      mass: isGas ? Math.round(rand(rng, 1000, 1500)) : Math.round(rand(rng, 250, 550)),
      color: pick(rng, PLANET_COLORS),
      // how far this planet's family reaches either side of its own ring
      reach: Math.max(radius, moonOrb + moonRad),
    });
  }
  let orbR = sun.radius + rand(rng, 8, 11) + plan[0].reach;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (i > 0) orbR += Math.max(rand(rng, 0.15, 0.19) * E, plan[i - 1].reach + p.reach + 7);
    if (orbR + p.reach > E * 0.93 - sunOff) break;
    const pIdx = lv.bodies.length;
    planetIdxs.push(pIdx);
    lv.bodies.push({
      name: name(ALIEN_NAMES), mass: p.mass, radius: p.radius, color: p.color,
      orbit: { cx: sun.x, cz: sun.z, radius: +orbR.toFixed(1), omega: +(sign(rng) * rand(rng, 0.22, 0.55)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    if (p.wantsMoon) {
      lv.bodies.push({
        name: name(ALIEN_NAMES), mass: Math.round(rand(rng, 50, 130)),
        radius: p.moonRad, color: 0xe2e2e2,
        orbit: { parent: pIdx, radius: p.moonOrb, omega: +(sign(rng) * rand(rng, 0.8, 1.2)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
      });
    }
  }
  if (!planetIdxs.length) return null;
  const outer = lv.bodies[planetIdxs[planetIdxs.length - 1]].orbit.radius;
  const centerA = Math.atan2(-sun.z, -sun.x);   // keep exotics inside bounds

  // Launch from a world and arrive at a world, on opposite sides of the star —
  // the arrangement every other set uses, and the one set 5 was missing.
  //
  // Its ends used to be fixed points at the map edges (z = +/-0.72 E), OUTSIDE
  // the planetary system, with open space all around it. A wide lob around the
  // outside therefore always existed, touching nothing, and no engine cap could
  // remove it because there was no cheaper assisted route to cap below. All ten
  // alien levels came out with a direct shot available.
  //
  // The reason it was built that way is real: set 5's planets already orbit
  // when the level is generated, so a pad placed beside one would be left
  // behind by it. `anchor` is the answer — physics.js resolves an anchored spot
  // against live positions, so the pad rides its world exactly as the tour
  // stops do, and where the target world will BE becomes part of the problem.
  if (planetIdxs.length < 2) return null;
  const homeIdx = planetIdxs[0];
  const targetIdx = planetIdxs[planetIdxs.length - 1];
  const dA = sign(rng) * rand(rng, SEPARATION[0], SEPARATION[1]);
  lv.bodies[homeIdx].orbit.phase = +(centerA + rand(rng, -0.25, 0.25)).toFixed(2);
  lv.bodies[targetIdx].orbit.phase = +(centerA - dA).toFixed(2);
  lv.homeIdx = homeIdx;
  lv.targetIdx = targetIdx;
  {
    const at0 = bodiesAt(lv, 0);
    const h = lv.bodies[homeIdx], t = lv.bodies[targetIdx];
    // pad on the far side of home from the target, goal on the far side of the
    // target from home: both ends tucked behind their own world, so the route
    // has to come round each of them as well as cross what lies between
    // Offset ALONG each world's ring, not across it. Pushing the pad straight
    // away from the target moves it radially, which walks it into the next
    // planet's swept band — every layout was rejected for "pad near" some
    // unrelated world. Sliding it round its own orbit instead keeps it at its
    // host's radius, where by construction there is room. Of the two ways
    // round, take the one that puts it further from the target, so the route
    // still has to come round the home world to leave.
    const far = (cx, cz, ax, az) => {
      const r = unit(cx - sun.x, cz - sun.z);
      const tx = -r.z, tz = r.x;                 // unit tangent to the ring
      const d = (tx * (ax - cx) + tz * (az - cz)) >= 0 ? -1 : 1;
      return { x: tx * d, z: tz * d };
    };
    const pu = far(at0[homeIdx].x, at0[homeIdx].z, at0[targetIdx].x, at0[targetIdx].z);
    const gu = far(at0[targetIdx].x, at0[targetIdx].z, at0[homeIdx].x, at0[homeIdx].z);
    const hd = h.radius + rand(rng, 5, 8), td = t.radius + rand(rng, 5, 8);
    const pdx = +(pu.x * hd).toFixed(1), pdz = +(pu.z * hd).toFixed(1);
    const gdx = +(gu.x * td).toFixed(1), gdz = +(gu.z * td).toFixed(1);
    lv.ship = { x: Math.round(at0[homeIdx].x + pdx), z: Math.round(at0[homeIdx].z + pdz),
      anchor: { body: homeIdx, dx: pdx, dz: pdz } };
    lv.goal = { x: Math.round(at0[targetIdx].x + gdx), z: Math.round(at0[targetIdx].z + gdz),
      r: lv.goal.r, anchor: { body: targetIdx, dx: gdx, dz: gdz } };
  }
  if (rng() < 0.45) {
    const ang = centerA + rand(rng, -1.7, 1.7);
    const d = outer + rand(rng, 12, 20);
    lv.bodies.push({
      name: name(HOLE_NAMES), mass: Math.round(rand(rng, 3500, 4800)),
      radius: 3, horizon: +rand(rng, 5.5, 6.5).toFixed(1), color: 0x1a1a2e, type: 'blackhole',
      x: Math.round(sun.x + Math.cos(ang) * d), z: Math.round(sun.z + Math.sin(ang) * d),
    });
  }
  if (rng() < 0.35) {
    const ang = centerA + rand(rng, -1.7, 1.7);
    const d = outer + rand(rng, 13, 22);
    lv.bodies.push({
      name: name(ANTIMATTER_NAMES), mass: -Math.round(rand(rng, 500, 1000)),
      radius: +rand(rng, 3.5, 4.5).toFixed(1), color: 0xc77dff,
      x: Math.round(sun.x + Math.cos(ang) * d), z: Math.round(sun.z + Math.sin(ang) * d),
    });
  }
  if (!levelGeometryOk(lv, 9, 7) || !corridorOk(lv, 4)) return null;
  // The old "straight line must cross a planet's swept ring" test is gone with
  // the fixed edge-to-edge ends that needed it. It was weak anyway: crossing a
  // RING says a planet passes through there sometime, not that anything is in
  // the way when you fly. With the two ends now on opposite sides of the star,
  // the star itself is between them at every instant, and corridorOk already
  // asks that something more than the star be in the way.
  if (slot >= 5) {
    if (!addTourWaypoints(rng, lv, outer, [{ r: 3.6, type: 'cargo' }, { r: 3.6, type: 'dropoff' }])) return null;
  } else if (slot >= 2 && rng() < 0.7) {
    if (!addWaypoints(rng, lv, [{ t: 0.5, r: 4, type: 'station' }])) return null;
  }
  if (slot >= 1 && rng() < 0.5) addComet(rng, lv);
  if (slot >= 3) addPatrol(rng, lv);
  return lv;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------
const ORIGINALS = {
  horizon: { name: 'Event Horizon', hint: 'Nothing escapes the red ring. Skim close for a huge slingshot — but not TOO close.', extent: 64, ship: { x: -38, z: 44 }, goal: { x: 34, z: -44, r: 4.5 }, maxLaunch: 44, fuel: 4, bodies: [{ name: 'Maw', mass: 5200, radius: 3.5, horizon: 6.5, color: 0x1a1a2e, x: 0, z: 0, type: 'blackhole' }] },
  grandtour: { name: 'Grand Tour', hint: 'Everything at once. Take your time — plot the long way round.', extent: 74, ship: { x: 30, z: 56 }, goal: { x: -34, z: -50, r: 5 }, maxLaunch: 48, fuel: 5, bodies: [{ name: 'Titan', mass: 1700, radius: 6, color: 0xffd166, x: 26, z: 14 }, { name: 'Wisp', mass: 420, radius: 2.5, color: 0xe2e2e2, orbit: { parent: 0, radius: 15, omega: 0.8, phase: 2.1 } }, { name: 'Umbra', mass: -900, radius: 4.5, color: 0xc77dff, x: 2, z: -4 }, { name: 'Maw II', mass: 4200, radius: 3, horizon: 5.5, color: 0x1a1a2e, x: -26, z: -18, type: 'blackhole' }] },
};

const SETS = [
  {
    name: 'Earthrise', difficulty: 1, sample: sampleEarthrise, band: [0.55, 1.35], interest: 2.2,
    originals: [],
    hint: 'You launch from Earth — the whole inner system is out there bending your shot.',
    slotHints: {
      0: 'Welcome aboard! Drag back from your ship to launch from Earth to the lunar station.',
      1: 'Venus already — swing past Sol\'s huge well without falling in.',
      5: 'All the way to Mars station. Plot carefully.',
    },
    names: ['Earthrise', 'Venus Bound', 'Morning Star', 'Transit of Venus', 'Evening Star', 'Halfway to Mars', 'Red Planet', 'Dusty Landing', 'Phobos Pass', 'Escape Velocity'],
  },
  {
    name: 'Inner System', difficulty: 2, sample: sampleInner, band: [0.3, 0.9], interest: 3,
    originals: [],
    hint: 'The inner system: tight, hot orbits around a heavy Sun.',
    slotHints: {
      2: 'Derelict ships drift in the lanes — one touch and it\'s over.',
      3: 'Mercury station: skim Sol\'s well without falling in.',
      4: 'A comet crosses these lanes on a long ellipse. Watch its arrow.',
    },
    names: ['Inner Ring', 'Crossing Venus', 'Sunward', 'Mercury Dive', 'Comet Crossing', 'Solar Wind', 'Retrograde', 'Hot Lap', 'Twin Transfer', 'Inner Mastery'],
  },
  {
    name: 'Outer Planets', difficulty: 3, sample: sampleOuter, band: [0.2, 0.68], interest: 3.2,
    originals: [],
    hint: 'Gas giants ahead: huge wells, huge slingshots — and the whole inner system behind you.',
    slotHints: {
      4: 'Dock at the waystation 🛰 first. Stops never refuel — grab cells on the way.',
      5: 'Saturn now. Jupiter is still out there, bending everything.',
    },
    names: ['Jovian Leap', 'Eye of Jupiter', 'Io Flyby', 'Europa Run', 'Callisto Stop', 'Saturn Swing', 'Titan Station', 'Ring Runner', 'Enceladus Deep', 'Grand Cruise'],
  },
  {
    name: 'Asteroid Belt', difficulty: 4, sample: sampleBelt, band: [0.13, 0.55], timing: 6, interest: 3,
    originals: [],
    hint: 'A wall of rock rings the Sun between Mars and Jupiter. Find the passages — or go around.',
    slotHints: {
      3: 'Haul the cargo 📦 through the belt to the dropoff 📥 — fuel cells are NOT optional.',
      6: 'Patrols and comets cross the passages. Time your launch around their arrows.',
    },
    names: ['Into the Belt', 'Rock Hopping', 'Ceres Approach', 'First Haul', 'Cargo Convoy', 'Rubble Wall', 'The Passage', 'Vesta Run', 'Dense Cluster', 'Belt Baron'],
  },
  {
    name: 'New Star Systems', difficulty: 5, sample: sampleAlien, band: [0.04, 0.45], timing: 3, interest: 2.6,
    originals: [{ level: ORIGINALS.horizon, slot: 0 }, { level: ORIGINALS.grandtour, slot: 1 }],
    hint: 'Alien systems: antimatter stars, black holes, weak engines. Ride the orbits — launch windows matter.',
    slotHints: {
      3: 'Your engine can\'t brute-force this one. Wait for a planet to swing by and steal its momentum.',
      5: 'Cargo runs in a moving system, and stops never refuel. Plan the whole route.',
    },
    names: ['Event Horizon', 'Grand Tour', 'Star System', 'Dark Passage', 'Planetfall', 'The Gauntlet', 'Singularity', 'Far Shore', 'Last Light', 'GravityLoop'],
  },
];
// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
// Floor on the STRAIGHTEST winning route, per set, in radians: gravity is the
// point, so no level may offer a way through that barely bends. How much a
// level bends beyond that, and in what shape, is the per-slot job of SHAPES —
// a single per-set median floor made every level in a set play the same.
// GEN_TIER=A is moderate, C demands curves hard.
const TIER = process.env.GEN_TIER || 'C';
const TURNS = { A: [0.6, 0.8, 1.0, 1.2, 1.5], B: [0.8, 1.1, 1.4, 1.7, 2.1], C: [1.1, 1.4, 1.7, 2.0, 2.4] }[TIER];
SETS.forEach((s, i) => { s.turnMin = TURNS[i]; });
// blockers + turn gates cut raw win rates: halve the band floors
SETS.forEach(s => { s.band = [+(s.band[0] * 0.5).toFixed(3), s.band[1]]; });

// The HARD bar a slot must clear, per set. Unlike the soft score these are
// pass/fail: a candidate that misses is discarded, not ranked.
//   wells — worlds the EASIEST winning route must pass close to. This is the
//           knob that makes a level a journey through gravity rather than a
//           lob across it. Set one under CORRIDOR: the corridor guarantees the
//           mass is in the way, this asks that a route actually go through it.
//           Measured before this change, the median level's laziest route
//           passed 2 and the worst passed 0, and the best route on 16 levels
//           could not reach 3 at all.
//   turn  — radians the straightest winning route must bend.
//   shape — how far the best-fitting winner may miss the slot's route shape.
//
// These are set from the measured distribution, not from ambition. The
// previous numbers (wells 2-3, turn 1.3-2.6) were never once met: every slot
// in every set fell through to a relaxed rung, and the last rung asks for
// nothing at all — so the effective bar was zero and the search kept whatever
// it happened to find. A bar that is always relaxed does not make hard levels,
// it makes the difficulty search inoperative.
//
// Sampled over 120 layouts per slot with the corrected geometry, what the
// samplers actually deliver on a single-leg level is one third-party world and
// a forced assist, bending 1.15-2.35 radians. So `wells` sits at 1 and the
// turn floor rises across the campaign through the middle of that range. Slots
// that can do better still do — set 1 slot 5 came out at wells 2 / turn 1.94
// — because the bar decides what is ACCEPTABLE and the rate band decides what
// is chosen from among the acceptable.
const HARD = [
  { wells: 1, turn: 1.3, shape: 1.6, assist: 3 },
  { wells: 1, turn: 1.4, shape: 1.6, assist: 4 },
  { wells: 1, turn: 1.5, shape: 1.6, assist: 5 },
  { wells: 1, turn: 1.5, shape: 1.6, assist: 6 },
  { wells: 1, turn: 1.0, shape: 1.6, assist: 6 },
]
// Set 5's floor used to sit at 0.4 because its levels measured 0.29-0.73
// radians, and that was read as a property of the set — open space to open
// space, no pair of wells to wrap around, difficulty carried by launch-window
// timing instead. That reading was wrong: it was a property of where the ends
// were PUT. Anchoring them to worlds on opposite sides of the star took the
// same slots to 1.26-1.43 with two third-party worlds passed and no direct
// route at all. The floor follows the geometry, so it rises with it — and the
// timing character is untouched, since the worlds still move under you.
// Relaxations tried in order when a slot cannot meet its bar in ATTEMPTS
// tries. Each rung is reported, so an easy level is visible in the log rather
// than silently shipped as if it had passed.
// Each rung must be strictly looser than the one above it, or a candidate can
// be rejected by a rung that is supposed to be a concession: the old rung 2
// dropped wells to 1 while rung 3 raised it back to max(wells-1, 1), so with a
// bar of 2 rung 3 was *stricter* than rung 2. Wells now falls once, at rung 3.
const REQ_RUNGS = [
  r => r,
  r => ({ ...r, turn: r.turn * 0.85, shape: r.shape + 0.4, assist: r.assist * 0.7 }),
  r => ({ ...r, turn: r.turn * 0.7, shape: r.shape + 0.9, assist: r.assist * 0.45 }),
  r => ({ ...r, wells: r.wells - 1, turn: r.turn * 0.5, shape: 99, assist: r.assist * 0.25 }),
  () => ({ wells: 0, turn: 0, shape: 99, assist: 0 }),
];

// How many acceptable candidates to weigh before settling on the hardest.
const IN_BAND_CAP = +(process.env.GEN_INBAND_CAP || 40);

const MIN_WINS = 3;       // per-leg coarse floor so `solve.js --fast` always passes
const ATTEMPTS = +(process.env.GEN_ATTEMPTS || 800);   // extreme-turn candidates are rare

// `--sets=1,2` generates only those sets and skips writing levels.js — a
// dry run for tuning samplers without waiting for the full campaign.
const ONLY = (() => {
  const a = process.argv.find(x => x.startsWith('--sets='));
  return a ? new Set(a.split('=')[1].split(',').map(Number)) : null;
})();

// Goals are precise targets, not hoops: shrink every goal and dock ring.
// Trajectories cross a disc with probability ~r, so difficulty bands in
// SETS are calibrated for the shrunken radii.
const GOAL_SCALE = 0.42;
function scaleGoals(lv) {
  lv.goal.r = +Math.max(1.6, lv.goal.r * GOAL_SCALE).toFixed(2);
  for (const w of lv.waypoints || []) w.r = +Math.max(1.6, w.r * GOAL_SCALE).toFixed(2);
}

// One slot's full search. Deterministic in (s, slot) alone, so slots can run
// in ANY order — including in parallel worker processes (--emit-slot).
// With shardN > 1 only attempts shardK, shardK+shardN, ... are searched; the
// returned metadata lets --merge-slot reproduce the serial selection exactly
// (first dist-0 by attempt index, else lowest dist with earliest attempt).
function genSlot(s, slot, shardK = 0, shardN = 1) {
  const set = SETS[s];
  const original = set.originals.find(o => o.slot === slot);
  if (original) {
    scaleGoals(original.level);
    const r = evaluate(set, false, original.level);
    console.log(`[set ${s + 1}] slot ${slot} original  ${original.level.name.padEnd(18)} rates [${r.rates.map(x => x.toFixed(2)).join(', ')}]%`);
    original.level.difficulty = set.difficulty;
    return { level: original.level, found: true, attempt: -1, dist: 0 };
  }
  const needsTiming = set.timing != null && slot >= set.timing;
  const shape = shapeFor(s, slot);
  const bar = HARD[Math.min(s, HARD.length - 1)];
  const rungs = REQ_RUNGS.map(f => f(bar));
  const loosest = rungs[rungs.length - 1];
  // Every requirement the rung names has to be checked HERE. evaluate() is
  // called with the loosest rung so hopeless candidates die cheaply, which
  // means the strict rungs are enforced only by this function — a requirement
  // missing from it is a requirement that does not exist, however carefully
  // it is defined elsewhere. The assist gap was absent and so never gated
  // anything, and slots reported as clearing rung 1 had no assisted route at
  // all. An infinite gap means no direct route exists, which is the strongest
  // form of the requirement, not a failure of it.
  // minTurn is now summed over the route's legs rather than minimised across
  // them, so no per-leg scaling is needed here — a journey is judged on the
  // whole journey, the same way its wells are.
  const clears = (r, q) =>
    r.minTurn >= q.turn
    && (r.wellsMin == null || r.wellsMin >= q.wells)
    && (!shape || r.shapeFit <= q.shape)
    && (q.assist <= 0 || (isFinite(r.cheapAssist) && r.cheapDirect - r.cheapAssist >= q.assist));
  const byRung = new Array(rungs.length).fill(null);
  let geoOk = 0, solvable = 0, inBandSeen = 0;
  for (let attempt = shardK; attempt < ATTEMPTS; attempt += shardN) {
    const rng = mulberry32(5e6 + s * 100003 + slot * 1009 + attempt);
    const lv = set.sample(rng, slot);
    if (!lv) continue;
    scaleGoals(lv);
    geoOk++;
    // Screen against the loosest rung first so hopeless candidates die cheaply,
    // then file the survivor under the strictest rung it actually clears.
    const r = evaluate(set, needsTiming, lv, Infinity, shape, loosest);
    if (r.rejected || r.minWins < MIN_WINS || r.dist === Infinity) continue;
    solvable++;
    const rung = rungs.findIndex(q => clears(r, q));
    if (rung < 0) continue;
    // Among candidates that are in band and clear every soft floor, take the
    // HARDEST rather than the first one found. `dist === 0` says a level is
    // acceptable, not that it is as hard as this slot can get — and the search
    // used to stop dead on the first one, often within a handful of the 800
    // attempts, so every bar set here behaved as a target rather than a floor.
    // Out-of-band candidates still rank by how close to the band they are.
    const cur = byRung[rung];
    const cand = { level: lv, res: r, rng, attempt };
    const inBand = r.dist === 0, curIn = cur && cur.res.dist === 0;
    const wins = !cur ? true
      : inBand !== !!curIn ? inBand
      : inBand ? r.hard > cur.res.hard
      : r.dist < cur.res.dist;
    if (wins) byRung[rung] = cand;
    // Bounded, not unbounded. Searching every attempt is what makes the pick
    // the hardest rather than the first, but it also removes the early exit
    // that kept generation tractable: set 2 slot 5 went from seconds to over
    // nine minutes, and the CI matrix does not shard that set. Stopping once
    // enough acceptable candidates have been WEIGHED keeps almost all of the
    // selectivity — the hardest of forty beats the first of forty by a wide
    // margin, while the hardest of eight hundred is barely better than that.
    if (inBand && rung === 0 && ++inBandSeen >= IN_BAND_CAP) break;
  }
  const usedRung = byRung.findIndex(Boolean);
  const best = usedRung >= 0 ? byRung[usedRung] : null;
  const chosen = best;
  if (!chosen) {
    if (shardN > 1) return { level: null, found: false, attempt: -1, dist: Infinity };
    throw new Error(`set ${s + 1} slot ${slot}: no solvable candidate (geoOk ${geoOk}/${ATTEMPTS}, solvable ${solvable})${whyReport()}`);
  }
  capEngineBelowDirect(chosen.level, chosen.res, set, needsTiming);
  tuneFuelEconomy(chosen.rng, chosen.level, chosen.res);
  chosen.level.name = set.names[slot];
  chosen.level.hint = set.slotHints[slot] || set.hint;
  chosen.level.difficulty = set.difficulty;
  const r = chosen.res;
  console.log(
    `[set ${s + 1}] slot ${slot} generated ${set.names[slot].padEnd(18)} rates [${r.rates.map(x => x.toFixed(2)).join(', ')}]%` +
    ` legs ${r.legs}${needsTiming ? ` timing ${r.conc.toFixed(2)}` : ''}` +
    ` shape ${SHAPE_ORDER[(slot + s) % SHAPE_ORDER.length]}${r.shapeFit ? `(${r.shapeFit.toFixed(2)})` : ''}` +
    ` wells ${r.wellsMin != null ? r.wellsMin : '-'}` +
    ` assist ${!isFinite(r.cheapDirect) ? 'forced' : !isFinite(r.cheapAssist) ? 'none' : (r.cheapDirect - r.cheapAssist).toFixed(0)}` +
    ` hard ${r.hard != null ? r.hard.toFixed(2) : '-'}` +
    `${r.interest != null ? ` interest ${r.interest.toFixed(2)}/${r.interestMin === Infinity ? '-' : r.interestMin.toFixed(2)}` : ''}` +
    `${r.minTurn != null && r.minTurn !== Infinity ? ` turn ${r.minTurn.toFixed(2)}/${r.medTurn.toFixed(2)}` : ''}` +
    `${(chosen.level.pickups || []).length ? ` pickups ${chosen.level.pickups.length}` : ''}` +
    `${chosen.level.fuelRequired ? ' fuel-gated' : ''}` +
    `${chosen.level.cappedFrom ? ` engine ${chosen.level.cappedFrom}->${chosen.level.maxLaunch} turn->${(chosen.level.postCapTurn || 0).toFixed(2)}` : ' engine uncapped'}` +
    `${usedRung > 0 ? `  RELAXED x${usedRung}` : ''}` +
    `${WHY ? ` geoOk ${geoOk}/${ATTEMPTS} solvable ${solvable}${whyReport()}` : ''}`
  );
  // `found` used to mean "stopped early on a full-bar candidate". There is no
  // early stop any more, so it means what --merge-slot actually needs to know:
  // this shard's pick cleared the unrelaxed bar.
  return { level: chosen.level, found: usedRung === 0, attempt: chosen.attempt,
    dist: chosen.res.dist, hard: chosen.res.hard };
}

// --emit-slot=S:SLOT --out=FILE   worker mode: search one slot, write JSON
// --assemble=DIR                  read DIR/s<S>-<SLOT>.json for all 50 slots
//                                 and write src/levels.js
// (see tools/genpar.sh, which fans workers across cores)
const EMIT = process.argv.find(x => x.startsWith('--emit-slot='));
const SHARD = process.argv.find(x => x.startsWith('--shard='));
const MERGE = process.argv.find(x => x.startsWith('--merge-slot='));
const ASSEMBLE = process.argv.find(x => x.startsWith('--assemble='));
const allLevels = [];
if (EMIT) {
  const [s, slot] = EMIT.split('=')[1].split(':').map(Number);
  const outFile = (process.argv.find(x => x.startsWith('--out=')) || '').split('=')[1];
  if (!outFile) throw new Error('--emit-slot requires --out=FILE');
  if (SHARD) {
    const [k, n] = SHARD.split('=')[1].split(':').map(Number);
    const r = genSlot(s, slot, k, n);
    fs.writeFileSync(outFile, JSON.stringify(r));
  } else {
    fs.writeFileSync(outFile, JSON.stringify(genSlot(s, slot).level));
  }
  process.exit(0);
} else if (MERGE) {
  // combine shard outputs into a plain slot JSON, replicating the serial
  // selection rule: earliest-attempt dist-0 winner, else lowest dist
  // (earliest attempt on ties)
  const [s, slot] = MERGE.split('=')[1].split(':').map(Number);
  const dir = (process.argv.find(x => x.startsWith('--dir=')) || '').split('=')[1];
  const nShards = Number((process.argv.find(x => x.startsWith('--shards=')) || '').split('=')[1]);
  if (!dir || !nShards) throw new Error('--merge-slot requires --dir=DIR --shards=N');
  const shards = [];
  for (let k = 0; k < nShards; k++) {
    shards.push(JSON.parse(fs.readFileSync(path.join(dir, `s${s}-${slot}.shard${k}.json`))));
  }
  const cands = shards.filter(x => x.level);
  if (!cands.length) throw new Error(`set ${s + 1} slot ${slot}: no solvable candidate in any shard`);
  const founds = cands.filter(x => x.found);
  const pickBy = arr => arr.reduce((a, b) =>
    (b.dist < a.dist || (b.dist === a.dist && b.attempt < a.attempt)) ? b : a);
  // Mirror the serial rule: among shards whose pick cleared the unrelaxed bar,
  // take the HARDEST. Taking the earliest attempt instead — which is what this
  // did while genSlot stopped early — would throw away the whole point of
  // searching every attempt, since the shards would race to be first again.
  const winner = founds.length
    ? founds.reduce((a, b) =>
      ((b.hard || 0) > (a.hard || 0) || ((b.hard || 0) === (a.hard || 0) && b.attempt < a.attempt)) ? b : a)
    : pickBy(cands);
  fs.writeFileSync(path.join(dir, `s${s}-${slot}.json`), JSON.stringify(winner.level));
  console.log(`[set ${s + 1}] slot ${slot} merged ${winner.level.name.padEnd(18)} attempt ${winner.attempt} dist ${winner.dist.toFixed(3)}${winner.found ? '' : '  (closest to band)'}`);
  process.exit(0);
} else if (ASSEMBLE) {
  const dir = ASSEMBLE.split('=')[1];
  for (let s = 0; s < SETS.length; s++) {
    for (let slot = 0; slot < 10; slot++) {
      allLevels.push(JSON.parse(fs.readFileSync(path.join(dir, `s${s}-${slot}.json`))));
    }
  }
} else {
  for (let s = 0; s < SETS.length; s++) {
    if (ONLY && !ONLY.has(s + 1)) continue;
    for (let slot = 0; slot < 10; slot++) allLevels.push(genSlot(s, slot).level);
  }
}

// ---------------------------------------------------------------------------
// Emit src/levels.js
// ---------------------------------------------------------------------------
const setsOut = SETS.map(s => ({ name: s.name, difficulty: s.difficulty }));
let js = `// GravityLoop — level data (50 levels in 5 themed sets of 10).
// GENERATED by tools/generate.js — edit that file and re-run:
//   node tools/generate.js
// Coordinates: x is right, z is toward the camera (ship starts at +z).
// mass < 0 makes an antimatter star (a hill instead of a well).

export const SETS = ${JSON.stringify(setsOut, null, 2)};

export const LEVELS = ${JSON.stringify(allLevels, null, 2)};
`;
js = js.replace(/"color": (\d+)/g, (_, n) => `"color": 0x${Number(n).toString(16)}`);

if (ONLY) {
  console.log(`\n--sets dry run: not writing levels.js (${allLevels.length} levels generated)`);
} else {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'levels.js');
  fs.writeFileSync(out, js);
  console.log(`\nWrote ${allLevels.length} levels to ${out}`);
}
