// GravityLoop — level generator.
// Samples themed levels with a seeded RNG, keeps only candidates the
// brute-force solver confirms are winnable inside each set's difficulty band,
// then writes the full 50-level roster (originals + generated) to src/levels.js.
//
//   node tools/generate.js
//
// Deterministic: same seeds -> same levels.
import { predict } from '../src/physics.js';
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
// Coarse solver (same grid CI uses via `solve.js --fast`)
// ---------------------------------------------------------------------------
function solveCoarse(level) {
  const dynamic = level.bodies.some(b => b.orbit);
  const times = dynamic ? Array.from({ length: 11 }, (_, i) => i * 0.9) : [0];
  let wins = 0, total = 0;
  for (const t0 of times) {
    for (let ang = 0; ang < 360; ang += 3) {
      const rad = (ang * Math.PI) / 180;
      for (let sp = 10; sp <= level.maxLaunch; sp += 4) {
        total++;
        const r = predict(level, level.ship.x, level.ship.z,
          Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12);
        if (r.outcome === 'goal') wins++;
      }
    }
  }
  return { wins, total, rate: (wins / total) * 100 };
}

// ---------------------------------------------------------------------------
// Geometry helpers. A moving body's possible positions form an annulus
// (ring band) around its root center — clearance is distance to the band,
// not to a filled disc.
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

function levelGeometryOk(level, padClear, goalClear) {
  const E = level.extent;
  for (let i = 0; i < level.bodies.length; i++) {
    const bi = level.bodies[i];
    const a = annulus(level, i);
    const moving = !!bi.orbit;
    if (Math.hypot(a.x, a.z) + a.maxR + bi.radius > E * 0.92) return false;
    const padM = moving ? Math.min(padClear, 10) : padClear;
    const goalM = moving ? Math.min(goalClear, 8) : goalClear;
    if (pointToAnnulus(a, level.ship.x, level.ship.z) < bi.radius + padM) return false;
    if (pointToAnnulus(a, level.goal.x, level.goal.z) < bi.radius + goalM) return false;
    for (let j = i + 1; j < level.bodies.length; j++) {
      const bj = level.bodies[j];
      const oi = bi.orbit, oj = bj.orbit;
      if ((oj && oj.parent === i) || (oi && oi.parent === j)) continue;   // ring contains its parent
      if (oi && oj && oi.parent == null && oj.parent == null &&
          (oi.cx || 0) === (oj.cx || 0) && (oi.cz || 0) === (oj.cz || 0) && oi.omega === oj.omega) {
        continue;                                                          // phase-locked around same center
      }
      if (annulusGap(a, annulus(level, j)) < bi.radius + bj.radius + 6) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Flavour
// ---------------------------------------------------------------------------
const BODY_NAMES = ['Pebble', 'Mint', 'Coral', 'Sage', 'Ember', 'Nimbus', 'Juno', 'Vesta', 'Lyra', 'Atlas',
  'Rhea', 'Iris', 'Quartz', 'Basil', 'Echo', 'Fern', 'Opal', 'Dune', 'Frost', 'Halo',
  'Jasper', 'Koa', 'Lumen', 'Mica', 'Nova', 'Onyx', 'Pip', 'Zephyr', 'Cinder', 'Willow'];
const PLANET_COLORS = [0x8ecae6, 0x7ae582, 0xff8fa3, 0xffd166, 0xf4a261, 0x90e0ef, 0xbde0fe, 0xc8b6ff, 0xffc8dd, 0x95d5b2];
const SUN_COLORS = [0xffd166, 0xffb703, 0xff9e6b];
const REPULSOR_NAMES = ['Nope', 'Shove', 'Pusher', 'Grudge', 'Bristle', 'Static'];
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

// ---------------------------------------------------------------------------
// Theme samplers — each returns a candidate level or null
// ---------------------------------------------------------------------------
function padAndGoal(rng, E, goalR) {
  return {
    ship: { x: Math.round(rand(rng, -0.5, 0.5) * E * 0.9), z: Math.round(E * 0.72) },
    goal: { x: Math.round(rand(rng, -0.55, 0.55) * E * 0.9), z: Math.round(-E * 0.73), r: +goalR.toFixed(1) },
  };
}

function sampleSet1(rng) {
  const E = 56;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 5.8, 6.8)), maxLaunch: 50, fuel: 3, bodies: [] };
  const name = namer(rng);
  const n = rng() < 0.5 ? 1 : 2;
  for (let i = 0; i < n; i++) {
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 350, 1250)),
      radius: +rand(rng, 3, 5).toFixed(1), color: pick(rng, PLANET_COLORS),
      x: Math.round(rand(rng, -0.7, 0.7) * E), z: Math.round(rand(rng, -0.55, 0.55) * E),
    });
  }
  return levelGeometryOk(lv, 18, 16) ? lv : null;
}

