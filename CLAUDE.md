# GravityLoop — project conventions

These are standing instructions for AI-assisted development on this repo.

## UI changes: mockup first, code second

For any feature or enhancement that changes what the player sees (HUD, menus,
overlays, level visuals, effects, colors, layout):

1. **Do not implement immediately.**
2. First produce **2–3 labeled mockup images showing distinct options**.
   Prefer real renders: temporarily modify a working copy, serve it, and
   screenshot with headless Chromium (`playwright-core` is a devDependency;
   launch with `executablePath: '/opt/pw-browsers/chromium'` in this
   environment, or the system Chrome in CI). For layout/concept options,
   a quick static HTML/canvas mockup rendered to PNG is fine.
3. **Send the images to the user and ask them to choose** before writing the
   real implementation (offer the options plus "none of these / iterate").
4. Implement only the selected option, then verify per below.

Exempt: purely mechanical fixes with one obvious rendering (typo, off-by-one
overflow fix, color token already specified by the user). When in doubt,
mock it up.

## Verify before every commit

- `node tools/solve.js --fast` — every level and every leg must stay winnable
  (this is also a CI gate).
- `CHROMIUM_PATH=/opt/pw-browsers/chromium node tools/ui-test.mjs` — no HUD
  element may render outside the viewport at phone/tablet/desktop sizes
  (also a CI gate).
- Headless smoke: load the game, press Play, drag-launch on level 1 — zero
  console or page errors. `window.GL` (load/launch/status) exists for
  scripted playthroughs.

## Levels are generated — never hand-edit

`src/levels.js` is written by `node tools/generate.js` (deterministic,
seeded; sets 4–5 can take many minutes). To change level design, edit the
samplers/constraints in `tools/generate.js` and regenerate. Difficulty is
enforced by per-leg solver bands; keep the `MIN_WINS` floor so the CI
solver check always passes.

## Shipping flow

Work on branch `claude/spaceship-gravity-well-game-kesebo`, push, open a PR
to `main`, wait for BOTH CI checks to pass, then merge. GitHub Pages
redeploys from `main` automatically (the live game is
https://codercoop.github.io/GravityLoop/).

## Environment gotchas

- Serve the game from the **repo root** (`python3 -m http.server 8123`).
  A server started from any other directory 404s the ES modules and the
  menu never appears — this has burned multiple sessions.
- The page deliberately suppresses native browser pinch zoom; the game has
  its own camera gestures. Don't "fix" that.
- The PWA name must stay exactly "Gravity Loop" (manifest `short_name` and
  `apple-mobile-web-app-title`).
- Time freezes while aiming by design (prediction-line accuracy); cosmetic
  animation uses the separate `vTime` clock.
