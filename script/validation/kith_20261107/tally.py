"""Sums the grades of a Kith sample by category and by cause, and projects the fail share as fixes land.

    python3 script/validation/kith_20261107/tally.py [grades.csv]

grades.csv has one row per run: key (group:handle), grade (ok / minor / fail), tags (cause tags joined by ;),
note. The tags are the vocabulary in README.md. The projection counts a fail as fixed only when every tag on it
is covered by a step, then keeps a fifth of those as still failing (a fix rarely lands clean).
"""
import collections
import csv
import sys
from pathlib import Path

HERE = Path(__file__).parent
path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "grades.csv"
rows = list(csv.DictReader(open(path)))

OUTER = ("m_jacket", "m_coat", "w_outer")
BOTTOM = ("m_pants", "m_denim", "m_shorts", "w_pants", "w_skirt", "w_shorts")


def category(key):
    group = key.split(":")[0]
    if group.startswith(("fm_", "fw_")) or key.startswith(("user:bs", "user:fe")):
        return "footwear"
    if group in OUTER or key.startswith(("user:sto", "user:avf")):
        return "outerwear"
    if group == "m_denim" and ("khma01" in key or "j21" in key):   # denim jackets filed under denim
        return "outerwear"
    if group in BOTTOM:
        return "bottoms"
    if group == "w_dress":
        return "dresses"
    return "tops"


# The fix steps of docs/plan-2026-11-accuracy.md, each with the tags it addresses, in the order they land.
STEPS = [
    ("1 pick the right photo", {"WORN", "CLOSEUP", "S-wrongphoto", "B-backphoto", "BACKWARP", "MULTI", "IMPORT"}),
    ("2 read the parts", {"COLLAR", "NECK", "HOOD", "S-collar", "P-hood", "P-stretch", "P-lost", "CORD", "SLEEVE"}),
    ("3 length and type from the photo", {"LEN", "KIND", "B-len", "B-shape"}),
    ("4 lay the photo without tearing", {"SWIRL", "SHADE", "STRIPE", "KNIT", "HANGER", "HEM", "SEAM"}),
    ("5 footwear", {"S-front", "S-back", "S-streak", "S-washout", "S-open", "S-nofoot", "S-tear", "S-hole",
                    "S-heel", "S-toe", "S-blob", "S-tilt", "S-tabi", "S-parts"}),
    ("6 colour by part", {"COLOR"}),
    ("7-8 finishing and materials", {"FUR", "SHEER", "TAILOR"}),
]


def tags_of(row):
    return {t for t in row["tags"].split(";") if t}


def main():
    by = collections.defaultdict(list)
    for r in rows:
        by[category(r["key"])].append(r)
    print(f"{'category':<10} {'n':>4} {'ok':>4} {'minor':>6} {'fail':>5}  fail%")
    total = collections.Counter()
    for c in ["outerwear", "tops", "dresses", "footwear", "bottoms"]:
        xs = by[c]
        g = collections.Counter(x["grade"] for x in xs)
        total.update(g)
        print(f"{c:<10} {len(xs):>4} {g['ok']:>4} {g['minor']:>6} {g['fail']:>5}  {100 * g['fail'] / len(xs):.0f}%")
    n = sum(total.values())
    print(f"{'all':<10} {n:>4} {total['ok']:>4} {total['minor']:>6} {total['fail']:>5}  {100 * total['fail'] / n:.0f}%")

    print("\ncauses (pieces tagged / of them fails):")
    tags = collections.Counter(t for r in rows for t in tags_of(r))
    fails = collections.Counter(t for r in rows if r["grade"] == "fail" for t in tags_of(r))
    for t, k in tags.most_common():
        print(f"  {t:<14} {k:>4} / {fails[t]:>3}")

    print("\nprojected fail share as the plan's steps land:")
    failing = [r for r in rows if r["grade"] == "fail"]
    covered = set()
    for name, step in STEPS:
        covered |= step
        left = [r for r in failing if not tags_of(r) <= covered]
        resolved = len(failing) - len(left)
        projected = len(left) + 0.2 * resolved
        print(f"  after {name:<36} {100 * projected / n:.0f}%  ({resolved} fails fully addressed)")


if __name__ == "__main__":
    main()
