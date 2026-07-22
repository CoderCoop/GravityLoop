#!/usr/bin/env bash
# Parallel level generation: fans the 50 independent slot searches across
# CPU cores, then assembles src/levels.js. Output is byte-identical to the
# serial `node tools/generate.js` — each slot's search depends only on its
# own seeds. Finished slots are cached as JSON in WORKDIR, so an interrupted
# run resumes where it left off (within the same container).
#
#   tools/genpar.sh [JOBS] [WORKDIR]
set -u
JOBS=${1:-$(nproc)}
DIR=${2:-/tmp/genslots}
mkdir -p "$DIR"
cd "$(dirname "$0")/.."
export DIR

# slowest sets first (belt, outer, alien) so cores stay busy at the tail
for s in 3 2 4 0 1; do
  for slot in 0 1 2 3 4 5 6 7 8 9; do
    echo "$s $slot"
  done
done | xargs -P "$JOBS" -n 2 sh -c '
  out="$DIR/s$0-$1.json"
  [ -s "$out" ] && exit 0
  node tools/generate.js --emit-slot=$0:$1 --out="$out" || echo "FAILED slot $0:$1"
'

missing=0
for s in 0 1 2 3 4; do for slot in 0 1 2 3 4 5 6 7 8 9; do
  [ -s "$DIR/s$s-$slot.json" ] || { echo "MISSING s$s-$slot"; missing=1; }
done; done
if [ "$missing" = 0 ]; then
  node tools/generate.js --assemble="$DIR"
else
  echo "assembly skipped: slots missing" >&2
  exit 1
fi
