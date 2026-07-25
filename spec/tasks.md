# GravityLoop — Implementation plan

Build order for reconstituting the game from an empty directory. Each task
names the requirements it satisfies and the check that proves it. Work the
phases in order: every phase after the first depends on the verification of
the one before it.

Legend: `[ ]` not started · `[x]` done in this repo.

## Phase 1 — Physics core

- [x] **T1.1** Implement gravity, integration and terrain height.
      *(REQ-PHY-2, REQ-PHY-3, REQ-PHY-4)*
      **Check:** a body dropped from rest accelerates toward the mass; energy
      stays bounded over 10 000 steps.
- [x] **T1.2** Implement `bodiesAt(level, t)` with parent-relative orbits.
      *(REQ-PHY-5)* **Check:** a moon's distance from its planet is constant.
- [x] **T1.3** Implement anchored pads and stations, and make `activeTarget`
      and `legStart` time-dependent. *(REQ-PHY-6, REQ-PHY-7)*
      **Check:** an anchored goal's position at `t` equals its host's position
      plus the offset.
- [x] **T1.4** Implement `predict()` with the six outcomes and collision
      against bodies, hazards and bounds. *(REQ-PHY-8, REQ-PHY-9)*
- [x] **T1.5** Implement fuel cost and engine cap. *(REQ-PHY-10)*

> Do not proceed until the core is importable from Node with no DOM.
> Everything downstream — solver, generator, game — depends on it.

## Phase 2 — Playable single level

- [x] **T2.1** Render the displaced grid with depth colouring. *(REQ-VIS-1)*
- [x] **T2.2** Drag-to-launch with a live prediction line, and freeze the
      clock while aiming. *(REQ-CTL-1, REQ-PHY-11)*
- [x] **T2.3** Mid-flight thrust, fuel accounting, crash and win states.
      *(REQ-CTL-6)*
- [x] **T2.4** HUD: level, difficulty, engine, attempts, fuel, power.
- [x] **T2.5** Expose the scripting hook. *(REQ-VER-3)*
- [x] **T2.6** Write the smoke test and the HUD-overflow test; wire both into
      CI. *(REQ-VER-2, REQ-VER-3)*

## Phase 3 — Solver

- [x] **T3.1** Brute-force launch angle × power × release time per leg,
      importing the physics core unchanged. *(REQ-PHY-1, REQ-VER-1)*
- [x] **T3.2** Report per-leg win counts and difficulty; exit nonzero on any
      unwinnable leg. Wire into CI.

## Phase 4 — Level generation

- [x] **T4.1** Seeded samplers per theme, emitting whole systems.
      *(REQ-LVL-8, REQ-SCOPE-4)*
- [x] **T4.2** Accept candidates only inside the set's solver-verified
      difficulty band. *(REQ-LVL-2)*
- [x] **T4.3** Add turning measurement and per-set floors as scoring
      penalties. *(REQ-LVL-3)*
- [x] **T4.4** Add blocker geometry for pad, goal and alien sight-lines.
      *(REQ-LVL-4)*
- [x] **T4.5** Add fuel economy: single-leg tank pricing and off-route
      pickups gated below route cost. *(REQ-LVL-5, REQ-LVL-6)*
- [x] **T4.6** Add map-usage rules for sun placement. *(REQ-LVL-7)*
- [x] **T4.7** Make slot searches shardable with a provably equivalent merge,
      and fan them across a CI matrix. *(REQ-VER-4)*

## Phase 5 — Motion

- [x] **T5.1** Assign phase-locked orbits with the per-set speed ramp.
      *(REQ-MOT-1, REQ-MOT-2, REQ-MOT-3)*
- [x] **T5.2** Anchor pads and stations within 12 units of a body.
      *(REQ-MOT-6)*
- [x] **T5.3** Freeze bodies whose ring would sweep a pad or station they do
      not carry, in world space and in parent-relative space. *(REQ-MOT-5)*
      **Check:** no level loses all motion because of a single conflict.
- [x] **T5.4** Re-verify each level with the solver and back its speed off
      until every leg passes. *(REQ-MOT-4)*
- [x] **T5.5** Gate terrain re-deformation on body displacement so grid
      density survives universal motion. *(REQ-VIS-2)*

## Phase 6 — Presentation

- [x] **T6.1** Procedural textures, including recognizable named worlds.
      *(REQ-VIS-3, REQ-VIS-4)*
- [x] **T6.2** Draw orbit paths draped over the terrain. *(REQ-VIS-5)*
- [x] **T6.3** Beacon on the next target. *(REQ-VIS-6)*
- [x] **T6.4** Solve start-camera framing; follow the ship in flight.
      *(REQ-VIS-7, REQ-VIS-8)*

## Phase 7 — Precision aiming

- [x] **T7.1** Smooth touch input and roll back to the pre-release aim.
      *(REQ-CTL-5)*
- [x] **T7.2** Continuous aim-gain ramp with fast-move re-convergence.
      *(REQ-CTL-2, REQ-CTL-3)*
- [x] **T7.3** Launch telemetry: compass rose plus heading/power readout.
      *(REQ-CTL-4)*

## Phase 8 — Ship it

- [x] **T8.1** Stars, level select and persisted progress. *(REQ-PRG-1,
      REQ-PRG-2)*
- [x] **T8.2** PWA manifest, icons and offline cache. *(REQ-SCOPE-3)*
- [x] **T8.3** In-game changelog with an unread indicator. *(REQ-PRG-3)*
- [x] **T8.4** Publish from the default branch to static hosting.

## Standing constraints

These apply to every task, not just one phase:

1. Anything the player sees is mocked up as a real render and chosen by a
   human before it is implemented.
2. No claim about difficulty, winnability or speed is accepted without the
   solver having produced it.
3. All three verification gates stay green; a red gate is fixed before new
   work starts.
4. Serve locally from the repository root — a server rooted elsewhere returns
   404 for the ES modules and the menu never appears.
