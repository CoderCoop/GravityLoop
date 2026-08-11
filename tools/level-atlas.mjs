// A one-page reference for all 50 levels: a plan view of each, the easiest
// winning route through it, and the numbers that decide how hard it is.
//
//   node tools/level-atlas.mjs            # writes docs/level-atlas.html
//
// The route drawn is deliberately the LAZIEST winning one — the straightest
// path the brute-force solver can find that still reaches the goal. A level is
// as hard as its easiest solution, so that is the line worth looking at: if it
// runs straight from pad to goal through empty space, the level is easy no
// matter what the rest of the geometry looks like.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, SETS } from '../src/levels.js';
import { predict, legStart, legCount, bodiesAt, hazardsAt, launchFuelCost,
  maxAffordableLaunch, activeTarget, anchorX, anchorZ } from '../src/physics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 300;                       // svg viewport, world units are scaled to it
const ANG = 3, SP = 4, T_STEP = 0.9; // same coarse grid solve.js --fast uses

const isEnd = (lv, key, i, b) => {
  const e = lv[key];
  return e != null && (i === e || b.moonOf === e);
};
const dynamic = lv => lv.bodies.some(b => b.orbit) ||
  (lv.hazards || []).some(h => h.orbit || h.patrol || h.comet);

function turningOf(pts) {
  let t = 0;
  for (let k = 2; k < pts.length; k++) {
    const a = pts[k - 2], b = pts[k - 1], c = pts[k];
    let d = Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    t += Math.abs(d);
  }
  return t;
}

// worlds the route passes close to that are neither of its two ends
function viaOf(lv, r) {
  let via = 0;
  for (let bi = 0; bi < lv.bodies.length; bi++) {
    const b = lv.bodies[bi];
    if (isEnd(lv, 'homeIdx', bi, b) || isEnd(lv, 'targetIdx', bi, b)) continue;
    for (let k = 0; k < r.points.length; k += 4) {
      const p = r.points[k];
      const ps = bodiesAt(lv, p.t != null ? p.t : 0);
      if (Math.hypot(p.x - ps[bi].x, p.z - ps[bi].z) < b.radius + 8) { via++; break; }
    }
  }
  return via;
}