function sampleSet2(rng) {
  const E = 60;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 5, 5.6)), maxLaunch: 48, fuel: 3, bodies: [] };
  const name = namer(rng);
  // one big blocker near the pad->goal line
  const mx = (lv.ship.x + lv.goal.x) / 2, mz = (lv.ship.z + lv.goal.z) / 2;
  lv.bodies.push({
    name: name(BODY_NAMES), mass: Math.round(rand(rng, 1600, 2400)),
    radius: +rand(rng, 6, 7.5).toFixed(1), color: pick(rng, PLANET_COLORS),
    x: Math.round(mx + rand(rng, -10, 10)), z: Math.round(mz + rand(rng, -12, 12)),
  });
  const extra = 1 + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < extra; i++) {
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 700, 1500)),
      radius: +rand(rng, 4, 5.5).toFixed(1), color: pick(rng, PLANET_COLORS),
      x: Math.round(rand(rng, -0.75, 0.75) * E), z: Math.round(rand(rng, -0.6, 0.6) * E),
    });
  }
  return levelGeometryOk(lv, 15, 13) ? lv : null;
}

function sampleSet3(rng) {
  const E = 62;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.6, 5.4)), maxLaunch: 48, fuel: 3.5, bodies: [] };
  const name = namer(rng);
  const nRep = rng() < 0.45 ? 2 : 1;
  for (let i = 0; i < nRep; i++) {
    const mx = (lv.ship.x + lv.goal.x) / 2, mz = (lv.ship.z + lv.goal.z) / 2;
    lv.bodies.push({
      name: name(REPULSOR_NAMES), mass: -Math.round(rand(rng, 900, 1800)),
      radius: +rand(rng, 4, 5).toFixed(1), color: 0xff6b35,
      x: Math.round(mx + rand(rng, -0.35, 0.35) * E), z: Math.round(mz + rand(rng, -0.35, 0.35) * E),
    });
  }
  const nPl = 1 + (rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < nPl; i++) {
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 800, 1600)),
      radius: +rand(rng, 4, 5.5).toFixed(1), color: pick(rng, PLANET_COLORS),
      x: Math.round(rand(rng, -0.75, 0.75) * E), z: Math.round(rand(rng, -0.6, 0.6) * E),
    });
  }
  return levelGeometryOk(lv, 15, 12) ? lv : null;
}

function sampleSet4(rng) {
  const E = 64;
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.8, 5.2)), maxLaunch: 48, fuel: 4, bodies: [] };
  const name = namer(rng);
  if (rng() < 0.35) {
    // binary pair waltzing around a shared center
    const cx = Math.round(rand(rng, -0.2, 0.2) * E), cz = Math.round(rand(rng, -0.25, 0.15) * E);
    const r = +rand(rng, 10, 15).toFixed(1), om = +(sign(rng) * rand(rng, 0.3, 0.55)).toFixed(2);
    const ph = +rand(rng, 0, Math.PI * 2).toFixed(2);
    for (let i = 0; i < 2; i++) {
      lv.bodies.push({
        name: name(BODY_NAMES), mass: Math.round(rand(rng, 1000, 1400)),
        radius: +rand(rng, 4.5, 5.5).toFixed(1), color: pick(rng, PLANET_COLORS),
        orbit: { cx, cz, radius: r, omega: om, phase: +(ph + i * Math.PI).toFixed(2) },
      });
    }
  } else {
    // planet with orbiting moon(s)
    const px = Math.round(rand(rng, -0.25, 0.25) * E), pz = Math.round(rand(rng, -0.3, 0.15) * E);
    const planet = {
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 1800, 2600)),
      radius: +rand(rng, 6.5, 7.5).toFixed(1), color: pick(rng, PLANET_COLORS), x: px, z: pz,
    };
    lv.bodies.push(planet);
    const nMoons = rng() < 0.3 ? 2 : 1;
    let lastR = planet.radius + 6;
    for (let i = 0; i < nMoons; i++) {
      const orbR = +rand(rng, lastR + 6, lastR + 12).toFixed(1);
      lastR = orbR;
      lv.bodies.push({
        name: name(BODY_NAMES), mass: Math.round(rand(rng, 350, 650)),
        radius: +rand(rng, 2.5, 3.5).toFixed(1), color: 0xe2e2e2,
        orbit: { parent: 0, radius: orbR, omega: +(sign(rng) * rand(rng, 0.45, 0.9)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
      });
    }
  }
  if (rng() < 0.5) {
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 600, 1200)),
      radius: +rand(rng, 3.5, 5).toFixed(1), color: pick(rng, PLANET_COLORS),
      x: Math.round(rand(rng, -0.78, 0.78) * E), z: Math.round(rand(rng, -0.6, 0.6) * E),
    });
  }
  return levelGeometryOk(lv, 14, 11) ? lv : null;
}

