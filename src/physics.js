// GravityLoop — pure physics core.
// No rendering dependencies: imported by the browser game and by the Node
// tools (solver, generator).

export const G = 1;
export const SHIP_R = 0.6;          // ship collision radius (matches shrunken visual)
export const STEP = 1 / 120;        // fixed physics timestep (s)
export const PREDICT_T = 30;        // seconds of trajectory prediction
export const HEIGHT_K = 0.09;       // potential -> terrain height scale
export const DEPTH_MAX = 26;        // terrain depth clamp
export const OOB_FACTOR = 1.35;     // out-of-bounds beyond extent * factor
export const LAUNCH_FUEL_MAX = 2.2; // fuel cost of a full-power launch (quadratic in power)

export function launchFuelCost(speed, maxLaunch) {
  const p = Math.min(speed / maxLaunch, 1);
  return LAUNCH_FUEL_MAX * p * p;
}

// Max launch speed affordable with the given fuel.
export function maxAffordableLaunch(fuel, maxLaunch) {
  if (fuel >= LAUNCH_FUEL_MAX) return maxLaunch;
  return maxLaunch * Math.sqrt(Math.max(fuel, 0) / LAUNCH_FUEL_MAX);
}

// Positions of all bodies at sim time t. Orbiting bodies may reference an
// earlier body as parent (parent index must be < child index).
export function bodiesAt(level, t) {
  const out = [];
  for (const b of level.bodies) {
    if (b.orbit) {
      const o = b.orbit;
      const c = o.parent != null ? out[o.parent] : { x: o.cx || 0, z: o.cz || 0 };
      const a = (o.phase || 0) + o.omega * t;
      out.push({ x: c.x + Math.cos(a) * o.radius, z: c.z + Math.sin(a) * o.radius });
    } else {
      out.push({ x: b.x, z: b.z });
    }
  }
  return out;
}

// Positions of hazard ships at sim time t. Hazards are massless obstacles:
// static derelicts/asteroids, circular patrols ({orbit}), ping-pong patrols
// ({patrol}), or comets on slow elliptical orbits
// ({comet: {cx, cz, a, b, rot, omega, phase}}).
export function hazardsAt(level, t) {
  if (!level.hazards) return EMPTY;
  const out = [];
  for (const h of level.hazards) {
    if (h.comet) {
      const c = h.comet;
      const th = (c.phase || 0) + c.omega * t;
      const px = Math.cos(th) * c.a, pz = Math.sin(th) * c.b;
      const cos = Math.cos(c.rot || 0), sin = Math.sin(c.rot || 0);
      out.push({ x: c.cx + px * cos - pz * sin, z: c.cz + px * sin + pz * cos });
    } else if (h.orbit) {
      const o = h.orbit;
      const a = (o.phase || 0) + o.omega * t;
      out.push({ x: (o.cx || 0) + Math.cos(a) * o.radius, z: (o.cz || 0) + Math.sin(a) * o.radius });
    } else if (h.patrol) {
      const p = h.patrol;
      const ph = ((t / p.period + (p.phase || 0)) % 1 + 1) % 1;
      const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      out.push({ x: p.x1 + (p.x2 - p.x1) * tri, z: p.z1 + (p.z2 - p.z1) * tri });
    } else {
      out.push({ x: h.x, z: h.z });
    }
  }
  return out;
}
const EMPTY = [];

// Launch pads and stations are structures in orbit, not points painted on
// space: one anchored to body `b` keeps a fixed offset from it and rides
// along. `positions` comes from bodiesAt(level, t) — omit it for t = 0.
export function anchorX(spot, positions) {
  return spot.anchor && positions ? positions[spot.anchor.body].x + spot.anchor.dx : spot.x;
}
export function anchorZ(spot, positions) {
  return spot.anchor && positions ? positions[spot.anchor.body].z + spot.anchor.dz : spot.z;
}

