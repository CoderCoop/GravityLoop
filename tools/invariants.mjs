// Physics invariants and metamorphic properties.
//
// The solver proves levels are *winnable*. This proves the physics means what
// the rest of the code assumes it means — the class of bug where an outcome is
// reported that the geometry does not support, or where a "safe" tuning change
// silently makes levels harder.
//
// Pure Node, no browser, seconds to run.
//
//   node tools/invariants.mjs
import { predict, legStart, legCount, bodiesAt, hazardsAt, activeTarget, SHIP_R } from '../src/physics.js';
import { LEVELS } from '../src/levels.js';

let failures = 0;
const fail = msg => { console.error(`  ✗ ${msg}`); failures++; };

// Deterministic PRNG so a failure is always reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIT_MARGIN = SHIP_R * 0.25;

// ---------------------------------------------------------------------------
// 1. An outcome must be supported by the geometry at the moment it fires.
//    A reported 'goal' whose end point is outside the goal radius, or a
//    'crash' with the ship clear of every body, means the drawn scene and the
//    simulation can never agree no matter how carefully we render.
// ---------------------------------------------------------------------------
function checkOutcomesAgree() {
  console.log('outcomes are supported by the geometry at the reported instant');
  const r = rng(20260726);
  let checked = 0;
  for (let li = 0; li < LEVELS.length; li++) {
    const lv = LEVELS[li];
    for (let n = 0; n < 60; n++) {
      const leg = Math.floor(r() * legCount(lv));
      const t0 = r() * 9;
      const start = legStart(lv, leg, bodiesAt(lv, t0));
      const ang = r() * Math.PI * 2;
      const sp = 10 + r() * Math.max(lv.maxLaunch - 10, 1);
      const res = predict(lv, start.x, start.z, Math.cos(ang) * sp, Math.sin(ang) * sp, t0, 12, leg);
      const end = res.points[res.points.length - 1];
      const at = t0 + end.t;
      const ps = bodiesAt(lv, at);
      checked++;

      if (res.outcome === 'goal' || res.outcome === 'waypoint') {
        const tgt = activeTarget(lv, leg, ps);
        const d = Math.hypot(end.x - tgt.x, end.z - tgt.z);
        // one physics step of travel is the sampling slack
        if (d > tgt.r + sp * (1 / 120) + 1e-6) {
          fail(`L${li + 1} leg ${leg}: reported ${res.outcome} but ended ${d.toFixed(2)}u from a target of radius ${tgt.r}`);
        }
      }
      if (res.outcome === 'crash') {
        const b = lv.bodies[res.body];
        const d = Math.hypot(end.x - ps[res.body].x, end.z - ps[res.body].z);
        const hit = (b.horizon || b.radius) + HIT_MARGIN;
        if (d > hit + sp * (1 / 120) + 1e-6) {
          fail(`L${li + 1} leg ${leg}: reported crash into ${b.name} but ended ${d.toFixed(2)}u away (hit radius ${hit.toFixed(2)})`);
        }
      }
      if (res.outcome === 'hazard') {
        const h = lv.hazards[res.hazard];
        const hp = hazardsAt(lv, at)[res.hazard];
        const d = Math.hypot(end.x - hp.x, end.z - hp.z);
        if (d > h.radius + HIT_MARGIN + sp * (1 / 120) + 1e-6) {
          fail(`L${li + 1} leg ${leg}: reported hazard hit but ended ${d.toFixed(2)}u away`);
        }
      }
    }
  }
  console.log(`  ${checked} launches checked`);
}

