"""show.py [--full] <key>... : the essentials of each run's garments, for grading (one line a garment;
--full adds what the app read: cut, print, photo map, checks). Reads runs/<key>.json, one outfit each as
runner.js keeps it (VAL.export with pics: false)."""
import json, sys, os
D = os.path.dirname(os.path.abspath(__file__))
SFX = ("_" + os.environ["VAL_PHASE"]) if os.environ.get("VAL_PHASE") else ""
full = "--full" in sys.argv
for k in [a for a in sys.argv[1:] if not a.startswith("--")]:
    r = json.load(open(os.path.join(D, "runs" + SFX, k + ".json")))
    print(k, "" if r.get("settled") else "(not settled)", r.get("errors") or "")
    for i in r["items"]:
        if i.get("error"):
            print(f'   {i["handle"]:24} {i["cat"]:9} ERROR {"replaced by another garment of the same kind (grade na)" if i["error"] == "not added" else i["error"]}'); continue
        ph = i.get("photo") or {}
        print(f'   {i["handle"]:24} {i["cat"]:9} drawn as {i.get("kind")}/{i.get("style")} | {i.get("name")}')
        if full: print(f'      cut={i.get("cut")} print={i.get("print")} allOver={i.get("allOver")} stripes={i.get("stripes")} back={i.get("backPrint")} map={i.get("photoMap")} look={i.get("look")} checks={i.get("checks")} photo={ph.get("style")} sl={ph.get("sleeve") and round(ph["sleeve"],2)}/{ph.get("sleeveDown") and round(ph["sleeveDown"],2)}')