// The target the ship must reach next: waypoint `stage`, or the goal once all
// waypoints are done. Levels without waypoints go straight for the goal.
export function activeTarget(level, stage, positions) {
  const wps = level.waypoints || EMPTY;
  const s = stage < wps.length ? wps[stage] : level.goal;
  return {
    x: anchorX(s, positions), z: anchorZ(s, positions), r: s.r,
    kind: stage < wps.length ? 'waypoint' : 'goal',
    index: stage < wps.length ? stage : undefined,
  };
}

// Where the ship launches from for a given stage, at the given body positions.
export function legStart(level, stage, positions) {
  const wps = level.waypoints || EMPTY;
  const s = stage === 0 ? level.ship : wps[stage - 1];
  return { x: anchorX(s, positions), z: anchorZ(s, positions) };
}

export function legCount(level) {
  return (level.waypoints ? level.waypoints.length : 0) + 1;
}

// Gravitational acceleration at a point (softened inverse-square).
export function accelAt(level, x, z, positions) {
  let ax = 0, az = 0;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i], p = positions[i];
    const dx = p.x - x, dz = p.z - z;
    const eps = b.radius * 0.5;
    const r2 = dx * dx + dz * dz + eps * eps;
    const f = (G * b.mass) / (r2 * Math.sqrt(r2));
    ax += dx * f;
    az += dz * f;
  }
  return { x: ax, z: az };
}

// Terrain height = scaled gravitational potential (negative in wells,
// positive on repulsor hills).
//
// This is a VISUALISATION, not the force law: gravity itself comes from
// accelAt, and nothing in the solver or generator reads this function. So the
// surface can be restyled freely for legibility without touching gameplay.
//
//   soft — softening in body radii. Larger rounds the spike at the centre into
//          a bowl instead of a needle that saturates the depth clamp.
//   exp  — distance falloff. Below 1 spreads a well wider for the same depth,
//          which is what makes a sun's dominance visible as breadth (the
//          planets orbit inside its bowl) rather than as one deep puncture.
//          Normalised at REF so overall scale holds as exp changes.
//   comp — logarithmic depth compression instead of a hard clamp, so a deep
//          well keeps its shape rather than being cut flat.
// `round: false` keeps a hard distance floor at 1.1 body radii, which is the
// original shape — a needle that saturates the depth clamp. `round: true`
// softens the centre instead, so the spike becomes a bowl.
//   gain — overall depth multiplier, so a well widened by a flatter falloff
//          can be pushed back down to a clearly-visible depth instead of
//          reading as a shallow dish.
//   depth — the depth SCALE, not a limit: the drawn surface tracks the raw
//          field one-for-one while shallower than this and compresses
//          logarithmically past it, so there is no floor to hit.
// Shipped shape: centres rounded just enough to stop a body sitting in a
// needle, and true 1/r falloff kept deliberately — flattening it spreads mass
// influence outward but tilts the whole sheet, which washes local wells out
// entirely.
//
// Gain and compression work as a pair. A hard clamp spends the whole height
// range on the deep wells and leaves the far field within a couple of units of
// level, so ground that is still pulling hard draws as flat. Raising gain
// amplifies that gentle far-field slope into something you can see, and the
// compressor then keeps the deep wells in range instead of letting them run
// away. The surface is no longer level anywhere there is mass, which is the
// point.
//
// The compressor must not saturate, which tanh does. Its slope goes to zero,
// so past about 3x depth every different amount of gravity is drawn at the
// same height and the picture stops carrying information. Measured on the
// shipped campaign: across the deepest 5% of a map the drawn surface varied by
// a median of 1.36 units, and on 18 of 50 levels that entire deepest region
// came out within 1 unit of flat — level 47's black hole and its star both sat
// on a plateau with no well at all. log1p never saturates: its slope falls off
// but stays positive, so a heavier body is always drawn deeper than a lighter
// one. Same 50 levels afterwards: median 6.54 units of relief across that
// region, worst case 5.39, none flat.
//
// Normalised so that -depth * log1p(-h/depth) tracks the old tanh curve while
// wells are shallow (-5 -> -4.6 against -4.9, -13 -> -10.5 against -12.0) and
// only diverges where the old one was already flattening out. Levels that
// looked right keep looking the way they did.
export const VIS = { round: true, soft: 1.35, exp: 1, comp: true, gain: 3, depth: 26 };
const REF = 20;
export function heightAt(level, x, z, positions) {
  let h = 0;
  const { round, soft, exp, comp, gain, depth } = VIS;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i], p = positions[i];
    const dx = p.x - x, dz = p.z - z;
    const r2 = dx * dx + dz * dz;
    const d = round
      ? Math.sqrt(r2 + b.radius * soft * (b.radius * soft))
      : Math.max(Math.sqrt(r2), b.radius * 1.1);
    h -= (HEIGHT_K * gain * b.mass) * (exp === 1 ? 1 / d : Math.pow(REF, exp - 1) / Math.pow(d, exp));
  }
  if (comp) return -depth * Math.log1p(-h / depth);
  return Math.max(Math.min(h, depth), -depth);
}

