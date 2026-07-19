// UI layout test: loads the game at several viewport sizes and fails if any
// HUD control (pills, buttons, level bar, set bar) is rendered outside the
// visible viewport. Guards against overflow regressions on small screens.
//
//   node tools/ui-test.mjs
//
// Browser resolution: uses the `playwright-core` devDependency plus a system
// Chromium/Chrome binary. Set CHROMIUM_PATH to the executable; otherwise
// common locations are probed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};

const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'small tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

// Elements that must always sit fully inside the viewport.
const SELECTORS = ['#hud .pill', '#hud .btn', '#hint', '#set-bar button', '#dot-bar button', '#set-name'];

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  throw new Error('No Chromium binary found — set CHROMIUM_PATH');
}

function collectIssues(sels) {
  const out = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.hidden) continue;
      if (el.checkVisibility && !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) {
        const label = el.id ? `#${el.id}` : `${sel} "${(el.textContent || '').trim().slice(0, 12)}"`;
        out.push(`${label} at [${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}] outside ${innerWidth}x${innerHeight}`);
      }
    }
  }
  return out;
}

const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox', '--use-gl=swiftshader'] });

let failures = 0;
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  // exercise the fullest HUD: everything unlocked + experimental on, set 5
  // shown (double-digit level numbers), a multi-stop level loaded
  await page.evaluate(() => localStorage.setItem('gravityloop-save-v2',
    JSON.stringify({ unlocked: 50, stars: {}, experimental: true })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.GL.load(49));
  await page.waitForTimeout(500);
  // open the level-select popover so its buttons are laid out and checked too
  await page.click('#level-label');
  await page.waitForTimeout(200);

  const issues = await page.evaluate(collectIssues, SELECTORS);
  if (pageErrors.length) issues.push(...pageErrors.map(m => `page error: ${m}`));
  if (issues.length) {
    failures++;
    console.error(`✗ ${vp.name} (${vp.width}x${vp.height})`);
    for (const i of issues) console.error(`    ${i}`);
  } else {
    console.log(`✓ ${vp.name} (${vp.width}x${vp.height}) — all HUD elements inside the viewport`);
  }
  await page.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`\n${failures} viewport(s) with layout overflow — failing.`);
  process.exit(1);
}
console.log('\nAll viewports OK.');
