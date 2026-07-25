# Reconstitution prompt — rebuild GravityLoop from scratch

This file is the **spec-as-prompt** for this project: hand it to a capable
coding agent in an empty directory and you should get a game equivalent to
the one in this repo. It follows
[spec-driven development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai/) —
the spec, not the code, is the source of truth; the code is what an agent
produces against it. Conventions for *working on* the existing codebase live
in [`AGENTS.md`](AGENTS.md); this file is for recreating it.

The prompt is deliberately written as requirements plus verification gates
rather than as an implementation. Where a number is load-bearing (physics
constants, difficulty floors) it is given, because those values are the
result of tuning and a fresh derivation will not land in the same place.

---

## The prompt

> Build **GravityLoop**, a browser game: spaceship golf across gravity wells
> rendered as 3D neon wireframe terrain. No build step, no framework, no
> assets — a static page of ES modules plus a vendored copy of Three.js.
>
> ### Core fantasy
> Gravity is terrain. Every mass bends a wireframe grid into a well (repulsors
> and antimatter bulge it into hills, black holes tear it into funnels), and
> the ship's height on that surface *is* its potential energy. The player
> drags back from the ship and releases, golf style; the farther the pull the
> faster the launch and the more fuel it burns. A live prediction line shows
> exactly where the shot goes. Fewer launches earn more stars.
>
> ### Physics core (`src/physics.js`)
> Pure, dependency-free, shared verbatim between the browser game and the
> Node solver — this sharing is the point, so the offline verifier and the
> game can never disagree.
> - Softened inverse-square gravity, `G = 1`, softening `eps = radius * 0.5`.
> - Semi-implicit Euler at a fixed `STEP = 1/120`.
> - Terrain height = scaled gravitational potential, clamped.
> - Ship radius `0.6`; launch fuel cost is quadratic in speed, capped by
>   `LAUNCH_FUEL_MAX = 2.2` and by the level's engine power.
> - Bodies may orbit: `orbit: {parent, cx, cz, radius, omega, phase}`,
>   resolved by `bodiesAt(level, t)`. Parent index must precede the child.
> - Launch pads and target stations may be anchored to a body:
>   `anchor: {body, dx, dz}`. Anchored spots ride that body, so **where you
>   launch from and where you must arrive both depend on when you launch**.
> - `predict()` returns the full trajectory plus an outcome of
>   `goal | waypoint | crash | hazard | oob | fly`.
>
> ### Levels
> 50 levels in 5 themed sets of 10, rising in difficulty: Earthrise, Inner
> System, Outer Planets, Asteroid Belt, New Star Systems. Later sets add
> moons, comets, patrol and derelict ships, asteroid walls, cargo hauls
> (pick up → drop off), space-station waypoints, black holes and antimatter
> stars. Sol levels carry the real planetary inventory inward of their theme.
>
> **Levels must be generated, never hand-written.** Write a deterministic,
> seeded generator that samples themed layouts and keeps a candidate only if
> a brute-force solver confirms **every leg** is winnable inside that set's
> difficulty band. Design rules the generator must enforce:
> - *No straight shots.* Measure the total heading change of every winning
>   trajectory; each set sets a rising floor for the straightest and the
>   median winning route (roughly 1.3 → 4.0 rad minimum by set, medians up to
>   5.0 — past a full loop). Score shortfalls as a penalty so the curviest
>   solvable candidate wins each slot.
> - *Blocker geometry.* The launch pad spawns on the far side of the home
>   world from the target; the goal hides behind the target body; on alien
>   systems the straight ship→goal line must cross a planet's orbit.
> - *Fuel forces adaptation.* Single-leg tanks sit just above the cheapest
>   winning launch but below what typical winning launches burn, so
>   brute-force direct shots are unaffordable. On multi-leg routes stops never
>   refuel, the fuel cell sits far off the easiest route (weighted toward
>   curvier detours), and the tank sits below the route's typical total cost.
> - *Use the whole map.* Early sets push the Sun to the far edge so the
>   Earth–Moon neighbourhood owns the open half; later sets put launch and
>   target on opposite swings of an off-center Sun.
> - *Everything moves.* Give planets and moons orbits with a per-set speed
>   ramp (~4° of sweep per flight on set 1 up to ~25° on set 4), phase-locked
>   so `t = 0` reproduces the static layout. Verify each level at its assigned
>   speed and back that level off until every leg is winnable again. A body
>   whose orbital circle would sweep an unanchored pad or station must be
>   frozen — slowing it only delays the collision, it never avoids it.
>
> ### Presentation
> - A single indexed `LineSegments` grid displaced by the potential; colour
>   ramps with depth (cyan → violet). Redraw the deformation only once bodies
>   have shifted a fraction of a grid cell, so a dense grid survives motion.
> - Procedural canvas textures, no image assets. Real solar-system bodies get
>   recipes that make them recognizable (Earth's oceans, continents, clouds
>   and caps; Jupiter's belts and Great Red Spot; Saturn's rings; Io's
>   sulfur; Europa's cracked ice). Alien worlds stay procedural.
> - Orbit paths drawn as dotted beads draped over the terrain so they dip
>   through each well they cross.
> - A light column stands on whatever the player must reach **next** — cargo
>   pickup, station, or final goal.
> - Each leg opens with the camera zoomed as close to the ship as possible
>   while keeping the target on screen (solve for it; don't guess from
>   distance). The camera follows the ship in flight.
> - **Time freezes while the player aims**, so the prediction line is exactly
>   the flight they get. Cosmetic animation runs on a separate clock.
>
> ### Controls and aim precision
> Drag to aim on mouse and touch. Because gravity is chaotic, tiny launch
> differences matter, so:
> - Smooth touch input and roll back to the aim ~80 ms before the finger
>   lifted — lift-off jitter must not yank a dialed-in shot.
> - Ramp the aim gain continuously with pointer speed: 1:1 at flick speed,
>   easing down to ~1/12 at a crawl, so slow movement fine-tunes. Fast moves
>   re-converge the handle onto the finger so offset never accumulates.
> - Because the handle is then no longer the launch vector, show the truth: a
>   compass rose around the ship plus a live heading and power readout.
> - Mid-flight thrust on WASD/arrows, limited by fuel. Pinch/scroll zoom,
>   two-finger pan. Suppress native pinch zoom; the game owns the gesture.
>
> ### Quality gates (make these CI checks, and keep them passing)
> 1. `node tools/solve.js --fast` — brute-forces launch angle, power and
>    release time through the real physics for every leg of all 50 levels and
>    exits nonzero if any is unwinnable.
> 2. A headless layout test asserting no HUD element renders outside the
>    viewport at phone, tablet and desktop sizes.
> 3. A headless smoke run: load, press Play, drag-launch — zero console or
>    page errors. Expose a small `window.GL` hook (`load`, `launch`,
>    `status`) so playthroughs can be scripted.
>
> Generation is slow, so make the generator shardable: each level slot's
> search must be independent and deterministic in `(set, slot)`, with heavy
> slots splittable into attempt-shards whose merge provably reproduces the
> serial pick. Fan those shards across CI runners.
>
> ### Ship it
> Static hosting (GitHub Pages) from the default branch. Installable PWA
> named exactly "Gravity Loop" with an offline cache. Serve locally from the
> repo root — a server rooted anywhere else 404s the ES modules.

---

## How this project was actually built

Every feature here was specified in conversation, implemented by an AI agent,
and gated on the checks above. Practices worth copying:

- **Mockup-first for anything visible.** Options are rendered from a real
  working copy via headless Chromium and chosen by a human before
  implementation — not described in prose and guessed at.
- **Verify, don't assert.** Difficulty, winnability and orbit speeds are all
  established by running the real solver, never by reasoning about them. Most
  of the hard bugs in this project's history were caught this way.
- **Determinism as a contract.** Seeded generation plus provably equivalent
  shard merging means a level set can be regenerated identically on 50
  machines, which is what makes CI-scale search practical.
- **Provenance.** AI-assisted commits carry `Co-Authored-By` trailers, and
  the agent conventions live in a versioned `AGENTS.md`.