// Collision/target/bounds check for one instant of flight. Returns null while
// flight continues, else:
//   { type: 'crash', body }     — hit a planet / black hole horizon
//   { type: 'hazard', hazard }  — hit a hazard ship
//   { type: 'waypoint', index } — reached the active waypoint (dock)
//   { type: 'goal' }            — reached the goal (only on the final leg)
//   { type: 'oob' }             — drifted out of bounds
export function checkState(level, x, z, positions, hazPositions, stage) {
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i], p = positions[i];
    const dx = p.x - x, dz = p.z - z;
    // hug the drawn silhouette: a wider margin registers a crash while the
    // ship is visibly clear of the planet
    const hit = (b.horizon || b.radius) + SHIP_R * 0.25;
    if (dx * dx + dz * dz < hit * hit) return { type: 'crash', body: i };
  }
  if (level.hazards) {
    for (let i = 0; i < level.hazards.length; i++) {
      const h = level.hazards[i], p = hazPositions[i];
      const dx = p.x - x, dz = p.z - z;
      const hit = h.radius + SHIP_R * 0.25;
      if (dx * dx + dz * dz < hit * hit) return { type: 'hazard', hazard: i };
    }
  }
  const tgt = activeTarget(level, stage, positions);
  const gx = tgt.x - x, gz = tgt.z - z;
  if (gx * gx + gz * gz < tgt.r * tgt.r) {
    return tgt.kind === 'goal' ? { type: 'goal' } : { type: 'waypoint', index: tgt.index };
  }
  const lim = level.extent * OOB_FACTOR;
  if (Math.abs(x) > lim || Math.abs(z) > lim) return { type: 'oob' };
  return null;
}

// One semi-implicit Euler substep. thrust is optional {x,z} acceleration.
export function stepShip(level, ship, t, h, thrust) {
  const positions = bodiesAt(level, t);
  const a = accelAt(level, ship.x, ship.z, positions);
  ship.vx += (a.x + (thrust ? thrust.x : 0)) * h;
  ship.vz += (a.z + (thrust ? thrust.z : 0)) * h;
  ship.x += ship.vx * h;
  ship.z += ship.vz * h;
  return positions;
}

// Ballistic trajectory prediction for one leg (no thrust).
// Returns { points: [{x,z,t}...], outcome, body?, hazard?, index?, time? }
// where outcome is 'goal'|'waypoint'|'crash'|'hazard'|'oob'|'fly'.
export function predict(level, x, z, vx, vz, t0, seconds = PREDICT_T, stage = 0) {
  const ship = { x, z, vx, vz };
  const points = [{ x, z, t: 0 }];
  const steps = Math.floor(seconds / STEP);
  for (let i = 1; i <= steps; i++) {
    const t = t0 + i * STEP;
    const positions = stepShip(level, ship, t, STEP);
    if (i % 3 === 0) points.push({ x: ship.x, z: ship.z, t: i * STEP });
    const hazPositions = hazardsAt(level, t);
    const st = checkState(level, ship.x, ship.z, positions, hazPositions, stage);
    if (st) {
      points.push({ x: ship.x, z: ship.z, t: i * STEP });
      return { points, outcome: st.type, body: st.body, hazard: st.hazard, index: st.index, time: i * STEP };
    }
  }
  return { points, outcome: 'fly' };
}
