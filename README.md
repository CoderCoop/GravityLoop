# 🌌 GravityLoop

**Spaceship golf across the curves of spacetime.**

Gravity is rendered as 3D terrain: every planet bends the neon grid into a
well, repulsors bulge it into hills, and black holes tear it into bottomless
funnels. Your ship's height on the terrain *is* its potential energy — dive
into a well and you speed up, climb out and you slow down.

Slingshot-launch your ship (drag back and release, golf style — the farther
you pull, the faster you fly and the more fuel the launch burns, up to your
engine's power limit ⚙), watch the live trajectory prediction bend through
the gravity field, and reach the golden ring. Grab fuel cells placed along
the good routes, dodge derelict and patrol ships, dock at stations to refuel
mid-route, and haul heavy cargo that saps your thrusters. On advanced levels
the engine alone won't get you there — launch when a moving planet can sling
you forward (a real gravity assist steals the body's orbital momentum).
Fewer launches = more stars.

Tap the level name (top left) to open the level select.

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

The campaign starts at home and works outward. Bodies use realistic size
tiers (suns dwarf gas giants, which dwarf rocky planets and moons), and
every moving object shows an arrow with its current direction of travel:

Every target is a space station, and every Sol level carries the complete
planetary inventory inward of its theme (Earth always brings its Moon and
the inner planets; Jupiter levels include everything from Mercury out).
Comets cross many levels on slow elliptical orbits — massless, lethal,
tail streaming away from the Sun:

1. **Earthrise** ★ — launch from Earth to the lunar station, then Venus, Mars
2. **Inner System** ★★ — the full inner system around a heavy Sun; wrecks,
   patrols and a first comet
3. **Outer Planets** ★★★ — to Jupiter and Saturn (moons included, plus the
   whole inner system behind you); station routes
4. **Asteroid Belt** ★★★★ — a WALL of rock rings the Sun between Mars and
   Jupiter with narrow passages; cargo hauls (📦 → 📥) thread it
5. **New Star Systems** ★★★★★ — alien suns with moving orbits, antimatter
   stars, black holes, weak engines and launch windows

Each leg starts with the camera over your ship, rotated so the target
station sits up-screen.

Sets 1–4 are static snapshots of their systems; set 5's systems move — and
while you aim, time freezes, so the prediction line is exactly the flight
you get.

Stops never refuel. On multi-leg routes the tank is deliberately smaller
than the route costs at typical launch power — and fuel cells sit at the
apex of the CURVIEST winning routes, so you must deliberately fly the
detour to refuel. Docking too dry triggers a warning; R restarts.

The game is an installable PWA ("Gravity Loop" on your home screen) with
an offline cache.

Most levels are produced by a seeded generator that samples themed layouts
and only keeps candidates whose **every leg** the brute-force solver confirms
is winnable inside the set's difficulty band (the 8 original handcrafted
levels are folded into their matching sets):

```bash
node tools/generate.js       # regenerate src/levels.js (deterministic)
node tools/solve.js --fast   # verify all 50 levels are winnable (CI grid)
node tools/solve.js 14       # fine-grid stats for a single level (0-indexed)
npm run test:ui              # HUD-overflow layout test at phone/tablet/desktop
                             # sizes (needs npm install + a Chromium binary,
                             # see CHROMIUM_PATH in tools/ui-test.mjs)
```

Both checks run in CI on every pull request.

## Tech

- [Three.js](https://threejs.org) (vendored in `vendor/`) for rendering — a
  single indexed `LineSegments` grid displaced by the gravitational potential.
- `src/physics.js` — pure, dependency-free physics core (softened
  inverse-square gravity, semi-implicit Euler, trajectory prediction), shared
  between the browser game and the Node solver.
- `src/levels.js` — level data.
- `src/audio.js` — tiny WebAudio synth, no sound assets.
- No build step.
