# GravityLoop — project conventions

These are standing instructions for AI-assisted development on this repo.
This file follows the [AGENTS.md](https://agents.md) convention so every
coding agent reads the same rules; `CLAUDE.md` is a symlink to it.

To rebuild this game from nothing, see [`PROMPT.md`](PROMPT.md) — the
reconstitution spec that describes what to build and how to verify it.

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

## Every player-visible change ships release notes

If a change touches `src/main.js`, `src/physics.js`, `src/levels.js`,
`src/textures.js`, `src/audio.js`, `index.html`, `styles.css` or the
manifest, add a new entry at the top of `src/changelog.js` **with a bumped
version** describing the change from the player's point of view.

Versions are [semantic](https://semver.org) — `MAJOR.MINOR.PATCH`, judged from
the player's side, not the code's:

| Bump | When |
| --- | --- |
| MAJOR | the game changes so that what a player knew no longer holds — reworked controls, a rebuilt campaign, physics to relearn |
| MINOR | new capability or content that leaves existing skills intact |
| PATCH | fixes and polish; nothing new to learn |

The format and a strictly increasing version are both CI-enforced. The in-game
*What's new* panel renders it and the NEW badge keys off the version, and
`VERSION` is derived from the top entry — so the changelog entry *is* the
version bump; there is nowhere else to update.

`node tools/changelog-check.mjs` enforces this and runs as a CI gate on every
pull request. Tools, specs, workflows and docs are exempt: refactoring the
solver is not a release.

## Verify before every commit

- `node tools/solve.js --fast` — every level and every leg must stay winnable
  (this is also a CI gate).
- `node tools/invariants.mjs` — physics outcomes must be supported by the
  geometry, prediction must be deterministic (CI gate).
- `CHROMIUM_PATH=... node tools/contract-test.mjs` — the drawn scene must
  agree with the simulation: silhouettes, docking rings, surface placement,
  preview legibility (CI gate).
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

**A fresh branch per change**, named for what it does: `claude/<topic>`, e.g.
`claude/beacon-alignment`, `claude/dust-asteroids`. Push it, open a PR to
`main`, wait for ALL CI checks to pass, then merge. GitHub Pages redeploys
from `main` automatically (the live game is
https://codercoop.github.io/GravityLoop/).

Do **not** reuse one long-lived branch for successive PRs. Tooling that links
a conversation to a pull request keys off the branch name, so a reused branch
keeps pointing at the first PR ever opened from it — every later PR then shows
the wrong link. It also makes each PR's history harder to read, since the
branch carries commits from changes that already merged.

**One topic per pull request.** When several unrelated changes are in flight,
land them as separate PRs rather than accumulating a batch — a PR that mixes
a physics fix, a visual restyle and a new CI gate is hard to review and
impossible to revert cleanly. Split by what a reader would call "the change":
each PR gets its own changelog entry, and its title should describe one thing.
If a request naturally spans several topics, ship them in dependency order
rather than together.

## Long-running work: keep the user posted

For anything that runs more than a few minutes (level generation, CI, big
test runs): tell the user what is running, how far along it is, and the
expected completion time — and post a progress update roughly every
15 minutes (a monitor heartbeat on the job's log works well). Report
failures, container restarts, and completions immediately, each with a
revised ETA for the overall task. Report
times and ETAs in US Eastern time (the user's timezone).

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
