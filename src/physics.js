// GravityLoop — pure physics core.
// No rendering dependencies: imported by the browser game and by tools/solve.js (Node).

export const G = 1;
export const SHIP_R = 1.2;          // ship collision radius
export const STEP = 1 / 120;        // fixed physics timestep (s)
export const PREDICT_T = 10;        // seconds of trajectory prediction
export const HEIGHT_K = 0.09;       // potential -> terrain height scale
export const DEPTH_MAX = 26;        // terrain depth clamp
export const OOB_FACTOR = 1.35;     // out-of-bounds beyond extent * factor

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

// Collision/goal/bounds check. Returns null while flight continues, else
// { type: 'crash'|'goal'|'oob', body? }.
export function checkState(level, x, z, positions) {
  for (let i = 0; i < level.bodies.length; i++) {
    const b = level.bodies[i], p = positions[i];
    const dx = p.x - x, dz = p.z - z;
    const hit = (b.horizon || b.radius) + SHIP_R * 0.7;
    if (dx * dx + dz * dz < hit * hit) return { type: 'crash', body: i };
  }
  const gx = level.goal.x - x, gz = level.goal.z - z;
  if (gx * gx + gz * gz < level.goal.r * level.goal.r) return { type: 'goal' };
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

// Ballistic trajectory prediction from a launch state (no thrust).
// Returns { points: [{x,z}...], outcome: 'goal'|'crash'|'oob'|'fly', body? }.
export function predict(level, x, z, vx, vz, t0, seconds = PREDICT_T) {
  const ship = { x, z, vx, vz };
  const points = [{ x, z, t: 0 }];
  const steps = Math.floor(seconds / STEP);
  for (let i = 1; i <= steps; i++) {
    const positions = stepShip(level, ship, t0 + i * STEP, STEP);
    if (i % 3 === 0) points.push({ x: ship.x, z: ship.z, t: i * STEP });
    const st = checkState(level, ship.x, ship.z, positions);
    if (st) {
      points.push({ x: ship.x, z: ship.z, t: i * STEP });
      return { points, outcome: st.type, body: st.body, time: i * STEP };
    }
  }
  return { points, outcome: 'fly' };
}
