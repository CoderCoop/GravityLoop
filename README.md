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

Levels use all the space they have: on the early sets the Sun sits at the
far edge of the map so the Earth–Moon neighborhood — where the flying
happens — owns the open half (the Earth→Moon hop alone spans ~19 units);
on the later sets launch and target swing to opposite sides of an
off-center Sun so routes arc across the whole system.

**No straight shots.** The generator measures how much every brute-force
winning trajectory bends (total heading change along the flight) and each
set sets a rising **turning target** for the straightest and the median
winning route (~1.3 rad min on set 1 up to ~4.0 rad on set 5, medians to
~5.0 rad — past a full loop around a planet); any shortfall is penalized
in the search, so the curviest solvable candidates win each slot.
Geometry backs this up: the launch pad spawns on the far side of your
home planet from the target, the goal hides behind the target body away
from you, and on alien systems the straight ship→goal line must pass
through a planet's orbit. Getting anywhere means slinging around
something.

Fuel forces the issue everywhere. Single-leg levels get a tank sized just
above the *cheapest* winning launch but below what most winning launches
burn — the brute-force direct shots are unaffordable and only the
gravity-efficient curves fit the budget. On multi-leg routes, stops never
refuel: the fuel cell sits far OFF the easiest winning route — weighted
toward the *curviest* detours — and the tank covers the detour launch but
sits below the route's typical total cost: fly the cheap line and you run
dry. Docking too dry triggers a warning; R restarts.

The game is an installable PWA ("Gravity Loop" on your home screen) with
an offline cache.

Most levels are produced by a seeded generator that samples themed layouts
and only keeps candidates whose **every leg** the brute-force solver confirms
is winnable inside the set's difficulty band (the 8 original handcrafted
levels are folded into their matching sets):

```bash
node tools/generate.js       # regenerate src/levels.js (deterministic, hours)
tools/genpar.sh              # same result across all CPU cores, resumable
node tools/solve.js --fast   # verify all 50 levels are winnable (CI grid)
node tools/solve.js 14       # fine-grid stats for a single level (0-indexed)
npm run test:ui              # HUD-overflow layout test at phone/tablet/desktop
                             # sizes (needs npm install + a Chromium binary,
                             # see CHROMIUM_PATH in tools/ui-test.mjs)
```

The slot searches are independent and deterministic, so they parallelize:
`tools/genpar.sh` fans them across local cores, and the **"Generate
levels"** workflow (Actions → run on a branch) fans ~90 slot/shard jobs
across GitHub runners — full regeneration in tens of minutes — then
commits the assembled `src/levels.js` back to the branch. Heavy slots
split their attempt search into shards whose merge provably reproduces
the serial pick.

Both verification checks run in CI on every pull request.

## Built by AI — and reproducible

Every feature in this game was specified in conversation and implemented by
an AI coding agent. Rather than leave that as a footnote, the artifacts that
make it reproducible ship with the code:

| File | What it is |
| --- | --- |
| [`PROMPT.md`](PROMPT.md) | **Reconstitution entry point.** The kickoff prompt, plus a map of the spec. Copyable in-game under *Built by AI · rebuild it yourself* — the button hands you the prompt and all three spec documents in one block. |
| [`spec/requirements.md`](spec/requirements.md) | **What to build.** Normative requirements in [EARS](https://alistairmavin.com/ears/) notation (Mavin et al., IEEE RE 2009) with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords and stable IDs. |
| [`spec/design.md`](spec/design.md) | **How it hangs together.** Module boundaries, data model, and rationale for the decisions that were reached the hard way. |
| [`spec/tasks.md`](spec/tasks.md) | **What order to build it in.** Phased tasks, each naming the requirements it satisfies and the check that proves it. |
| [`AGENTS.md`](AGENTS.md) | Standing conventions for agents working on this repo, in the cross-tool [AGENTS.md](https://agents.md) format. `CLAUDE.md` is a symlink to it. |
| [`src/changelog.js`](src/changelog.js) | Player-facing release notes, shown in-game under *What's new*. |

The spec follows the requirements → design → tasks triad that
[GitHub Spec Kit](https://github.com/github/spec-kit) and Amazon Kiro both
generate, so an agent that knows either already knows this layout.

The working practices these encode are the load-bearing part:

- **Mockup-first for anything visible.** Options get rendered from a real
  working copy with headless Chromium and chosen by a human *before*
  implementation, instead of being described in prose and guessed at.
- **Verify, don't assert.** Difficulty, winnability and orbit speeds are
  established by running the real solver over the real physics — never by
  reasoning about them. Most of this project's hard bugs were caught that way
  (a body whose orbit would sweep a station, for instance, cannot be fixed by
  slowing it down; the check has to prove it, not assume it).
- **Determinism as a contract.** Seeded generation plus provably equivalent
  shard merging is what lets a 50-level campaign be searched across a CI
  matrix and reassembled byte-identically.
- **Provenance.** AI-assisted commits carry `Co-Authored-By` trailers.

## Tech

- [Three.js](https://threejs.org) (vendored in `vendor/`) for rendering — a
  single indexed `LineSegments` grid displaced by the gravitational potential.
- `src/physics.js` — pure, dependency-free physics core (softened
  inverse-square gravity, semi-implicit Euler, trajectory prediction), shared
  between the browser game and the Node solver.
- `src/levels.js` — level data.
- `src/audio.js` — tiny WebAudio synth, no sound assets.
- No build step.
