// GravityLoop — level definitions.
// Coordinates: x is right, z is toward the camera (ship starts at +z, flies to -z).
// mass < 0 makes a repulsor (a hill instead of a well).

export const LEVELS = [
  {
    name: 'Liftoff',
    hint: 'Drag back from your ship to aim — like a slingshot — then release to launch!',
    extent: 60,
    ship: { x: 0, z: 42 },
    goal: { x: 0, z: -40, r: 7 },
    maxLaunch: 50,
    fuel: 3,
    bodies: [
      { name: 'Pebble', mass: 260, radius: 3, color: 0x8ecae6, x: -34, z: -4 },
    ],
  },
  {
    name: 'The Dip',
    hint: 'That well will bend your shot. Watch the prediction line and aim off-center.',
    extent: 60,
    ship: { x: 0, z: 42 },
    goal: { x: 0, z: -42, r: 5.5 },
    maxLaunch: 50,
    fuel: 3,
    bodies: [
      { name: 'Mint', mass: 1300, radius: 5, color: 0x7ae582, x: 15, z: 0 },
    ],
  },
  {
    name: 'Slingshot',
    hint: 'No way through — so curve around. Dive into the well and let it fling you!',
    extent: 60,
    ship: { x: 0, z: 44 },
    goal: { x: 0, z: -44, r: 5 },
    maxLaunch: 48,
    fuel: 3,
    bodies: [
      { name: 'Rusty', mass: 2100, radius: 7, color: 0xff8fa3, x: 0, z: -2 },
    ],
  },
  {
    name: 'The Saddle',
    hint: 'Two wells, one ridge between them. Thread the saddle — or swing wide.',
    extent: 62,
    ship: { x: -10, z: 44 },
    goal: { x: 4, z: -44, r: 4.5 },
    maxLaunch: 48,
    fuel: 3,
    bodies: [
      { name: 'Castor', mass: 1500, radius: 6, color: 0xffd166, x: -16, z: 0 },
      { name: 'Pollux', mass: 1500, radius: 6, color: 0xf4a261, x: 16, z: 0 },
    ],
  },
  {
    name: 'Repulsor Ridge',
    hint: 'That hill pushes you AWAY. Ride the pass between the hill and the well.',
    extent: 62,
    ship: { x: 0, z: 44 },
    goal: { x: 0, z: -44, r: 5 },
    maxLaunch: 48,
    fuel: 3.5,
    bodies: [
      { name: 'Nope', mass: -1200, radius: 4.5, color: 0xff6b35, x: -12, z: 0 },
      { name: 'Anchor', mass: 1300, radius: 5, color: 0x90e0ef, x: 16, z: -2 },
    ],
  },
  {
    name: 'Moonshot',
    hint: 'The moon keeps moving — even while you aim. Time your release!',
    extent: 62,
    ship: { x: 0, z: 44 },
    goal: { x: 0, z: -46, r: 5 },
    maxLaunch: 48,
    fuel: 3.5,
    bodies: [
      { name: 'Aegis', mass: 2200, radius: 7, color: 0xbde0fe, x: 0, z: -4 },
      { name: 'Luna', mass: 520, radius: 3, color: 0xe2e2e2, orbit: { parent: 0, radius: 20, omega: 0.7, phase: 0.8 } },
    ],
  },
  {
    name: 'Event Horizon',
    hint: 'Nothing escapes the red ring. Skim close for a huge slingshot — but not TOO close.',
    extent: 64,
    ship: { x: -38, z: 44 },
    goal: { x: 34, z: -44, r: 4.5 },
    maxLaunch: 44,
    fuel: 4,
    bodies: [
      { name: 'Maw', mass: 5200, radius: 3.5, horizon: 6.5, color: 0x1a1a2e, x: 0, z: 0, type: 'blackhole' },
    ],
  },
  {
    name: 'Grand Tour',
    hint: 'Everything at once. Take your time — plot the long way round.',
    extent: 74,
    ship: { x: 30, z: 56 },
    goal: { x: -34, z: -50, r: 5 },
    maxLaunch: 48,
    fuel: 5,
    bodies: [
      { name: 'Titan', mass: 1700, radius: 6, color: 0xffd166, x: 26, z: 14 },
      { name: 'Wisp', mass: 420, radius: 2.5, color: 0xe2e2e2, orbit: { parent: 0, radius: 15, omega: 0.8, phase: 2.1 } },
      { name: 'Nope II', mass: -1600, radius: 4.5, color: 0xff6b35, x: 2, z: -4 },
      { name: 'Maw II', mass: 4200, radius: 3, horizon: 5.5, color: 0x1a1a2e, x: -26, z: -18, type: 'blackhole' },
    ],
  },
];
