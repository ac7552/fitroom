#!/bin/sh
# Takes the pictures probe.js posted (snapRuns, showCrops with window.__snap) out of the dev log into
# tmp/kith/snaps/raw (development only).
cd "$(dirname "$0")/../.." && python3 script/validation/collect_log.py snaps >/dev/null && ls -t tmp/kith/snaps/raw | head -${1:-3}
