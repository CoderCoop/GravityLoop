// Player-visible changes must ship with release notes.
//
// The in-game "What's new" panel sat two releases behind reality because
// nothing enforced a bump. This does: if a pull request touches anything the
// player can see, the top entry of src/changelog.js must have a different
// version than it does on the base branch.
//
//   node tools/changelog-check.mjs [baseRef]     # default origin/main
import { execFileSync } from 'node:child_process';

const base = process.argv[2] || process.env.CHANGELOG_BASE || 'origin/main';

// Files whose contents the player experiences directly. Tools, specs, CI and
// docs are deliberately excluded — refactoring the solver is not a release.
const VISIBLE = [
  'src/main.js', 'src/physics.js', 'src/levels.js', 'src/textures.js',
  'src/audio.js', 'index.html', 'styles.css', 'manifest.webmanifest',
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// null when that ref has no changelog at all (e.g. before it existed).
function versionAt(ref) {
  let src;
  try {
    src = git('show', `${ref}:src/changelog.js`);
  } catch {
    return null;
  }
  const m = src.match(/v:\s*'([^']+)'/);
  return m ? m[1] : null;
}

let changed;
try {
  changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
} catch {
  console.log(`changelog check skipped: cannot diff against ${base}`);
  process.exit(0);
}

const touched = changed.filter(f => VISIBLE.includes(f));
if (!touched.length) {
  console.log('no player-visible files changed — no release notes needed');
  process.exit(0);
}

const before = versionAt(base);
const after = versionAt('HEAD');

if (after === null) {
  console.error('✗ src/changelog.js is missing or has no version entry — the in-game "What\'s new" panel reads it');
  process.exit(1);
}
if (before === null) {
  console.log(`changelog version: (absent on ${base}) -> ${after} (HEAD)`);
  console.log('✓ release notes present for these changes');
  process.exit(0);
}

console.log(`player-visible changes: ${touched.join(', ')}`);
console.log(`changelog version: ${before} (${base}) -> ${after} (HEAD)`);

// semantic versions, so the ordering is machine-checkable and MAJOR/MINOR/
// PATCH carry the meaning described at the top of src/changelog.js
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
if (!SEMVER.test(after)) {
  console.error(`\n✗ '${after}' is not a semantic version. Use MAJOR.MINOR.PATCH (see https://semver.org):
  MAJOR for changes that invalidate what a player knew, MINOR for new
  capability or content, PATCH for fixes and polish.`);
  process.exit(1);
}
const rank = v => v.match(SEMVER).slice(1).map(Number);
if (SEMVER.test(before)) {
  const [a1, a2, a3] = rank(before), [b1, b2, b3] = rank(after);
  if (b1 * 1e6 + b2 * 1e3 + b3 <= a1 * 1e6 + a2 * 1e3 + a3) {
    console.error(`\n✗ ${after} does not come after ${before} — the version must increase.`);
    process.exit(1);
  }
}

if (before === after) {
  console.error(`
✗ These changes are visible to players but the changelog was not bumped.

  Add a new entry at the top of src/changelog.js describing what changed
  from the player's point of view, with a new version number. The in-game
  "What's new" panel reads it, and the NEW badge keys off the version.

  If a change genuinely is not player-visible, it should not be touching
  ${touched.join(', ')}.`);
  process.exit(1);
}

const entries = git('show', 'HEAD:src/changelog.js').match(/v:\s*'([^']+)'/g) || [];
if (entries.length < 2) {
  console.error('✗ changelog appears to have lost its history');
  process.exit(1);
}
console.log('✓ release notes present for these changes');
