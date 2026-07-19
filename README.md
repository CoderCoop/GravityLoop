# 🌌 GravityLoop

**Spaceship golf across the curves of spacetime.**

Gravity is rendered as 3D terrain: every planet bends the neon grid into a
well, repulsors bulge it into hills, and black holes tear it into bottomless
funnels. Your ship's height on the terrain *is* its potential energy — dive
into a well and you speed up, climb out and you slow down.

Slingshot-launch your ship (drag back and release, golf style — the farther
you pull, the faster you fly and the more fuel the launch burns), watch the
live trajectory prediction bend through the gravity field, and reach the
golden ring. Grab fuel cells, dodge derelict and patrol ships, dock at
stations to refuel mid-route, and haul heavy cargo that saps your thrusters.
Fewer launches = more stars.

## Play

**Online:** once this repo's Pages deployment is live, play at
<https://codercoop.github.io/GravityLoop/> (deployed automatically from
`main` by `.github/workflows/pages.yml`).

**Locally:** the game is a static page but uses ES modules, so it needs any
local web server:

```bash
cd GravityLoop
python3 -m http.server 8000
# or: npx serve
```

Then open <http://localhost:8000>.

## Controls

| Input | Action |
| --- | --- |
| Drag + release | Aim and launch (drag farther = more power) |
| WASD / arrow keys | Tiny mid-flight thrusts — limited fuel ⛽ |
| R | Restart level |
| N | Next level (after winning) |
| M | Mute |
| Esc | Cancel aim |

## Levels

50 levels in 5 themed sets of 10, each set harder than the last (difficulty
shown as ★–★★★★★ in the HUD), with more and more bodies in play:

Game elements are introduced set by set:

1. **Cadet Orbits** ★ — gravity wells, then fuel cell pickups
2. **Slingshot Academy** ★★ — big blockers to curve around; derelict and
   patrol ships appear in the lanes
3. **Repulsor Fields** ★★★ — anti-gravity hills; space stations turn levels
   into multi-leg routes (dock to refuel, then fly the next leg)
4. **Clockwork Moons** ★★★★ — orbiting moons and waltzing binaries; cargo
   hauls (pick up 📦, deliver 📥 — carrying cargo halves your thrusters)
5. **Deep Space** ★★★★★ — full solar systems (suns, orbiting planets, moons,
   black holes) with stations, cargo runs and patrols combined

Most levels are produced by a seeded generator that samples themed layouts
and only keeps candidates whose **every leg** the brute-force solver confirms
is winnable inside the set's difficulty band (the 8 original handcrafted
levels are folded into their matching sets):

```bash
node tools/generate.js       # regenerate src/levels.js (deterministic)
node tools/solve.js --fast   # verify all 50 levels are winnable (CI grid)
node tools/solve.js 14       # fine-grid stats for a single level (0-indexed)
```

## Tech

- [Three.js](https://threejs.org) (vendored in `vendor/`) for rendering — a
  single indexed `LineSegments` grid displaced by the gravitational potential.
- `src/physics.js` — pure, dependency-free physics core (softened
  inverse-square gravity, semi-implicit Euler, trajectory prediction), shared
  between the browser game and the Node solver.
- `src/levels.js` — level data.
- `src/audio.js` — tiny WebAudio synth, no sound assets.
- No build step.
