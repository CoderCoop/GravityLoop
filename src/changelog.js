// GravityLoop — release notes shown in-game ("What's new").
// Newest first. Bump the top entry's `v` whenever something player-visible
// ships; the menu badges the button until the player has read that version.
export const CHANGELOG = [
  {
    v: '2.0',
    date: '2026-07-26',
    title: 'Finding your way around',
    notes: [
      'A \u2302 button in the HUD returns you to the title screen at any time, and Esc does the same.',
      'The title screen links out to the project site, so the code and the spec behind the game are one click away.',
    ],
  },
  {
    v: '1.9',
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
    v: '1.8',
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
    v: '1.7',
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
    v: '1.6',
    date: '2026-07-25',
    title: 'Precision aiming',
    notes: [
      'Slow down mid-drag and the aim fine-tunes with you — smoothly down to 1/12 speed, so tenths of a degree are dialable. Flick fast and it snaps back to 1:1.',
      'Each leg now opens zoomed as close to your ship as it can while keeping the target on screen.',
    ],
  },
  {
    v: '1.5',
    date: '2026-07-25',
    title: 'Loops and curves',
    notes: [
      'Levels are built so no route is a straight shot: the pad hides behind your home world, the goal behind the target, and every winning path has to bend around something.',
      'Fuel forces the issue — tanks are priced below the brute-force direct line, so only the gravity-efficient curve fits the budget.',
      'The light column marks whatever you must reach next, and the camera follows your ship in flight.',
    ],
  },
  {
    v: '1.4',
    date: '2026-07-23',
    title: 'Reading the shot',
    notes: [
      'Chunky dotted prediction line that stays legible against the grid.',
      'Touch aiming is smoothed and ignores the jitter of your finger lifting off.',
      'Smaller goal rings, a smaller ship against big worlds, and a denser, smoother gravity grid.',
    ],
  },
  {
    v: '1.3',
    date: '2026-07-21',
    title: 'Routes worth flying',
    notes: [
      'Levels use the whole map: the Sun sits at the far edge so the flying happens across open space.',
      'Fuel cells sit off the easy route, and reaching them is a genuine detour.',
      'Every level is generated and machine-verified winnable before it ships.',
    ],
  },
  {
    v: '1.2',
    date: '2026-07-20',
    title: 'The Sol campaign',
    notes: [
      '50 levels across five themed sets, from the Earth–Moon hop out to alien suns and black holes.',
      'Space-station targets, cargo hauls, comets, asteroid belt walls and patrol ships.',
      'Installable as an app, and playable offline.',
    ],
  },
  {
    v: '1.1',
    date: '2026-07-19',
    title: 'Fuel, engines, timing',
    notes: [
      'Launches burn fuel, stops never refuel, and engine power caps how hard you can throw.',
      'Antimatter stars push instead of pull.',
      'Streamlined HUD that fits on a phone.',
    ],
  },
  {
    v: '1.0',
    date: '2026-07-18',
    title: 'Liftoff',
    notes: [
      'Spaceship golf across gravity rendered as 3D terrain — drag back, release, and let the wells bend your flight.',
    ],
  },
];

export const VERSION = CHANGELOG[0].v;
