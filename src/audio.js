// GravityLoop — tiny WebAudio synth. No assets, everything generated.

let ctx = null;
let muted = false;
let thrustNodes = null;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMuted(m) {
  muted = m;
  if (muted) stopThrust();
}
export function isMuted() { return muted; }

function noiseBuffer(c, seconds) {
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export function launchSound(power = 1) {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.6);
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.setValueAtTime(300, t);
  filt.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
  const g = c.createGain();
  g.gain.setValueAtTime(0.28 * Math.min(power, 1) + 0.06, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
}

export function startThrust() {
  if (muted || thrustNodes) return;
  const c = ac(), t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 1);
  src.loop = true;
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 900;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
  thrustNodes = { src, g };
}

export function stopThrust() {
  if (!thrustNodes) return;
  const c = ac(), t = c.currentTime;
  thrustNodes.g.gain.setTargetAtTime(0.0001, t, 0.05);
  thrustNodes.src.stop(t + 0.3);
  thrustNodes = null;
}

export function crashSound() {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.8);
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(2500, t);
  filt.frequency.exponentialRampToValueAtTime(120, t + 0.7);
  const g = c.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(90, t);
  osc.frequency.exponentialRampToValueAtTime(35, t + 0.6);
  const og = c.createGain();
  og.gain.setValueAtTime(0.4, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
  osc.connect(og).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.7);
}

export function winSound() {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const g = c.createGain();
    const s = t + i * 0.11;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.22, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, s + 0.5);
    osc.connect(g).connect(c.destination);
    osc.start(s);
    osc.stop(s + 0.55);
  });
}

export function dockSound() {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  [392, 523.25].forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = c.createGain();
    const s = t + i * 0.13;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.2, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, s + 0.4);
    osc.connect(g).connect(c.destination);
    osc.start(s);
    osc.stop(s + 0.45);
  });
}

export function pickupSound() {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
  const g = c.createGain();
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

export function clickSound() {
  if (muted) return;
  const c = ac(), t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 700;
  const g = c.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}
