// One definition of "check the geometry over time", shared by the tool that
// fixes it (tools/orbits.js) and the gate that verifies it
// (tools/overlap-check.mjs). They disagreed when each picked its own window
// and step: the gate found collisions the fixer had stepped straight over.
//
// Also one definition of which pairs of drawn things are allowed to touch.

// Clear space required between two drawn discs, in world units.
export const BODY_GAP = 0.6;
// A station parked beside its own world needs less, but not none.
export const STATION_GAP = 0.35;

// Sweep the slowest full period present, so a collision four minutes into a
// twenty-minute orbit is still seen, sampled fine enough that nothing crosses
// a target between samples at the speeds these levels use.
export function sweepPlan(level) {
  let slowest = 0;
  const note = o => {
    if (o && o.omega) slowest = Math.max(slowest, (2 * Math.PI) / Math.abs(o.omega));
  };
  for (const b of level.bodies) note(b.orbit);
  for (const h of level.hazards || []) { note(h.orbit); note(h.comet); }
  return { T: Math.min(Math.max(slowest * 1.05, 120), 1400), step: 0.75 };
}

// An asteroid field is drawn as a drifting cloud of grains scattered on the
// grid, not as a set of solid objects: grains may sit against one another, and
// a world floating above the surface may pass over the cloud. What must stay
// clear of the dust is anything the player has to see and fly through — a
// docking ring buried in grains is unreadable.
export function isSolidVsDust(a, b) {
  return (a.dust && b.target) || (b.dust && a.target);
}

// Required clearance between two drawn discs, or null when the pair is exempt.
// `a`/`b`: { r, dust, target, idx, host }
export function requiredGap(level, a, b) {
  if (a.host != null && a.host === b.idx) return STATION_GAP;
  if (b.host != null && b.host === a.idx) return STATION_GAP;
  if (a.dust || b.dust) return isSolidVsDust(a, b) ? BODY_GAP : null;
  if (kin(level, a, b)) return 0;      // a moon may touch its planet, not enter it
  return BODY_GAP;
}

export function kin(level, a, b) {
  if (a.idx == null || b.idx == null) return false;
  const bi = level.bodies[a.idx], bj = level.bodies[b.idx];
  const pi = bi.moonOf != null ? bi.moonOf : (bi.orbit && bi.orbit.parent);
  const pj = bj.moonOf != null ? bj.moonOf : (bj.orbit && bj.orbit.parent);
  return pi === b.idx || pj === a.idx || (pi != null && pi === pj);
}

export function drawRadius(b) {
  return b.type === 'blackhole' ? Math.max(b.radius, b.horizon || 0) : b.radius;
}
