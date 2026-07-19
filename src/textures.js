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