// The straightest winning launch for one leg, plus whether any winner at all
// avoided every third-party world (a "direct" shot).
function laziestWin(lv, stage) {
  const times = dynamic(lv) ? Array.from({ length: 11 }, (_, i) => i * T_STEP) : [0];
  let best = null, direct = false, wins = 0;
  for (const t0 of times) {
    const start = legStart(lv, stage, bodiesAt(lv, t0));
    for (let ang = 0; ang < 360; ang += ANG) {
      const rad = (ang * Math.PI) / 180;
      for (let sp = 10; sp <= lv.maxLaunch; sp += SP) {
        const r = predict(lv, start.x, start.z, Math.cos(rad) * sp, Math.sin(rad) * sp, t0, 12, stage);
        if (r.outcome !== 'goal' && r.outcome !== 'waypoint') continue;
        wins++;
        const turn = turningOf(r.points);
        const via = viaOf(lv, r);
        if (via === 0) direct = true;
        if (!best || turn < best.turn) best = { turn, via, sp, t0, points: r.points };
      }
    }
  }
  return { best, direct, wins };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgFor(lv, legs) {
  const E = lv.extent, s = W / (2 * E * 1.02);
  const X = x => (x + E * 1.02) * s, Z = z => (z + E * 1.02) * s;
  const out = [`<svg viewBox="0 0 ${W} ${W}" class="map">`];
  out.push(`<rect width="${W}" height="${W}" fill="#0a0d1a"/>`);
  const ps = bodiesAt(lv, 0);
  // orbit rings first, so bodies sit on top of them
  lv.bodies.forEach((b, i) => {
    if (!b.orbit || b.orbit.parent != null) return;
    out.push(`<circle cx="${X(b.orbit.cx || 0).toFixed(1)}" cy="${Z(b.orbit.cz || 0).toFixed(1)}" r="${(b.orbit.radius * s).toFixed(1)}" fill="none" stroke="#3a4668" stroke-width="0.5" stroke-dasharray="2 3"/>`);
  });
  (lv.hazards || []).forEach(h => {
    if (!h.comet) return;
    const c = h.comet, pts = [];
    for (let k = 0; k <= 48; k++) {
      const th = (k / 48) * Math.PI * 2;
      const px = Math.cos(th) * c.a, pz = Math.sin(th) * c.b;
      const co = Math.cos(c.rot || 0), si = Math.sin(c.rot || 0);
      pts.push(`${X(c.cx + px * co - pz * si).toFixed(1)},${Z(c.cz + px * si + pz * co).toFixed(1)}`);
    }
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#2f5a70" stroke-width="0.5" stroke-dasharray="2 3"/>`);
  });
  // bodies
  lv.bodies.forEach((b, i) => {
    const p = ps[i];
    const col = b.type === 'blackhole' ? '#000' : b.mass < 0 ? '#c77dff'
      : b.type === 'sun' ? '#ffd24a' : b.moonOf != null ? '#c8c8c8' : '#7fa6d8';
    const r = Math.max((b.type === 'blackhole' ? b.horizon || b.radius : b.radius) * s, 1);
    out.push(`<circle cx="${X(p.x).toFixed(1)}" cy="${Z(p.z).toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" stroke="#1a2035" stroke-width="0.4"/>`);
    // the radius a route is credited for "passing" this world
    out.push(`<circle cx="${X(p.x).toFixed(1)}" cy="${Z(p.z).toFixed(1)}" r="${((b.radius + 8) * s).toFixed(1)}" fill="none" stroke="${col}" stroke-width="0.3" opacity="0.22"/>`);
  });
  // the route, leg by leg
  legs.forEach((leg, li) => {
    if (!leg.best) return;
    const pts = leg.best.points.map(p => `${X(p.x).toFixed(1)},${Z(p.z).toFixed(1)}`).join(' ');
    const col = ['#5ef1a6', '#ffd24a', '#ff8fb0'][li % 3];
    out.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.4" opacity="0.95"/>`);
  });
  // pad, waypoints, goal
  const pad = { x: anchorX(lv.ship, ps), z: anchorZ(lv.ship, ps) };
  out.push(`<circle cx="${X(pad.x).toFixed(1)}" cy="${Z(pad.z).toFixed(1)}" r="2.6" fill="none" stroke="#5ef1a6" stroke-width="1.2"/>`);
  (lv.waypoints || []).forEach((wp, k) => {
    const x = anchorX(wp, ps), z = anchorZ(wp, ps);
    out.push(`<rect x="${(X(x) - 2.4).toFixed(1)}" y="${(Z(z) - 2.4).toFixed(1)}" width="4.8" height="4.8" fill="none" stroke="#ffd24a" stroke-width="1.1"/>`);
  });
  const g = { x: anchorX(lv.goal, ps), z: anchorZ(lv.goal, ps) };
  out.push(`<circle cx="${X(g.x).toFixed(1)}" cy="${Z(g.z).toFixed(1)}" r="${Math.max(lv.goal.r * s, 2.6).toFixed(1)}" fill="none" stroke="#ff6b8a" stroke-width="1.4"/>`);
  out.push(`<circle cx="${X(g.x).toFixed(1)}" cy="${Z(g.z).toFixed(1)}" r="1" fill="#ff6b8a"/>`);
  out.push('</svg>');
  return out.join('');
}

const rows = [];
for (const [i, lv] of LEVELS.entries()) {
  const n = legCount(lv);
  const legs = [];
  for (let s = 0; s < n; s++) legs.push(laziestWin(lv, s));
  const turn = legs.reduce((a, l) => a + (l.best ? l.best.turn : 0), 0);
  const via = legs.reduce((a, l) => a + (l.best ? l.best.via : 0), 0);
  const anyLegUnsolved = legs.some(l => !l.best);
  const forced = !anyLegUnsolved && !legs.every(l => l.direct);
  const minWins = Math.min(...legs.map(l => l.wins));
  const set = SETS.find(s => lv.difficulty === s.difficulty);
  rows.push({
    n: i + 1, name: lv.name, set: set ? set.name : '', stars: lv.difficulty,
    legs: n, turn, via, forced, minWins, unsolved: anyLegUnsolved,
    fuel: lv.fuel, maxLaunch: lv.maxLaunch,
    power: maxAffordableLaunch(lv.fuel, lv.maxLaunch) / lv.maxLaunch,
    bodies: lv.bodies.length, hazards: (lv.hazards || []).length,
    svg: svgFor(lv, legs),
  });
  process.stderr.write(`\r  solved ${i + 1}/50`);
}
process.stderr.write('\n');

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = {
  forced: rows.filter(r => r.forced).length,
  viaAny: rows.filter(r => r.via > 0).length,
  medTurn: med(rows.map(r => r.turn)),
  medVia: med(rows.map(r => r.via)),
  medPower: med(rows.map(r => r.power)),
};

const card = r => `
<figure class="lv${r.forced ? '' : ' easy'}">
  ${r.svg}
  <figcaption>
    <h3><span class="n">${r.n}</span> ${esc(r.name)}</h3>
    <div class="set">${esc(r.set)} · ${'★'.repeat(r.stars)}</div>
    <dl>
      <dt>laziest route bends</dt><dd class="${r.turn < 1 ? 'bad' : r.turn < 2 ? 'meh' : 'ok'}">${r.turn.toFixed(2)} rad</dd>
      <dt>worlds passed</dt><dd class="${r.via === 0 ? 'bad' : r.via === 1 ? 'meh' : 'ok'}">${r.via}</dd>
      <dt>direct shot</dt><dd class="${r.forced ? 'ok' : 'bad'}">${r.forced ? 'impossible' : 'possible'}</dd>
      <dt>legs</dt><dd>${r.legs}</dd>
      <dt>engine usable</dt><dd class="${r.power > 0.8 ? 'bad' : r.power > 0.6 ? 'meh' : 'ok'}">${Math.round(r.power * 100)}%</dd>
      <dt>fuel / max launch</dt><dd>${r.fuel} / ${r.maxLaunch}</dd>
      <dt>winning launches</dt><dd>${r.minWins}</dd>
    </dl>
  </figcaption>
</figure>`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>Gravity Loop — level reference</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #070910; color: #dde3f0;
         font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lede { color: #93a0bd; max-width: 70ch; margin: 0 0 18px; }
  .totals { display: flex; gap: 26px; flex-wrap: wrap; padding: 14px 16px; margin: 0 0 22px;
            background: #0e1220; border: 1px solid #1d2438; border-radius: 8px; }
  .totals b { display: block; font-size: 20px; color: #fff; }
  .totals span { color: #93a0bd; font-size: 12px; }
  .key { color: #93a0bd; font-size: 12px; margin: 0 0 22px; }
  .key i { font-style: normal; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
  figure { margin: 0; background: #0e1220; border: 1px solid #1d2438; border-radius: 8px; overflow: hidden; }
  figure.easy { border-color: #6b2740; }
  .map { display: block; width: 100%; height: auto; background: #0a0d1a; }
  figcaption { padding: 10px 12px 12px; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
  h3 .n { display: inline-block; min-width: 2.2em; color: #7f8db0; }
  .set { color: #7f8db0; font-size: 12px; margin: 1px 0 8px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 0; font-size: 12.5px; }
  dt { color: #8b98b8; }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: #5ef1a6; } .meh { color: #ffd24a; } .bad { color: #ff7b95; }
</style>
<h1>Gravity Loop — level reference</h1>
<p class="lede">Every level in plan view with its <strong>laziest winning route</strong> drawn: the
straightest path the brute-force solver can find that still reaches the goal. A level is only as
hard as its easiest solution, so this is the line that matters — if it runs from pad to goal through
open space, the level is easy however elaborate the rest of the map looks. Levels where a direct
shot is still possible are outlined in red.</p>
<div class="totals">
  <div><b>${summary.forced}/50</b><span>no direct shot at any power</span></div>
  <div><b>${summary.viaAny}/50</b><span>laziest route passes a third world</span></div>
  <div><b>${summary.medTurn.toFixed(2)}</b><span>median bend (rad)</span></div>
  <div><b>${summary.medVia}</b><span>median worlds passed</span></div>
  <div><b>${Math.round(summary.medPower * 100)}%</b><span>median engine affordable</span></div>
</div>
<p class="key">Key —
  <i style="color:#5ef1a6">◯ pad</i> ·
  <i style="color:#ffd24a">▢ stop</i> ·
  <i style="color:#ff6b8a">◎ goal</i> ·
  <i style="color:#ffd24a">● star</i> ·
  <i style="color:#7fa6d8">● planet</i> ·
  <i style="color:#c8c8c8">● moon</i> ·
  <i style="color:#c77dff">● antimatter</i> ·
  ● black hole.
  The faint halo round each world is the radius a route must enter to count as passing it.
  Route colour changes per leg.</p>
<div class="grid">
${rows.map(card).join('\n')}
</div>
`;

fs.mkdirSync(path.join(HERE, '..', 'docs'), { recursive: true });
fs.writeFileSync(path.join(HERE, '..', 'docs', 'level-atlas.html'), html);
console.log(`docs/level-atlas.html — ${summary.forced}/50 forced, median bend ${summary.medTurn.toFixed(2)} rad, median ${summary.medVia} worlds passed`);
const worst = rows.filter(r => !r.forced || r.via === 0).map(r => `${r.n} ${r.name}`);
if (worst.length) console.log(`easiest levels (direct shot possible or nothing passed): ${worst.join(', ')}`);
