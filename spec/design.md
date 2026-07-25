# GravityLoop — Design

How the requirements in [`requirements.md`](requirements.md) are satisfied.
This is the technical design an implementing agent should follow; where a
decision was reached the hard way, the rationale is recorded so it is not
re-litigated.

## Module layout

| Module | Responsibility | Key requirements |
| --- | --- | --- |
| `src/physics.js` | Pure simulation core: gravity, integration, orbits, anchors, collision, prediction. No DOM, no Three.js. | REQ-PHY-* |
| `src/levels.js` | Generated level data. Never hand-edited. | REQ-LVL-1 |
| `src/main.js` | Rendering, input, camera, HUD, game state machine. | REQ-CTL-*, REQ-VIS-* |
| `src/textures.js` | Procedural canvas textures, including named-world recipes. | REQ-VIS-3, REQ-VIS-4 |
| `src/changelog.js` | Player-facing release notes. | REQ-PRG-3 |
| `src/audio.js` | WebAudio synthesis; no sound assets. | REQ-SCOPE-2 |
| `tools/generate.js` | Seeded level search with solver-verified difficulty. | REQ-LVL-*, REQ-VER-4 |
| `tools/orbits.js` | Orbit assignment, anchoring and speed verification. | REQ-MOT-* |
| `tools/solve.js` | Offline brute-force winnability checker. | REQ-VER-1 |
| `tools/ui-test.mjs` | Headless HUD-overflow test. | REQ-VER-2 |

**The shared core is the load-bearing decision.** `physics.js` is imported
unchanged by both the browser and Node, so the solver's verdict and the
player's experience cannot diverge (REQ-PHY-1). Nothing that touches
trajectory outcome may live anywhere else.

## Data model

```js
level = {
  extent, maxLaunch, fuel, difficulty, name, hint,
  ship:  { x, z, anchor? },              // launch pad
  goal:  { x, z, r, anchor? },
  waypoints?: [{ x, z, r, type, anchor? }],   // stations, cargo, dropoff
  pickups?:   [{ x, z, fuel }],
  bodies: [{ name, mass, radius, color, x?, z?, type?, moonOf?, orbit? }],
  hazards?: [{ radius, x?, z?, orbit? | patrol? | comet? }],
}
orbit  = { parent?, cx, cz, radius, omega, phase }   // position at time t
anchor = { body, dx, dz }                            // rides that body
```

A body carries either static `x`/`z` **or** an `orbit`, never both.
`bodiesAt(level, t)` resolves the whole system at a time; `anchorX`/`anchorZ`
resolve a pad or station against those positions. `activeTarget()` and
`legStart()` therefore both take positions and are time-dependent — this is
what makes REQ-PHY-7 true throughout the stack, including in the solver.

## Level generation

Sampling is seeded per `(set, slot, attempt)` with a small deterministic PRNG,
so a slot search is reproducible anywhere (REQ-VER-4). Each candidate is
scored by distance from the set's target difficulty band, with penalties added
for falling short of the turning floors (REQ-LVL-3); because the gates are
penalties rather than hard filters, a slot always yields its best available
candidate rather than failing.

Heavy slots split their attempt range into shards. The merge rule — earliest
attempt with distance 0, else lowest distance breaking ties by earliest
attempt — reproduces the serial pick exactly, which is what licenses fanning
the search across CI runners.

## Orbit assignment

Assignment runs as a separate pass over already-generated levels, so level
layouts survive intact (REQ-MOT-3):

1. **Anchor** every pad and station within 12 units of a body's surface to
   that body (REQ-MOT-6).
2. **Freeze** bodies whose orbital circle would cross a pad or station they do
   not carry. This is checked geometrically in world space, and additionally
   in *parent-relative* space for a moon and a station sharing a planet —
   their relative geometry is fixed, so if the ring crosses the station once
   it always will.
3. **Assign** orbits with the per-set speed ramp, scaled Kepler-style.
4. **Verify** with the real solver and back the level's speed off through a
   fixed ladder until every leg passes (REQ-MOT-4).

> **Why freezing rather than slowing.** Slowing an orbit does not move its
> path. A body whose circle crosses a fixed station collides with it
> eventually at any speed; a time-sampled check merely pushes the collision
> past the sampling window and reports a false pass. Three separate bugs in
> this project traced to that single mistake, including four levels that went
> completely motionless because a pass/fail check froze an entire system over
> one conflict. Freeze the offending body; never trust a slower speed to fix
> geometry.

## Rendering

One indexed `LineSegments` grid is displaced per frame by the potential
(REQ-VIS-1). At full density this is too expensive to redo every frame once
everything moves, so the deform is gated on displacement: it re-runs only once
some body has moved a fraction of a grid cell (REQ-VIS-2). On slow early
levels that is a few times a second; on fast alien systems it is every frame.
This preserves grid density without a motion penalty.

Start framing (REQ-VIS-7) binary-searches camera distance against a projection
of the target ring and the ship at the live viewport aspect. A distance
heuristic was tried first and consistently left large empty margins; solving
for the constraint is both simpler to reason about and correct on every
screen.

## Aim pipeline

Ordering matters, and is: raw pointer → touch noise smoothing (REQ-CTL-5) →
adaptive gain (REQ-CTL-2/3) → launch vector → prediction. The release-rollback
history stores post-gain values, so a rolled-back launch uses the aim the
player actually dialed in. Because gain decouples the handle from the vector,
the telemetry readout (REQ-CTL-4) reports the resolved vector, not the input.

## Verification strategy

Difficulty, winnability and orbit speed are **measured, never argued**. Every
claim of the form "this level is playable" is the output of running the real
physics over a brute-force grid of launches. The solver samples release times
as well as angle and power on levels with motion, which is why it is
substantially slower now that every level moves — an accepted cost, since it
is the only thing standing between the campaign and unwinnable levels.

For anything the player sees, options are rendered from a working copy with
headless Chromium and chosen by a human before implementation. Prose
descriptions of visual options have repeatedly proven misleading; renders have
not.