function sampleSet5(rng) {
  const E = Math.round(rand(rng, 66, 74));
  const lv = { extent: E, ...padAndGoal(rng, E, rand(rng, 4.5, 5)), maxLaunch: 48, fuel: 5, bodies: [] };
  const name = namer(rng);
  // sun at the heart of the system
  const sx = Math.round(rand(rng, -0.12, 0.12) * E), sz = Math.round(rand(rng, -0.18, 0.08) * E);
  lv.bodies.push({
    name: pick(rng, ['Sol', 'Helios', 'Aurum', 'Tsuki', 'Vera']), mass: Math.round(rand(rng, 2600, 3800)),
    radius: +rand(rng, 8, 9.5).toFixed(1), color: pick(rng, SUN_COLORS), x: sx, z: sz,
  });
  // planets on spaced circular orbits (inner ring clears the sun, spacing
  // clears ring-to-ring separation, cap keeps rings away from the pad)
  const nPl = 2 + (rng() < 0.6 ? 1 : 0);
  let orbR = Math.max(21, rand(rng, 0.26, 0.3) * E);
  for (let i = 0; i < nPl; i++) {
    if (orbR > E * 0.62) break;
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 500, 1100)),
      radius: +rand(rng, 3.5, 5).toFixed(1), color: pick(rng, PLANET_COLORS),
      orbit: { cx: sx, cz: sz, radius: +orbR.toFixed(1), omega: +(sign(rng) * rand(rng, 0.15, 0.45)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
    orbR += Math.max(17, rand(rng, 0.16, 0.2) * E);
  }
  // occasional moon on the outermost planet
  if (rng() < 0.4) {
    const pIdx = lv.bodies.length - 1;
    lv.bodies.push({
      name: name(BODY_NAMES), mass: Math.round(rand(rng, 180, 300)),
      radius: +rand(rng, 2, 2.5).toFixed(1), color: 0xe2e2e2,
      orbit: { parent: pIdx, radius: +rand(rng, 8, 11).toFixed(1), omega: +(sign(rng) * rand(rng, 0.8, 1.2)).toFixed(2), phase: +rand(rng, 0, 6.28).toFixed(2) },
    });
  }
  // occasional black hole lurking off-system
  if (rng() < 0.45) {
    const ang = rand(rng, 0, Math.PI * 2);
    const d = orbR + rand(rng, 12, 20);
    lv.bodies.push({
      name: name(HOLE_NAMES), mass: Math.round(rand(rng, 3500, 4800)),
      radius: 3, horizon: +rand(rng, 5.5, 6.5).toFixed(1), color: 0x1a1a2e, type: 'blackhole',
      x: Math.round(sx + Math.cos(ang) * d), z: Math.round(sz + Math.sin(ang) * d),
    });
  }
  // occasional repulsor
  if (rng() < 0.3) {
    lv.bodies.push({
      name: name(REPULSOR_NAMES), mass: -Math.round(rand(rng, 1000, 1600)),
      radius: +rand(rng, 4, 5).toFixed(1), color: 0xff6b35,
      x: Math.round(rand(rng, -0.7, 0.7) * E), z: Math.round(rand(rng, -0.5, 0.5) * E),
    });
  }
  return levelGeometryOk(lv, 14, 11) ? lv : null;
}

