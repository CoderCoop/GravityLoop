// GravityLoop — procedural canvas textures for the sci-fi look.
// Everything is generated at runtime, deterministically seeded, no assets.
import * as THREE from '../vendor/three.module.js';

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

function tex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

function shade(hex, f) {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 255) * f)) | 0;
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 255) * f)) | 0;
  const b = Math.min(255, Math.max(0, (hex & 255) * f)) | 0;
  return `rgb(${r},${g},${b})`;
}

// ------------------------------------------------- named solar-system worlds
// Recipes so the real planets read as themselves at a glance: Earth's oceans
// and cloud swirls, Mars' rust and caps, Jupiter's belts and red spot, Io's
// sulfur, Europa's cracks. Everything still canvas-drawn and seeded.
const NW = 256, NH = 128;

function fillNoise(g, rng, n, colors, rMin, rMax, alpha) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(rng() * colors.length) | 0];
    g.globalAlpha = alpha[0] + rng() * (alpha[1] - alpha[0]);
    const r = rMin + rng() * (rMax - rMin);
    g.beginPath(); g.arc(rng() * NW, rng() * NH, r, 0, 6.283); g.fill();
  }
  g.globalAlpha = 1;
}

// Wrap-safe blob: an irregular closed shape drawn at (cx, cy).
function blob(g, rng, cx, cy, rx, ry, fill, lobes) {
  g.fillStyle = fill;
  g.beginPath();
  const n = lobes || 9;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 6.283;
    const k = 0.55 + rng() * 0.75;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath(); g.fill();
}

function craters(g, rng, n, base, rMin, rMax) {
  for (let i = 0; i < n; i++) {
    const x = rng() * NW, y = NH * 0.08 + rng() * NH * 0.84;
    const r = rMin + rng() * (rMax - rMin);
    g.fillStyle = shade(base, 0.62);
    g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    g.fillStyle = shade(base, 1.28);
    g.beginPath(); g.arc(x - r * 0.22, y - r * 0.22, r * 0.6, 0, 6.283); g.fill();
    g.fillStyle = shade(base, 0.5);
    g.beginPath(); g.arc(x + r * 0.18, y + r * 0.2, r * 0.45, 0, 6.283); g.fill();
  }
}

function belts(g, rng, stops, streaks) {
  for (const [y0, y1, col] of stops) {
    g.fillStyle = col;
    g.fillRect(0, y0 * NH, NW, (y1 - y0) * NH + 1);
  }
  for (let i = 0; i < streaks; i++) {
    const y = rng() * NH;
    g.strokeStyle = rng() < 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)';
    g.lineWidth = 1 + rng() * 3;
    g.beginPath();
    const amp = 1 + rng() * 3, ph = rng() * 6.28;
    for (let x = 0; x <= NW; x += 8) {
      const py = y + Math.sin(x / 24 + ph) * amp;
      if (x === 0) g.moveTo(x, py); else g.lineTo(x, py);
    }
    g.stroke();
  }
}

function caps(g, top, bot, colTop, colBot) {
  g.fillStyle = colTop; g.fillRect(0, 0, NW, top);
  g.fillStyle = colBot || colTop; g.fillRect(0, NH - bot, NW, bot);
}

