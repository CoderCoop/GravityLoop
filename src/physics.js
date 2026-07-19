// GravityLoop — pure physics core.
// No rendering dependencies: imported by the browser game and by the Node
// tools (solver, generator).

export const G = 1;
export const SHIP_R = 1.2;          // ship collision radius
export const STEP = 1 / 120;        // fixed physics timestep (s)
export const PREDICT_T = 30;        // seconds of trajectory prediction
export const HEIGHT_K = 0.09;       // potential -> terrain height scale
export const DEPTH_MAX = 26;        // terrain depth clamp
export const OOB_FACTOR = 1.35;     // out-of-bounds beyond extent * factor
export const LAUNCH_FUEL_MAX = 1.5; // fuel cost of a full-power launch (quadratic in power)

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
// static derelicts, circular patrols ({orbit: {cx, cz, radius, omega, phase}}),
// or ping-pong patrols ({patrol: {x1, z1, x2, z2, period, phase}}).
export function hazardsAt(level, t) {
  if (!level.hazards) return EMPTY;
  const out = [];
  for (const h of level.hazards) {
    if (h.orbit) {
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

// The target the ship must reach next: waypoint `stage`, or the goal once all
// waypoints are done. Levels without waypoints go straight for the goal.
export function activeTarget(level, stage) {
  const wps = level.waypoints || EMPTY;
  if (stage < wps.length) return { x: wps[stage].x, z: wps[stage].z, r: wps[stage].r, kind: 'waypoint', index: stage };
  return { x: level.goal.x, z: level.goal.z, r: level.goal.r, kind: 'goal' };
}

// Where the ship launches from for a given stage.
export function legStart(level, stage) {
  const wps = level.waypoints || EMPTY;
  return stage === 0 ? level.ship : wps[stage - 1];
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
// positive on repulsor hills). Softened so it is finite at body centers.
export function heightAt(level, x, z, positions) {
  let h = 0;
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i], p = positions[i];
    const dx = p.x - x, dz = p.z - z;
    const r = Math.max(Math.sqrt(dx * dx + dz * dz), b.radius * 1.1);
    h -= (HEIGHT_K * b.mass) / r;
  }
  return Math.max(Math.min(h, DEPTH_MAX), -DEPTH_MAX);
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
    const hit = (b.horizon || b.radius) + SHIP_R * 0.7;
    if (dx * dx + dz * dz < hit * hit) return { type: 'crash', body: i };
  }
  if (level.hazards) {
    for (let i = 0; i < level.hazards.length; i++) {
      const h = level.hazards[i], p = hazPositions[i];
      const dx = p.x - x, dz = p.z - z;
      const hit = h.radius + SHIP_R * 0.7;
      if (dx * dx + dz * dz < hit * hit) return { type: 'hazard', hazard: i };
    }
  }
  const tgt = activeTarget(level, stage);
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
