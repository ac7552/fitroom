"""Builds the run lists for a per-collection Kith sample (sample.js's output with one group per collection):

    python3 script/validation/kith_20261107/build_runs.py script/validation/kith_20261107/sample.json

writes runs_apparel.json and runs_shoes.json beside it. Each product is worn alone on the body its collection
is for (m_ men, w_ women; fm_ / fw_ for footwear), so every piece is seen by itself and the grade is its own.
The 'user' group (links the person sent) runs first (phase 0).
"""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
groups = json.load(open(path))["groups"]
CAT = {"tee": "top", "hoodie": "top", "sweat": "top", "shirt": "top", "knit": "top", "jacket": "outerwear",
       "coat": "outerwear", "outer": "outerwear", "pants": "bottom", "denim": "bottom", "shorts": "bottom",
       "skirt": "bottom", "dress": "dress"}
apparel, shoes = [], []
for group, picked in groups.items():
    for item in picked["items"]:
        handle = item["handle"]
        if group == "user":
            foot = handle.startswith(("bs", "fe", "di"))
            run = {"key": f"user:{handle}", "body": "women" if foot else "men", "group": "user",
                   "items": [{"handle": handle, "cat": "shoes" if foot else "outerwear" if handle.startswith("sto") else "top"}], "phase": 0}
            (shoes if foot else apparel).append(run)
            continue
        sex, kind = group.split("_", 1)
        if sex in ("fm", "fw"):
            shoes.append({"key": f"{group}:{handle}", "body": "men" if sex == "fm" else "women", "group": group,
                          "items": [{"handle": handle, "cat": "shoes"}], "phase": 1})
        else:
            apparel.append({"key": f"{group}:{handle}", "body": "men" if sex == "m" else "women", "group": group,
                            "items": [{"handle": handle, "cat": CAT[kind]}], "phase": 1})
# A shoe in two collections (men's and women's sneakers, say) runs once.
seen = set()
shoes = [r for r in shoes if not (r["items"][0]["handle"] in seen or seen.add(r["items"][0]["handle"]))]
for runs, name in ((apparel, "runs_apparel.json"), (shoes, "runs_shoes.json")):
    runs.sort(key=lambda r: r["phase"])
    json.dump(runs, open(path.parent / name, "w"))
    print(name, len(runs))