// ---------------------------------------------------------------------------
// Sets: themes, difficulty bands (coarse-grid win %), names, hints
// ---------------------------------------------------------------------------
const ORIGINALS = {
  liftoff: { name: 'Liftoff', hint: 'Drag back from your ship to aim — like a slingshot — then release to launch!', extent: 60, ship: { x: 0, z: 42 }, goal: { x: 0, z: -40, r: 7 }, maxLaunch: 50, fuel: 3, bodies: [{ name: 'Pebble', mass: 260, radius: 3, color: 0x8ecae6, x: -34, z: -4 }] },
  thedip: { name: 'The Dip', hint: 'That well will bend your shot. Watch the prediction line and aim off-center.', extent: 60, ship: { x: 0, z: 42 }, goal: { x: 0, z: -42, r: 5.5 }, maxLaunch: 50, fuel: 3, bodies: [{ name: 'Mint', mass: 1300, radius: 5, color: 0x7ae582, x: 15, z: 0 }] },
  slingshot: { name: 'Slingshot', hint: 'No way through — so curve around. Dive into the well and let it fling you!', extent: 60, ship: { x: 0, z: 44 }, goal: { x: 0, z: -44, r: 5 }, maxLaunch: 48, fuel: 3, bodies: [{ name: 'Rusty', mass: 2100, radius: 7, color: 0xff8fa3, x: 0, z: -2 }] },
  saddle: { name: 'The Saddle', hint: 'Two wells, one ridge between them. Thread the saddle — or swing wide.', extent: 62, ship: { x: -10, z: 44 }, goal: { x: 4, z: -44, r: 4.5 }, maxLaunch: 48, fuel: 3, bodies: [{ name: 'Castor', mass: 1500, radius: 6, color: 0xffd166, x: -16, z: 0 }, { name: 'Pollux', mass: 1500, radius: 6, color: 0xf4a261, x: 16, z: 0 }] },
  repulsor: { name: 'Repulsor Ridge', hint: 'That hill pushes you AWAY. Ride the pass between the hill and the well.', extent: 62, ship: { x: 0, z: 44 }, goal: { x: 0, z: -44, r: 5 }, maxLaunch: 48, fuel: 3.5, bodies: [{ name: 'Nope', mass: -1200, radius: 4.5, color: 0xff6b35, x: -12, z: 0 }, { name: 'Anchor', mass: 1300, radius: 5, color: 0x90e0ef, x: 16, z: -2 }] },
  moonshot: { name: 'Moonshot', hint: 'The moon keeps moving — even while you aim. Time your release!', extent: 62, ship: { x: 0, z: 44 }, goal: { x: 0, z: -46, r: 5 }, maxLaunch: 48, fuel: 3.5, bodies: [{ name: 'Aegis', mass: 2200, radius: 7, color: 0xbde0fe, x: 0, z: -4 }, { name: 'Luna', mass: 520, radius: 3, color: 0xe2e2e2, orbit: { parent: 0, radius: 20, omega: 0.7, phase: 0.8 } }] },
  horizon: { name: 'Event Horizon', hint: 'Nothing escapes the red ring. Skim close for a huge slingshot — but not TOO close.', extent: 64, ship: { x: -38, z: 44 }, goal: { x: 34, z: -44, r: 4.5 }, maxLaunch: 44, fuel: 4, bodies: [{ name: 'Maw', mass: 5200, radius: 3.5, horizon: 6.5, color: 0x1a1a2e, x: 0, z: 0, type: 'blackhole' }] },
  grandtour: { name: 'Grand Tour', hint: 'Everything at once. Take your time — plot the long way round.', extent: 74, ship: { x: 30, z: 56 }, goal: { x: -34, z: -50, r: 5 }, maxLaunch: 48, fuel: 5, bodies: [{ name: 'Titan', mass: 1700, radius: 6, color: 0xffd166, x: 26, z: 14 }, { name: 'Wisp', mass: 420, radius: 2.5, color: 0xe2e2e2, orbit: { parent: 0, radius: 15, omega: 0.8, phase: 2.1 } }, { name: 'Nope II', mass: -1600, radius: 4.5, color: 0xff6b35, x: 2, z: -4 }, { name: 'Maw II', mass: 4200, radius: 3, horizon: 5.5, color: 0x1a1a2e, x: -26, z: -18, type: 'blackhole' }] },
};

