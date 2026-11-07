#!/bin/bash
# Gathers the review zips export.js saved (fitroom_review_*.zip, in the browser's downloads folder) into one
# folder of contact sheets and run records, each zip once, and builds a sample's run lists from its sample.json.
#
#   script/validation/collect.sh [downloads dir] [out dir]
#     defaults: ~/Downloads  and  tmp/kith/review
#
# Afterwards: grade the sheets in <out>/raw into a grades.csv (see kith_20261107/README.md), then
#   python3 script/validation/kith_20261107/tally.py <out>/grades.csv
set -e
DOWNLOADS=${1:-$HOME/Downloads}
OUT=${2:-tmp/kith/review}
mkdir -p "$OUT/raw" "$OUT/seen"
cd "$DOWNLOADS"
for f in fitroom_review_*.zip .*.com.anthropic.claudefordesktop.*; do
  [ -f "$f" ] || continue
  [ -f "$OUT/seen/$f" ] && continue
  head -c 4 "$f" | od -An -tx1 | grep -q "50 4b 03 04" || continue   # a zip
  unzip -l "$f" 2>/dev/null | grep -q "\.json" || continue
  unzip -l "$f" | grep -q manifest.json && continue                   # a photo zip, not a review
  unzip -oq "$f" -d "$OUT/raw" && touch "$OUT/seen/$f"
done
echo "$(ls "$OUT/raw" | grep -c '\.jpg$') sheets in $OUT/raw"
