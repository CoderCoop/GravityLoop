# GravityLoop — Requirements

Normative specification for rebuilding GravityLoop from nothing.

**Notation.** Requirements use [EARS](https://alistairmavin.com/ears/) (Easy
Approach to Requirements Syntax, Mavin et al., IEEE RE 2009):

> *While* `<precondition>`, *when* `<trigger>`, the `<system>` **shall**
> `<response>`.

Ubiquitous requirements state a always-true property and take no keyword.
The key words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
Every requirement has a stable ID; design decisions that satisfy them live in
[`design.md`](design.md) and the build order in [`tasks.md`](tasks.md).

Values given as numbers are load-bearing: they are the result of tuning
against the solver, and a fresh derivation will not reproduce the same feel.

---

## 1. Product scope

**REQ-SCOPE-1** The game shall be a single-player browser game in which the
player launches a spaceship across gravity fields rendered as 3D terrain.

**REQ-SCOPE-2** The game MUST run as a static page of ES modules with no
build step, no framework and no binary assets, using a vendored copy of
Three.js.

**REQ-SCOPE-3** The game MUST be installable as a PWA named exactly
`Gravity Loop` and MUST remain playable offline once cached.

**REQ-SCOPE-4** The game shall ship 50 levels in 5 themed sets of 10, of
non-decreasing difficulty: Earthrise, Inner System, Outer Planets, Asteroid
Belt, New Star Systems.

## 2. Physics core

**REQ-PHY-1** The physics core MUST be a pure, dependency-free module shared
verbatim by the browser game and the offline solver, so that the two can
never disagree about the outcome of a launch.

**REQ-PHY-2** The simulation shall model gravity as softened inverse-square
attraction with `G = 1` and softening `eps = body.radius * 0.5`.

**REQ-PHY-3** The simulation shall integrate with semi-implicit Euler at a
fixed step of `1/120` s.

**REQ-PHY-4** Terrain height shall equal the scaled gravitational potential,
clamped to a maximum depth, so that wells dip and antimatter masses bulge.

**REQ-PHY-5** When a body declares an orbit `{parent, cx, cz, radius, omega,
phase}`, the system shall evaluate its position at simulation time `t`; a
parent's index MUST precede its child's.

**REQ-PHY-6** When a launch pad, waypoint or goal declares an anchor
`{body, dx, dz}`, the system shall place it at that offset from the anchor
body's position at time `t`.

**REQ-PHY-7** Because of REQ-PHY-6, where the ship launches from and where it
must arrive shall both depend on the launch time.

**REQ-PHY-8** The trajectory predictor shall return the sampled path and
exactly one outcome from `goal`, `waypoint`, `crash`, `hazard`, `oob`, `fly`.

**REQ-PHY-9** The ship shall have collision radius `0.6`.

**REQ-PHY-10** Launch fuel cost shall rise quadratically with launch speed,
bounded by `LAUNCH_FUEL_MAX = 2.2` and by the level's engine power.

**REQ-PHY-11** While the player is aiming, the simulation clock shall be
frozen, so that the predicted trajectory is exactly the flight the player
receives. Cosmetic animation shall use a separate clock.

## 3. Controls and aim precision

**REQ-CTL-1** When the player drags from the ship and releases, the system
shall launch the ship away from the drag, with speed proportional to drag
distance and capped by engine power and remaining fuel.

**REQ-CTL-2** While the pointer is moving slowly, the system shall scale aim
response down continuously, reaching approximately `1/12` at a near-still
crawl, so that small movements make fine adjustments.

**REQ-CTL-3** While the pointer is moving at flick speed (≥ ~320 px/s), the
system shall track it 1:1 and shall re-converge the aim handle onto the
pointer, so that damping never accumulates a visible offset.

**REQ-CTL-4** Because REQ-CTL-2 decouples the handle from the launch vector,
the system MUST display the actual launch heading and power while aiming.

**REQ-CTL-5** When the input is touch, the system shall smooth pointer noise
and shall launch using the aim as it was ~80 ms before release, so that
lift-off jitter cannot spoil an aimed shot.

**REQ-CTL-6** While the ship is in flight, when the player presses WASD or an
arrow key, the system shall apply a small thrust, consuming fuel.

**REQ-CTL-7** The system shall support pinch and scroll zoom and two-finger
pan, and MUST suppress native browser pinch zoom.

## 4. Level design

**REQ-LVL-1** Levels MUST be produced by a deterministic seeded generator.
Level data MUST NOT be hand-edited.

**REQ-LVL-2** The generator shall keep a candidate level only when a
brute-force solver confirms every leg is winnable within that set's
difficulty band.

**REQ-LVL-3** *(No straight shots.)* The generator shall measure the total
heading change of each winning trajectory and shall enforce a per-set floor
on both the straightest and the median winning route, rising from ~1.3 rad on
set 1 to ~4.0 rad on set 5, with median targets up to ~5.0 rad.

**REQ-LVL-4** *(Blocker geometry.)* The generator shall place the launch pad
on the far side of the home world from the target, and the goal behind the
target body away from the ship; on alien systems the straight ship-to-goal
line shall cross a planet's orbit.

**REQ-LVL-5** *(Fuel forces adaptation.)* On single-leg levels the fuel tank
shall exceed the cheapest winning launch but fall below what typical winning
launches burn, so that brute-force direct shots are unaffordable.