const SETS = [
  {
    name: 'Cadet Orbits', difficulty: 1, sample: sampleSet1, band: [1.6, 5],
    originals: [ORIGINALS.liftoff, ORIGINALS.thedip],
    hint: 'Small wells, gentle bends. Learn to read the terrain.',
    names: ['First Glide', 'Two Stones', 'Long Coast', 'Soft Curve', 'Downhill Run', 'Easy Does It', 'Twin Dimples', 'Drift Lane', 'Warm Up', 'Graduation'],
  },
  {
    name: 'Slingshot Academy', difficulty: 2, sample: sampleSet2, band: [0.9, 2.2],
    originals: [ORIGINALS.slingshot, ORIGINALS.saddle],
    hint: 'Big wells block the way. Dive in and let gravity throw you.',
    names: ['Around the Bend', 'Deep Dive', 'Hairpin', 'Double Trouble', 'The Long Way', 'Whiplash', 'Corner Pocket', 'Gravity Assist', 'Full Send', 'Masterclass'],
  },
  {
    name: 'Repulsor Fields', difficulty: 3, sample: sampleSet3, band: [0.55, 1.5],
    originals: [ORIGINALS.repulsor],
    hint: 'Orange hills push you away. Ride the passes between push and pull.',
    names: ['Uphill Battle', 'The Pass', 'Push and Pull', 'Ridge Runner', 'Between Hills', 'Backpressure', 'Crosswind', 'The Squeeze', 'Turbulence', 'Summit'],
  },
  {
    name: 'Clockwork Moons', difficulty: 4, sample: sampleSet4, band: [0.35, 1.3],
    originals: [ORIGINALS.moonshot],
    hint: 'Everything is moving — even while you aim. Timing is everything.',
    names: ['Tick Tock', 'Orbit Window', 'Waltz', 'Phase Shift', 'Pendulum', 'Metronome', 'Eclipse', 'Revolution', 'Perfect Timing', 'Clockwork'],
  },
  {
    name: 'Deep Space', difficulty: 5, sample: sampleSet5, band: [0.08, 0.9],
    originals: [ORIGINALS.horizon, ORIGINALS.grandtour],
    hint: 'Whole solar systems between you and the goal. Chart your course.',
    names: ['Outer Rim', 'Three-Body Problem', 'Star System', 'Dark Passage', 'Planetfall', 'The Gauntlet', 'Singularity', 'Far Shore', 'Last Light', 'GravityLoop'],
  },
];

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
const MIN_WINS = 3;       // coarse-grid floor so `solve.js --fast` always passes
const ATTEMPTS = 200;

const allLevels = [];
for (let s = 0; s < SETS.length; s++) {
  const set = SETS[s];
  const entries = [];
  for (const orig of set.originals) {
    const r = solveCoarse(orig);
    entries.push({ level: orig, rate: r.rate, wins: r.wins, original: true });
    console.log(`[set ${s + 1}] original  ${orig.name.padEnd(18)} rate ${r.rate.toFixed(2)}% wins ${r.wins}`);
  }
  const need = 10 - set.originals.length;
  for (let slot = 0; slot < need; slot++) {
    let best = null;
    let found = null;
    let geoOk = 0, solvable = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const rng = mulberry32(1e6 + s * 100003 + slot * 1009 + attempt);
      const lv = set.sample(rng);
      if (!lv) continue;
      geoOk++;
      const r = solveCoarse(lv);
      if (r.wins < MIN_WINS) continue;
      solvable++;
      const inBand = r.rate >= set.band[0] && r.rate <= set.band[1];
      const distToBand = inBand ? 0 : Math.min(Math.abs(r.rate - set.band[0]), Math.abs(r.rate - set.band[1]));
      if (!best || distToBand < best.distToBand) best = { level: lv, rate: r.rate, wins: r.wins, distToBand };
      if (inBand) { found = { level: lv, rate: r.rate, wins: r.wins }; break; }
    }
    const chosen = found || best;
    if (!chosen) throw new Error(`set ${s + 1} slot ${slot}: no solvable candidate (geoOk ${geoOk}/${ATTEMPTS}, solvable ${solvable})`);
    entries.push(chosen);
    console.log(`[set ${s + 1}] generated slot ${slot}  rate ${chosen.rate.toFixed(2)}% wins ${chosen.wins}${found ? '' : '  (closest to band)'}`);
  }
  // easiest first within the set
  entries.sort((a, b) => b.rate - a.rate);
  entries.forEach((e, i) => {
    if (!e.original) {
      e.level.name = set.names[i];
      e.level.hint = set.hint;
    }
    e.level.difficulty = set.difficulty;
    allLevels.push(e.level);
  });
}

// ---------------------------------------------------------------------------
// Emit src/levels.js
// ---------------------------------------------------------------------------
const setsOut = SETS.map(s => ({ name: s.name, difficulty: s.difficulty }));
let js = `// GravityLoop — level data (50 levels in 5 themed sets of 10).
// GENERATED by tools/generate.js — edit that file and re-run:
//   node tools/generate.js
// Coordinates: x is right, z is toward the camera (ship starts at +z).
// mass < 0 makes a repulsor (a hill instead of a well).

export const SETS = ${JSON.stringify(setsOut, null, 2)};

export const LEVELS = ${JSON.stringify(allLevels, null, 2)};
`;
// hex-ify colors for readability (still valid JS, no longer strict JSON)
js = js.replace(/"color": (\d+)/g, (_, n) => `"color": 0x${Number(n).toString(16)}`);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'levels.js');
fs.writeFileSync(out, js);
console.log(`\nWrote ${allLevels.length} levels to ${out}`);
