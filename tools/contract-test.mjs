// Does the drawn scene mean what the simulation means?
//
// The solver never renders and the layout test only measures HUD boxes, so
// nothing was watching the gap between the two — which is where every
// collision/docking bug in this project has lived:
//
//   * a crash registering while the ship is visibly clear of the planet
//     (hit radius wider than the drawn silhouette)
//   * flying through a target ring without docking (ring drawn wider than the
//     radius that scores)
//   * objects placed at the true well depth while the ground is drawn on a
//     shelf, so nothing lines up near a world
//
// Run:  CHROMIUM_PATH=/path/to/chromium node tools/contract-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 8137;
const LEVELS_UNDER_TEST = [0, 2, 6, 20, 25, 33, 44];

let failures = 0;
const fail = m => { console.error(`  ✗ ${m}`); failures++; };
const pass = m => console.log(`  ✓ ${m}`);

// --------------------------------------------------------------- static gate
// Placement must go through one helper. This is the check that would have
// caught the shelf being applied to the terrain and the planets but not to
// the ship, rings, pad, trail or pickups.
function checkNoRawPlacement() {
  console.log('render code places objects through surfaceY(), not raw heightAt()');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (!line.includes('heightAt(level')) return;
    // surfaceY is the one legitimate caller; shelf rim solving is internal
    if (/function surfaceY/.test(line) || line.includes('rim:') || /shelfY\(/.test(line)) return;
    if (/surfaceY/.test(line)) return;
    offenders.push(`main.js:${i + 1}  ${line.trim()}`);
  });
  if (offenders.length) {
    fail(`raw heightAt() used for placement — the drawn surface is shelfY(heightAt(...)):\n      ${offenders.join('\n      ')}`);
  } else {
    pass('all placement goes through surfaceY()');
  }
}

async function main() {
  checkNoRawPlacement();

  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.click('#btn-play');
    await page.waitForFunction(() => window.GL && GL.status().state === 'ready');

    console.log('\ndrawn geometry agrees with the scoring geometry');
    for (const li of LEVELS_UNDER_TEST) {
      await page.evaluate(n => GL.load(n), li);
      await page.waitForFunction(() => GL.status().state === 'ready');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => GL.debugContract());

      // a docking ring's centreline IS the win boundary
      for (const ring of r.rings) {
        if (Math.abs(ring.drawnRadius - ring.scoringRadius) > 1e-6) {
          fail(`L${li + 1} ${ring.what}: ring drawn at r=${ring.drawnRadius} but scores at r=${ring.scoringRadius}`);
        }
        if (ring.tube > ring.scoringRadius * 0.2) {
          fail(`L${li + 1} ${ring.what}: ring tube ${ring.tube} is >20% of the scoring radius ${ring.scoringRadius} — the visible ring extends well past the radius that scores`);
        }
      }

      // a body's drawn silhouette must match what the ship collides with
      for (const b of r.bodies) {
        const over = b.hitRadius - b.drawnRadius;
        if (over > 0.2) {
          fail(`L${li + 1} ${b.name}: collides at ${b.hitRadius.toFixed(2)}u but is drawn at ${b.drawnRadius.toFixed(2)}u — crashes register ${over.toFixed(2)}u clear of the planet`);
        }
        if (over < -0.05) {
          fail(`L${li + 1} ${b.name}: drawn larger (${b.drawnRadius.toFixed(2)}u) than it collides (${b.hitRadius.toFixed(2)}u) — the ship passes through the visible planet`);
        }
      }

      // a world must rest ON the grid, not half-buried in it: with its centre
      // less than a radius up, grid lines nearer the camera draw across it
      for (const b of r.bodies) {
        if (b.sitsAt == null) continue;
        if (b.sitsAt < b.sitRadius - 0.01) {
          fail(`L${li + 1} ${b.name}: centre only ${b.sitsAt.toFixed(2)}u above the drawn surface for a sphere of radius ${b.sitRadius.toFixed(2)}u — the grid cuts through it`);
        }
      }

      // everything resting on the terrain must use the drawn surface
      for (const o of r.onSurface) {
        if (Math.abs(o.y - (o.surfaceY + o.offset)) > 0.05) {
          fail(`L${li + 1} ${o.what}: drawn at y=${o.y.toFixed(2)} but the drawn ground there is ${o.surfaceY.toFixed(2)} (+${o.offset}) — it renders ${(o.y - o.surfaceY - o.offset).toFixed(2)}u off the surface`);
        }
      }
    }
    if (!failures) pass('rings, silhouettes and surface placement all agree');

    // ------------------------------------------------ preview legibility
    console.log('\nthe flight preview is legible, including short crash-bound shots');
    await page.evaluate(() => GL.load(2));
    await page.waitForFunction(() => GL.status().state === 'ready');
    await page.waitForTimeout(400);
    for (const [dx, dy, label] of [[60, 90, 'toward the home world'], [190, 60, 'across the system']]) {
      await page.mouse.move(500, 340);
      await page.mouse.down();
      await page.mouse.move(500 + dx, 340 + dy, { steps: 4 });
      await page.waitForTimeout(300);
      const p = await page.evaluate(() => GL.debugPredict());
      if (!p.lineVis || !p.dotsVis) fail(`preview hidden aiming ${label}`);
      // dots are distance-sampled, so even a stubby trail must show several
      if (p.dotsDrawn < 3) fail(`preview aiming ${label} drew only ${p.dotsDrawn} dots — it reads as nothing at all`);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    if (pageErrors.length) fail(`page errors: ${pageErrors.join('; ')}`);
    if (!failures) pass('preview stays legible');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures ? `\n${failures} contract failure(s)` : '\nDrawn scene and simulation agree.');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