// ---------------------------------------------------------------------------
// 2. Prediction is deterministic. Everything downstream — the solver's
//    verdicts, the generator's difficulty bands, the aim preview matching the
//    flight — assumes identical inputs give an identical trajectory.
// ---------------------------------------------------------------------------
function checkDeterminism() {
  console.log('prediction is deterministic');
  const r = rng(7);
  for (let n = 0; n < 40; n++) {
    const lv = LEVELS[Math.floor(r() * LEVELS.length)];
    const t0 = r() * 9;
    const start = legStart(lv, 0, bodiesAt(lv, t0));
    const ang = r() * Math.PI * 2, sp = 10 + r() * 20;
    const a = predict(lv, start.x, start.z, Math.cos(ang) * sp, Math.sin(ang) * sp, t0, 12, 0);
    const b = predict(lv, start.x, start.z, Math.cos(ang) * sp, Math.sin(ang) * sp, t0, 12, 0);
    if (a.outcome !== b.outcome || a.points.length !== b.points.length) {
      fail(`same launch gave ${a.outcome}/${a.points.length} then ${b.outcome}/${b.points.length}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Metamorphic properties. These encode the reasoning we would otherwise do
//    in our heads when tuning — the exact reasoning that, done in our heads,
//    has been wrong before.
// ---------------------------------------------------------------------------
function winsOf(level, hitScale, goalScale) {
  const lv = {
    ...level,
    goal: { ...level.goal, r: level.goal.r * goalScale },
    bodies: level.bodies.map(b => ({ ...b, radius: b.radius * hitScale, horizon: b.horizon ? b.horizon * hitScale : undefined })),
  };
  let wins = 0;
  const start = legStart(lv, 0, bodiesAt(lv, 0));
  for (let ang = 0; ang < 360; ang += 6) {
    const rad = (ang * Math.PI) / 180;
    for (let sp = 10; sp <= lv.maxLaunch; sp += 6) {
      const r = predict(lv, start.x, start.z, Math.cos(rad) * sp, Math.sin(rad) * sp, 0, 12, 0);
      if (r.outcome === 'goal' || r.outcome === 'waypoint') wins++;
    }
  }
  return wins;
}

function checkMetamorphic() {
  console.log('metamorphic: target size moves winnability in the direction it should');
  // single-leg levels only, so leg 0 decides the outcome
  const sample = LEVELS.map((l, i) => [l, i]).filter(([l]) => legCount(l) === 1).slice(0, 12);
  for (const [lv, i] of sample) {
    const base = winsOf(lv, 1, 1);
    const smallerGoal = winsOf(lv, 1, 0.8);
    if (smallerGoal > base) {
      fail(`L${i + 1}: shrinking the goal raised wins ${base} -> ${smallerGoal} (should never increase)`);
    }
    const biggerGoal = winsOf(lv, 1, 1.25);
    if (biggerGoal < base) {
      fail(`L${i + 1}: growing the goal dropped wins ${base} -> ${biggerGoal} (should never decrease)`);
    }
  }
}

// NOTE: an obvious-looking companion property — "shrinking the bodies can only
// gain wins, because fewer trajectories crash" — is FALSE here, and this suite
// caught it on its first run. `body.radius` is not only a collision size: it
// also sets the gravity softening (`eps = radius * 0.5`) and the terrain
// clamp, so shrinking a body sharpens the field near it and bends
// trajectories that previously scored. Collision margin and body size are
// therefore not interchangeable knobs, and reasoning that treats them as one
// is how a "safe" tuning change quietly breaks levels.

// ---------------------------------------------------------------------------
// 4. Level data the renderer and tools rely on.
// ---------------------------------------------------------------------------
function checkLevelData() {
  console.log('level data is well formed');
  LEVELS.forEach((lv, i) => {
    const tag = `L${i + 1} ${lv.name || ''}`;
    lv.bodies.forEach((b, bi) => {
      if ((b.x == null) === (b.orbit == null)) {
        fail(`${tag}: body ${bi} (${b.name}) must have exactly one of a static position or an orbit`);
      }
      if (b.orbit && b.orbit.parent != null && b.orbit.parent >= bi) {
        fail(`${tag}: body ${bi} orbits a parent that is not resolved first`);
      }
    });
    for (const [what, spot] of [['ship', lv.ship], ['goal', lv.goal], ...(lv.waypoints || []).map((w, wi) => [`waypoint ${wi}`, w])]) {
      if (spot.anchor && !lv.bodies[spot.anchor.body]) fail(`${tag}: ${what} anchored to a body that does not exist`);
      if (spot.anchor && !lv.bodies[spot.anchor.body].orbit) fail(`${tag}: ${what} anchored to a body that never moves`);
    }
    // a target you cannot fit through is not a target
    if (lv.goal.r < SHIP_R) fail(`${tag}: goal radius ${lv.goal.r} is smaller than the ship (${SHIP_R})`);
  });
}

console.log('physics invariants\n');
checkLevelData();
checkOutcomesAgree();
checkDeterminism();
checkMetamorphic();
console.log(failures ? `\n${failures} invariant failure(s)` : '\nAll invariants hold.');
process.exit(failures ? 1 : 0);
