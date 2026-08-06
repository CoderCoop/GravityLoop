// GravityLoop — release notes shown in-game ("What's new").
//
// Newest first. Versions are semantic (https://semver.org): MAJOR.MINOR.PATCH.
//   MAJOR — the game changes in a way that invalidates what a player knew:
//           reworked controls, a rebuilt campaign, physics they must relearn.
//   MINOR — new capability or content that leaves existing skills intact.
//   PATCH — fixes and polish; nothing new to learn.
// Bump the top entry whenever something player-visible ships; the menu badges
// the button until the player has read that version, and VERSION is derived
// from this entry, so this is the only place a version lives.
// tools/changelog-check.mjs enforces the bump and the format in CI.
export const CHANGELOG = [
  {
    v: '2.0.0',
    date: '2026-08-05',
    title: 'A campaign of fifty different problems',
    notes: [
      'All 50 levels are rebuilt. Every one of your old routes is gone — the geometry is new, so this is a fresh campaign rather than a patch.',
      'Levels no longer solve alike. Each one is built to demand a particular shape of flight: a long sustained arc, a hard slingshot past something heavy, an S-curve that bends one way then back, most of a loop around a world, or a cruise that keeps meeting new terrain. Neighbouring levels never ask for the same one.',
      'You can no longer skip a level by flying wide around the outside of the system. Every winning route now has to work the terrain, not just the least interesting one.',
      'Nothing overlaps any more. Moons no longer sit inside their planet, docking rings no longer hide inside a gas giant, and stations no longer drift through worlds as they orbit — checked across each level’s full orbital period rather than a snapshot.',
      'Worlds move on 47 of the 50 levels, and docking targets are back to half size on every one.',
    ],
  },
  {
    v: '1.11.1',
    date: '2026-08-05',
    title: 'Easier to find, nicer to share',
    notes: [
      'The title screen is part of the page itself now, so it appears the moment the page opens instead of waiting for the game to load.',
      'Sharing a link to Gravity Loop shows a picture of the game and a real description rather than a bare URL.',
    ],
  },
  {
    v: '1.11.0',
    date: '2026-08-05',
    title: 'Install it from the title screen',
    notes: [
      'The title screen now offers to install Gravity Loop as an app — one tap for a full-screen icon on your home screen that works offline. On iPhone it tells you where Safari hides the button.',
      'Dismiss it and it stays dismissed; it never appears once the game is installed.',
      'Menus that are taller than a small phone screen now scroll instead of running off the top.',
    ],
  },
  {
    v: '1.10.3',
    date: '2026-08-05',
    title: 'Careful aim still reaches full power',
    notes: [
      'A slow, deliberate drag now builds power as you would expect. Precision aiming let the handle fall further and further behind your finger, so the most careful shots — the ones that engage the finest control — could end up too weak to launch at all, with no prediction line to show for it.',
      'Fine control is unchanged where it matters: creeping the pointer still dials the aim down to hundredths of a degree, and now holds your power steady while you do it.',
    ],
  },
  {
    v: '1.10.2',
    date: '2026-08-05',
    title: 'Your ship is where you left it',
    notes: [
      'Every leg now opens with your ship in view. On wider levels the camera would frame the pair so tightly that the ship sat off the edge of the screen entirely, and switching levels could shove the view sideways by the whole distance between the two pads.',
      'The opening view also keeps the lower quarter of the screen clear beneath your ship, so there is somewhere to pull the slingshot into instead of running out of screen mid-drag.',
    ],
  },
  {
    v: '1.10.1',
    date: '2026-07-26',
    title: 'Everything lines up with the ground',
    notes: [
      'Planets rest on the gravity surface instead of being half sunk into it, so the grid no longer appears to slice through them.',
      'The beacon column now stands on its target instead of stopping short above it, so the next place you are heading is easy to pick out.',
    ],
  },
  {
    v: '1.10.0',
    date: '2026-07-26',
    title: 'Finding your way around',
    notes: [
      'A \u2302 button in the HUD returns you to the title screen at any time, and Esc does the same.',
      'The title screen links out to the project site, so the code and the spec behind the game are one click away.',
    ],
  },
  {
    v: '1.9.0',
    date: '2026-07-26',
    title: 'Reading the field',
    notes: [
      'Gravity wells are shaped to read properly: rounded centres instead of needles, so a world sits in a visible bowl rather than disappearing down a spike, and a sun now shows its pull as a wide basin the planets orbit inside.',
      'Moving targets show their lead — a ghost ring marks where the station will be when your shot arrives, with beads tracing the path it travels while you fly.',
      'Asteroid fields are drifting dust rather than moon-sized boulders.',
      'Worlds dropped their direction arrows; the orbit paths already say where everything is going.',
      'The view now travels with your ship while it waits on a moving launch pad.',
    ],
  },
  {
    v: '1.8.0',
    date: '2026-07-26',
    title: 'Tighter targets, truer collisions',
    notes: [
      'Docking targets are half the size — about a moon\u2019s width, smaller than any planet — and every level was re-checked to confirm it is still winnable.',
      'Crashes now register when you actually touch a planet, not while you are still visibly clear of it, and flying through a docking ring scores as it looks like it should.',
      'The flight preview stays readable on shots that curve straight back into a nearby world.',
      'Stations and launch pads are structures again rather than landmarks larger than the moons beside them.',
      'The terrain glides as worlds move instead of stepping, and the camera breathes to keep your ship and its target both in frame.',
    ],
  },
  {
    v: '1.7.0',
    date: '2026-07-25',
    title: 'Living solar systems',
    notes: [
      'Planets and moons now orbit on every level — a slow drift in the early sets, real launch-window timing by the outer ones.',
      'Launch pads and target stations ride their world instead of hanging in space, so where you leave from and where you must arrive both depend on when you launch.',
      'Dotted orbit rings drape over the terrain, dipping through every gravity well they cross.',
      'The real worlds look like themselves: Earth’s oceans and clouds, Jupiter’s belts and Great Red Spot, Saturn’s rings, Io’s sulfur, Europa’s cracked ice.',
      'A compass rose and live heading/power readout show the true launch vector while you aim.',
    ],
  },
  {
    v: '1.6.0',
    date: '2026-07-25',
    title: 'Precision aiming',
    notes: [
      'Slow down mid-drag and the aim fine-tunes with you — smoothly down to 1/12 speed, so tenths of a degree are dialable. Flick fast and it snaps back to 1:1.',
      'Each leg now opens zoomed as close to your ship as it can while keeping the target on screen.',
    ],
  },
  {
    v: '1.5.0',
    date: '2026-07-25',
    title: 'Loops and curves',
    notes: [
      'Levels are built so no route is a straight shot: the pad hides behind your home world, the goal behind the target, and every winning path has to bend around something.',
      'Fuel forces the issue — tanks are priced below the brute-force direct line, so only the gravity-efficient curve fits the budget.',
      'The light column marks whatever you must reach next, and the camera follows your ship in flight.',
    ],
  },
  {
    v: '1.4.0',
    date: '2026-07-23',
    title: 'Reading the shot',
    notes: [
      'Chunky dotted prediction line that stays legible against the grid.',
      'Touch aiming is smoothed and ignores the jitter of your finger lifting off.',
      'Smaller goal rings, a smaller ship against big worlds, and a denser, smoother gravity grid.',
    ],
  },
  {
    v: '1.3.0',
    date: '2026-07-21',
    title: 'Routes worth flying',
    notes: [
      'Levels use the whole map: the Sun sits at the far edge so the flying happens across open space.',
      'Fuel cells sit off the easy route, and reaching them is a genuine detour.',
      'Every level is generated and machine-verified winnable before it ships.',
    ],
  },
  {
    v: '1.2.0',
    date: '2026-07-20',
    title: 'The Sol campaign',
    notes: [
      '50 levels across five themed sets, from the Earth–Moon hop out to alien suns and black holes.',
      'Space-station targets, cargo hauls, comets, asteroid belt walls and patrol ships.',
      'Installable as an app, and playable offline.',
    ],
  },
  {
    v: '1.1.0',
    date: '2026-07-19',
    title: 'Fuel, engines, timing',
    notes: [
      'Launches burn fuel, stops never refuel, and engine power caps how hard you can throw.',
      'Antimatter stars push instead of pull.',
      'Streamlined HUD that fits on a phone.',
    ],
  },
  {
    v: '1.0.0',
    date: '2026-07-18',
    title: 'Liftoff',
    notes: [
      'Spaceship golf across gravity rendered as 3D terrain — drag back, release, and let the wells bend your flight.',
    ],
  },
];

export const VERSION = CHANGELOG[0].v;