**REQ-LVL-6** On multi-leg routes, docking shall NOT refuel; the fuel cell
shall sit far off the easiest winning route, biased toward curvier detours;
and the tank shall fall below the route's typical total cost.

**REQ-LVL-7** *(Use the whole map.)* Early sets shall place the sun at the far
edge so the home neighbourhood owns the open half of the map; later sets shall
place launch and target on opposite swings of an off-center sun.

**REQ-LVL-8** Later sets shall introduce, cumulatively: moons, comets, patrol
and derelict ships, asteroid walls, cargo hauls, station waypoints, black
holes and antimatter stars. Sol levels shall carry the real planetary
inventory inward of their theme.

## 5. Motion

**REQ-MOT-1** Planets and moons shall orbit on every level.

**REQ-MOT-2** Orbit speed shall follow a per-set ramp of roughly 4° of sweep
per flight on set 1 up to 25° on set 4, scaled so that inner orbits and moons
sweep faster.

**REQ-MOT-3** Each body's orbital phase MUST be chosen so that at `t = 0` it
occupies its generated static position, preserving every level layout.

**REQ-MOT-4** When orbits are assigned, the system shall re-verify the level
with the solver and shall reduce that level's orbit speed until every leg is
winnable again.

**REQ-MOT-5** When a body's orbital circle would sweep a launch pad or station
it does not carry, that body MUST be held static, because reducing its speed
delays such a collision without preventing it.

**REQ-MOT-6** A pad or station within 12 units of a body's surface shall be
anchored to that body and shall ride it; one belonging to no body shall stay
fixed.

## 6. Presentation

**REQ-VIS-1** The gravity field shall be drawn as a single indexed line-segment
grid displaced by the potential, coloured by depth.

**REQ-VIS-2** While bodies are in motion, the system shall re-deform the
terrain only once a body has moved a fraction of a grid cell, so that grid
density need not be sacrificed for motion.

**REQ-VIS-3** All textures MUST be generated procedurally at runtime; the game
MUST NOT ship image assets.

**REQ-VIS-4** Real solar-system bodies shall be recognizable — Earth's oceans,
continents, clouds and ice caps; Jupiter's belts and Great Red Spot; Saturn's
rings; Io's sulfur; Europa's cracked ice. Fictional worlds shall remain
procedurally varied.

**REQ-VIS-5** Each orbit shall be drawn as a dotted path draped over the
terrain, so that it visibly dips through the wells it crosses.

**REQ-VIS-6** A vertical light column shall stand on the target the player must
reach next, whether that is a cargo pickup, a station or the final goal.

**REQ-VIS-7** When a leg begins, the camera shall be placed as close to the
ship as possible while keeping the active target within the viewport; this
MUST be solved for, not estimated from distance.

**REQ-VIS-8** While the ship is in flight, the camera shall follow it, except
while the player is performing a camera gesture.

**REQ-VIS-9** No HUD element shall render outside the viewport at phone,
tablet or desktop sizes.

## 7. Scoring and progression

**REQ-PRG-1** The system shall award up to three stars per level, awarding
more stars for fewer launches.

**REQ-PRG-2** The system shall let the player select any unlocked level, and
shall persist progress locally.

**REQ-PRG-3** The system shall present release notes in-game and shall
indicate when notes are newer than those the player has seen.

**REQ-PRG-4** When a change alters anything the player can see, it MUST add a
release-notes entry with a new version. The version MUST be derived from the
notes so there is exactly one place to update, and this MUST be enforced
automatically rather than left to habit.

**REQ-PRG-5** Versions MUST be semantic (`MAJOR.MINOR.PATCH`), classified from
the player's perspective: MAJOR when prior knowledge stops holding, MINOR for
new capability or content, PATCH for fixes and polish. The format and a
strictly increasing value MUST both be checked automatically.

## 8. Verification

These are the acceptance gates. All three MUST pass in CI on every pull
request.

**REQ-VER-1** When the solver is run over all 50 levels, it shall confirm
every leg of every level is winnable, and shall exit nonzero otherwise.

**REQ-VER-2** When the layout test is run at phone, tablet and desktop
viewport sizes, it shall confirm REQ-VIS-9 and shall exit nonzero otherwise.

**REQ-VER-3** When the smoke test loads the game, starts a level and launches,
it shall complete with zero console or page errors. The game shall expose a
scripting hook exposing at least level load, launch and status.

**REQ-VER-4** Because full generation is expensive, each level slot's search
MUST be independent and deterministic in `(set, slot)`, and heavy slots MUST
be splittable into attempt shards whose merged result provably equals the
serial result.

**REQ-VER-5** *(Drawn scene matches the simulation.)* Because the solver never
renders and the layout test only measures HUD boxes, the gap between them MUST
be checked directly. A body's drawn silhouette shall match the radius the ship
collides with; a docking ring's drawn centreline shall equal the radius that
scores, and its visible thickness shall stay within 20% of that radius; every
object resting on the terrain shall be placed at the *drawn* surface height,
not the raw potential; and the flight preview shall stay legible even when a
shot crashes within a fraction of a second.

**REQ-VER-6** *(Outcomes are supported by the geometry.)* When the simulation
reports an outcome, the ship's position at that instant shall satisfy the
outcome's geometric condition, within one physics step of travel. Prediction
shall be deterministic, and shrinking a target shall never raise a level's
win count while growing one shall never lower it.
