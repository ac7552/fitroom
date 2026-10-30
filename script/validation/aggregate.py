"""aggregate.py [--json] : per-group results from grades.json and runs.json.

Each garment is counted once, at its worst grade over the outfits it was worn in (a dress fine on its own but
torn under a coat fails). Groups are the sample's: men/women x top/outerwear/bottom, women's dresses."""
import json, os, sys, collections
D = os.path.dirname(os.path.abspath(__file__))
RUNS = json.load(open(os.path.join(D, "runs.json")))
G = json.load(open(os.path.join(D, os.environ.get("VAL_GRADES", "grades.json"))))
RANK = {"ok": 0, "minor": 1, "fail": 2}

group_of = {}
for r in RUNS:
    for i in r["items"]:
        group_of[i["handle"]] = f'{r["body"]}_{i["cat"]}'

worst = {}   # handle -> (verdict, cause, note, run)
seen_in = collections.defaultdict(list)
for r in RUNS:
    k = r["key"]
    if k not in G: continue
    for i in r["items"]:
        h = i["handle"]
        g = G[k].get(h)
        if not g or g["v"] == "na": continue
        seen_in[h].append(k)
        if h not in worst or RANK[g["v"]] > RANK[worst[h][0]]:
            worst[h] = (g["v"], g["cause"], g["note"], k)

groups = collections.defaultdict(lambda: collections.Counter())
causes = collections.defaultdict(lambda: collections.Counter())
for h, (v, c, note, k) in worst.items():
    grp = group_of[h]
    groups[grp][v] += 1
    if v != "ok": causes[grp][f"{v}:{c}"] += 1

order = ["men_top", "men_outerwear", "men_bottom", "women_top", "women_outerwear", "women_dress", "women_bottom"]
tot = collections.Counter(); totc = collections.Counter()
out = {}
for grp in order:
    n = sum(groups[grp].values())
    tot.update(groups[grp]); totc.update(causes[grp])
    out[grp] = {"graded": n, **groups[grp], "causes": dict(causes[grp].most_common())}
n = sum(tot.values())
out["all"] = {"graded": n, **tot, "causes": dict(totc.most_common())}
if "--json" in sys.argv:
    print(json.dumps(out, indent=1))
else:
    for grp, x in out.items():
        g = x["graded"] or 1
        print(f'{grp:16} n={x["graded"]:3}  ok {x.get("ok",0)/g:5.0%}  minor {x.get("minor",0)/g:5.0%}  fail {x.get("fail",0)/g:5.0%}   {x["causes"]}')
    print("outfits graded:", len(G))