const RECIPES = {
  earth(g, rng) {
    const oc = g.createLinearGradient(0, 0, 0, NH);
    oc.addColorStop(0, '#1d4f8c'); oc.addColorStop(0.5, '#1668b5'); oc.addColorStop(1, '#1d4f8c');
    g.fillStyle = oc; g.fillRect(0, 0, NW, NH);
    // continents: a few big landmasses plus scattered islands
    const land = ['#2f7d3f', '#3f8c46', '#6b8f4a', '#8a7a4d'];
    const masses = [[38, 46, 26, 24], [64, 92, 18, 26], [140, 42, 30, 20],
                    [176, 78, 16, 18], [212, 52, 22, 22], [118, 100, 14, 12]];
    for (const [x, y, rx, ry] of masses) {
      blob(g, rng, x, y, rx, ry, land[(rng() * land.length) | 0], 11);
      blob(g, rng, x + rx * 0.4, y + ry * 0.25, rx * 0.55, ry * 0.5, land[(rng() * land.length) | 0], 9);
    }
    fillNoise(g, rng, 26, ['#2f7d3f', '#7d6f45'], 1, 3.5, [0.5, 0.9]);
    // deserts warm the big masses a little
    g.globalAlpha = 0.35;
    blob(g, rng, 142, 48, 16, 9, '#c9a86a', 9);
    blob(g, rng, 214, 44, 12, 8, '#c9a86a', 9);
    g.globalAlpha = 1;
    caps(g, 7, 8, 'rgba(240,248,255,0.92)');
    // cloud swirls last, semi-transparent
    g.globalAlpha = 0.5;
    for (let i = 0; i < 22; i++) {
      const y = rng() * NH;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2 + rng() * 5;
      g.beginPath();
      const x0 = rng() * NW, len = 20 + rng() * 70, amp = 3 + rng() * 6, ph = rng() * 6.28;
      for (let x = 0; x <= len; x += 6) {
        const px = (x0 + x) % NW, py = y + Math.sin(x / 18 + ph) * amp;
        if (x === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  },
  moon(g, rng) {
    g.fillStyle = '#a8a8a8'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 500, ['#9a9a9a', '#b6b6b6', '#8f8f8f'], 1, 5, [0.15, 0.4]);
    // dark maria
    g.globalAlpha = 0.55;
    for (const [x, y, r] of [[60, 44, 26], [96, 38, 16], [40, 70, 14], [150, 52, 12]]) {
      blob(g, rng, x, y, r, r * 0.7, '#5d5d63', 10);
    }
    g.globalAlpha = 1;
    craters(g, rng, 34, 0xa8a8a8, 2, 8);
  },
  mars(g, rng) {
    g.fillStyle = '#b4522e'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 420, ['#c2603a', '#a0451f', '#d07b4a'], 1, 6, [0.18, 0.4]);
    g.globalAlpha = 0.5;
    for (const [x, y, rx] of [[70, 62, 30], [160, 74, 22], [220, 56, 18]]) {
      blob(g, rng, x, y, rx, rx * 0.5, '#7d3a22', 11);
    }
    g.globalAlpha = 1;
    craters(g, rng, 18, 0xb4522e, 2, 6);
    // Valles-style rift
    g.strokeStyle = 'rgba(90,40,22,0.75)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(96, 70); g.bezierCurveTo(130, 64, 160, 76, 196, 68); g.stroke();
    caps(g, 10, 7, 'rgba(255,252,248,0.95)');
  },
  venus(g, rng) {
    g.fillStyle = '#d9b473'; g.fillRect(0, 0, NW, NH);
    belts(g, rng, [[0, 0.18, '#e6c98d'], [0.18, 0.42, '#d3a962'], [0.42, 0.62, '#e2c185'],
                   [0.62, 0.84, '#c99b57'], [0.84, 1, '#e6c98d']], 34);
    g.globalAlpha = 0.4;
    for (let i = 0; i < 16; i++) {
      const y = rng() * NH;
      g.strokeStyle = '#fff0cf'; g.lineWidth = 3 + rng() * 6;
      g.beginPath();
      for (let x = 0; x <= NW; x += 10) {
        const py = y + Math.sin(x / 40 + i) * (4 + rng() * 3);
        if (x === 0) g.moveTo(x, py); else g.lineTo(x, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  },
  mercury(g, rng) {
    g.fillStyle = '#8c8378'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 520, ['#7d756b', '#9a9086', '#6e675e'], 1, 5, [0.16, 0.38]);
    craters(g, rng, 46, 0x8c8378, 2, 9);
  },
  jupiter(g, rng) {
    belts(g, rng, [
      [0, 0.08, '#d8c6a8'], [0.08, 0.18, '#b98d5f'], [0.18, 0.29, '#e8dcc2'],
      [0.29, 0.38, '#a97644'], [0.38, 0.5, '#efe3ca'], [0.5, 0.6, '#c08a54'],
      [0.6, 0.72, '#e6d7b8'], [0.72, 0.83, '#a87a4c'], [0.83, 1, '#d9c8aa'],
    ], 60);
    // Great Red Spot
    const sx = 78, sy = NH * 0.62;
    g.save(); g.translate(sx, sy); g.scale(1.9, 1); g.translate(-sx, -sy);
    const gr = g.createRadialGradient(sx, sy, 1, sx, sy, 13);
    gr.addColorStop(0, '#d4553a'); gr.addColorStop(0.6, '#c2664a'); gr.addColorStop(1, 'rgba(194,102,74,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(sx, sy, 13, 0, 6.283); g.fill();
    g.restore();
  },
  saturn(g, rng) {
    belts(g, rng, [[0, 0.12, '#e7d5aa'], [0.12, 0.3, '#dcc79b'], [0.3, 0.5, '#f0e2bd'],
                   [0.5, 0.7, '#d9c193'], [0.7, 0.88, '#eaddb6'], [0.88, 1, '#dccaa0']], 40);
  },
  io(g, rng) {
    g.fillStyle = '#e8d558'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 380, ['#f2e57f', '#d8b83f', '#c9992c'], 2, 8, [0.2, 0.5]);
    for (let i = 0; i < 16; i++) {
      const x = rng() * NW, y = NH * 0.1 + rng() * NH * 0.8, r = 2 + rng() * 5;
      g.fillStyle = 'rgba(70,40,20,0.75)';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(230,90,40,0.35)';
      g.beginPath(); g.arc(x, y, r * 2.1, 0, 6.283); g.fill();
    }
  },
  europa(g, rng) {
    g.fillStyle = '#e7e3d8'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 160, ['#f4f1ea', '#dad5c8'], 2, 7, [0.2, 0.45]);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(150,95,60,${0.35 + rng() * 0.4})`;
      g.lineWidth = 0.8 + rng() * 1.8;
      g.beginPath();
      const x0 = rng() * NW, y0 = rng() * NH;
      g.moveTo(x0, y0);
      g.bezierCurveTo(x0 + 30 + rng() * 50, y0 + (rng() - 0.5) * 40,
                      x0 + 70 + rng() * 60, y0 + (rng() - 0.5) * 50,
                      x0 + 120 + rng() * 70, y0 + (rng() - 0.5) * 30);
      g.stroke();
    }
  },
  ganymede(g, rng) {
    g.fillStyle = '#9d9384'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 300, ['#b0a696', '#8b8273'], 2, 7, [0.2, 0.45]);
    g.globalAlpha = 0.4;
    for (let i = 0; i < 10; i++) blob(g, rng, rng() * NW, rng() * NH, 20 + rng() * 24, 10 + rng() * 14, '#6f685c', 11);
    g.globalAlpha = 1;
    for (let i = 0; i < 18; i++) {                    // grooved terrain
      const y = rng() * NH;
      g.strokeStyle = 'rgba(210,203,190,0.5)'; g.lineWidth = 1 + rng() * 2;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= NW; x += 12) g.lineTo(x, y + Math.sin(x / 30 + i) * 3);
      g.stroke();
    }
    craters(g, rng, 20, 0x9d9384, 2, 6);
  },
  callisto(g, rng) {
    g.fillStyle = '#6f6459'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 420, ['#7d7266', '#5f564c'], 1, 6, [0.2, 0.45]);
    craters(g, rng, 60, 0x6f6459, 2, 9);
  },
  titan(g, rng) {
    g.fillStyle = '#d69a44'; g.fillRect(0, 0, NW, NH);
    belts(g, rng, [[0, 0.25, '#e0aa58'], [0.25, 0.55, '#cf9038'], [0.55, 0.8, '#dda54f'], [0.8, 1, '#c8892f']], 20);
    g.globalAlpha = 0.35;
    fillNoise(g, rng, 60, ['#f2c884', '#b87a28'], 6, 18, [0.2, 0.5]);
    g.globalAlpha = 1;
  },
  ice(g, rng) {                                        // Rhea/Enceladus/Dione
    g.fillStyle = '#dfe6ea'; g.fillRect(0, 0, NW, NH);
    fillNoise(g, rng, 260, ['#eef4f7', '#c9d3d9'], 1, 6, [0.2, 0.45]);
    craters(g, rng, 40, 0xdfe6ea, 2, 7);
  },
};

const ALIAS = {
  earth: 'earth', terra: 'earth',
  moon: 'moon', luna: 'moon',
  mars: 'mars', venus: 'venus', mercury: 'mercury',
  jupiter: 'jupiter', saturn: 'saturn',
  io: 'io', europa: 'europa', ganymede: 'ganymede', callisto: 'callisto',
  titan: 'titan', rhea: 'ice', enceladus: 'ice', dione: 'ice', tethys: 'ice',
};

export function hasNamedTexture(name) {
  return !!(name && ALIAS[name.toLowerCase()]);
}

// Texture for a named solar-system body; null if we have no recipe for it.
export function namedPlanetTexture(name, seed) {
  const key = name && ALIAS[name.toLowerCase()];
  if (!key) return null;
  const cv = canvas(NW, NH), g = cv.getContext('2d');
  RECIPES[key](g, mulberry32(seed));
  return tex(cv);
}

// --------------------------------------------------------------- planets
// Equirect map for a sphere: horizontal = longitude. Gas giants get flowing
// bands with streaks; rocky worlds get speckle, craters and polar caps.
export function planetTexture(color, seed, style) {
  const rng = mulberry32(seed);
  const W = 256, H = 128;
  const cv = canvas(W, H), g = cv.getContext('2d');

  if (style === 'banded') {
    const bands = 6 + Math.floor(rng() * 6);
    for (let b = 0; b < bands; b++) {
      const y0 = (b / bands) * H;
      const hgt = H / bands + 2;
      const f = 0.62 + rng() * 0.75;
      g.fillStyle = shade(color, f);
      g.fillRect(0, y0, W, hgt);
    }
    // flowing streaks along the bands
    for (let i = 0; i < 46; i++) {
      const y = rng() * H;
      const f = 0.55 + rng() * 0.95;
      g.strokeStyle = shade(color, f);
      g.globalAlpha = 0.35 + rng() * 0.3;
      g.lineWidth = 1 + rng() * 3;
      g.beginPath();
      const amp = 1.5 + rng() * 3.5, ph = rng() * 6.28, len = W * (0.4 + rng() * 0.6), x0 = rng() * W;
      for (let x = 0; x <= len; x += 8) {
        const px = (x0 + x) % W;
        const py = y + Math.sin(x / 26 + ph) * amp;
        if (x === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // one storm oval on some giants
    if (rng() < 0.5) {
      const sx = rng() * W, sy = H * (0.3 + rng() * 0.4);
      const grad = g.createRadialGradient(sx, sy, 0, sx, sy, 12);
      grad.addColorStop(0, shade(color, 1.55));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.save();
      g.translate(sx, sy); g.scale(1.8, 1); g.translate(-sx, -sy);
      g.fillRect(sx - 24, sy - 14, 48, 28);
      g.restore();
    }
  } else {
    // rocky
    g.fillStyle = shade(color, 0.95);
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = shade(color, 0.55 + rng() * 1.0);
      g.globalAlpha = 0.16 + rng() * 0.22;
      const r = 1 + rng() * 5;
      g.beginPath();
      g.arc(rng() * W, rng() * H, r, 0, 6.283);
      g.fill();
    }
    g.globalAlpha = 1;
    // craters
    for (let i = 0; i < 14; i++) {
      const x = rng() * W, y = H * 0.12 + rng() * H * 0.76, r = 2 + rng() * 5;
      g.fillStyle = shade(color, 0.55);
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.fillStyle = shade(color, 1.3);
      g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, 6.283); g.fill();
    }
    // polar caps
    if (rng() < 0.5) {
      g.fillStyle = 'rgba(235,244,255,0.85)';
      g.fillRect(0, 0, W, 5 + rng() * 8);
      g.fillRect(0, H - (5 + rng() * 8), W, 14);
    }
  }
  return tex(cv);
}

// ------------------------------------------------------------------ suns
export function sunTexture(color, seed) {
  const rng = mulberry32(seed);
  const W = 256, H = 128;
  const cv = canvas(W, H), g = cv.getContext('2d');
  g.fillStyle = shade(color, 1.35);
  g.fillRect(0, 0, W, H);
  // granulation cells
  for (let i = 0; i < 700; i++) {
    g.fillStyle = shade(color, 0.85 + rng() * 0.7);
    g.globalAlpha = 0.2 + rng() * 0.25;
    const r = 2 + rng() * 6;
    g.beginPath();
    g.arc(rng() * W, rng() * H, r, 0, 6.283);
    g.fill();
  }
  g.globalAlpha = 1;
  // a few darker sunspot pairs
  for (let i = 0; i < 5; i++) {
    g.fillStyle = shade(color, 0.45);
    g.globalAlpha = 0.7;
    g.beginPath();
    g.arc(rng() * W, H * (0.25 + rng() * 0.5), 1.5 + rng() * 3, 0, 6.283);
    g.fill();
  }
  g.globalAlpha = 1;
  return tex(cv);
}

// ------------------------------------------------------- planetary rings
// Concentric translucent bands drawn on a square canvas; RingGeometry's
// planar UVs map it straight on.
export function ringSystemTexture(color, seed) {
  const rng = mulberry32(seed);
  const S = 256, c = S / 2;
  const cv = canvas(S, S), g = cv.getContext('2d');
  const bands = 14 + Math.floor(rng() * 10);
  for (let i = 0; i < bands; i++) {
    const r0 = (0.45 + (i / bands) * 0.53) * c;
    g.strokeStyle = shade(color, 0.7 + rng() * 0.8);
    g.globalAlpha = 0.1 + rng() * 0.4;
    g.lineWidth = 1 + rng() * 4;
    g.beginPath();
    g.arc(c, c, r0, 0, 6.283);
    g.stroke();
  }
  return tex(cv);
}

// -------------------------------------------------- black hole accretion
export function accretionTexture(seed) {
  const rng = mulberry32(seed);
  const S = 256, c = S / 2;
  const cv = canvas(S, S), g = cv.getContext('2d');
  for (let i = 0; i < 40; i++) {
    const r0 = (0.3 + (i / 40) * 0.68) * c;
    const heat = 1 - i / 40; // hotter inside
    const col = heat > 0.66 ? '255,240,200' : heat > 0.33 ? '255,150,80' : '200,60,90';
    g.strokeStyle = `rgba(${col},${0.12 + rng() * 0.3})`;
    g.lineWidth = 1.5 + rng() * 3;
    // broken arcs for turbulence
    let a = rng() * 6.283;
    while (a < 6.283 + 1) {
      const seg = 0.4 + rng() * 1.4;
      g.beginPath();
      g.arc(c, c, r0, a, a + seg);
      g.stroke();
      a += seg + rng() * 0.5;
    }
  }
  return tex(cv);
}

// ---------------------------------------------------------------- nebula
export function nebulaTexture(seed) {
  const rng = mulberry32(seed);
  const S = 512;
  const cv = canvas(S, S), g = cv.getContext('2d');
  const hues = [265, 205, 320, 180, 235];
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const x = S * (0.15 + rng() * 0.7), y = S * (0.15 + rng() * 0.7);
    const r = S * (0.08 + rng() * 0.22);
    const hue = hues[Math.floor(rng() * hues.length)] + rng() * 25;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `hsla(${hue}, 85%, ${45 + rng() * 25}%, ${0.10 + rng() * 0.12})`);
    grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  // embedded stars
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(255,255,255,${0.3 + rng() * 0.6})`;
    const r = rng() < 0.85 ? 0.7 : 1.6;
    g.beginPath();
    g.arc(rng() * S, rng() * S, r, 0, 6.283);
    g.fill();
  }
  return tex(cv);
}

// ------------------------------------------------------------ star flare
export function flareTexture() {
  const S = 128, c = S / 2;
  const cv = canvas(S, S), g = cv.getContext('2d');
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // diffraction spikes
  const spike = g.createLinearGradient(0, c, S, c);
  spike.addColorStop(0, 'rgba(255,255,255,0)');
  spike.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  spike.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = spike;
  g.fillRect(0, c - 1, S, 2);
  g.save();
  g.translate(c, c); g.rotate(Math.PI / 2); g.translate(-c, -c);
  g.fillRect(0, c - 1, S, 2);
  g.restore();
  return tex(cv);
}

// ------------------------------------------------------------- soft glow
export function glowTexture() {
  const S = 128, c = S / 2;
  const cv = canvas(S, S), g = cv.getContext('2d');
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return tex(cv);
}
