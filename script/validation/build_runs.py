"""Builds the validation runs (outfits) from a sample (sample.js's output):

    python3 script/validation/build_runs.py script/validation/sample.json > script/validation/runs.json

Each item is worn in a few outfits, so it's seen alone where it shows and with the others where they meet:
  men:   a top with bottoms (100), and outerwear over another top and bottoms (100);
  women: the same two (100 + 100), a dress on its own (100), and outerwear over another dress (100).
Tops and bottoms are each in two outfits, outerwear in one (men) or two (women), dresses in two. The pairings
step through the lists at fixed offsets, so a top isn't always with the same bottoms. Each run has a phase,
the order they're run in: every garment's first outfit (1), then outerwear over a top and bottoms (2), then
outerwear over a dress (3), so a stopped run still has seen each garment once.
"""
import json
import sys

sample = json.load(open(sys.argv[1]))
runs = []


def items(name):
    return [dict(handle=p["handle"], cat=name.split("_")[1]) for p in sample[name]["items"]]


def at(lst, k):
    return lst[k % len(lst)] if lst else None


for sex, body in (("men", "men"), ("women", "women")):
    tops, outer, bottoms = items(f"{sex}_top"), items(f"{sex}_outerwear"), items(f"{sex}_bottom")
    for k in range(len(tops)):
        runs.append(dict(key=f"{sex[0]}-tb-{k:03}", body=body, items=[at(tops, k), at(bottoms, k)]))
    for k in range(len(outer)):
        runs.append(dict(key=f"{sex[0]}-otb-{k:03}", body=body, items=[at(tops, k + 37), at(bottoms, k + 59), at(outer, k)]))
    if f"{sex}_dress" in sample:
        dresses = items(f"{sex}_dress")
        for k in range(len(dresses)):
            runs.append(dict(key=f"{sex[0]}-d-{k:03}", body=body, items=[at(dresses, k)]))
        for k in range(len(outer)):
            runs.append(dict(key=f"{sex[0]}-od-{k:03}", body=body, items=[at(dresses, k + 41), at(outer, k + 23)]))

PHASE = {"tb": 1, "d": 1, "otb": 2, "od": 3}
for r in runs:
    r["phase"] = PHASE[r["key"].split("-")[1]]
# Within the first phase, the men's outfits, the dresses, then the women's tops and bottoms.
ORDER = ["m-tb", "w-d", "w-tb", "m-otb", "w-otb", "w-od"]
runs.sort(key=lambda r: (r["phase"], ORDER.index(r["key"].rsplit("-", 1)[0])))
json.dump(runs, sys.stdout, indent=0)
print(file=sys.stderr, end=f"{len(runs)} runs\n")
