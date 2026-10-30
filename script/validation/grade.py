"""Grades: python3 grade.py <run> <handle>=<verdict>[:cause[:note]] ...
verdict: ok | fail | minor | na (not graded here: replaced by a same-kind garment in this outfit) ; causes: type, sleeves, colour, print, parts, shape, feature, clip, missing"""
import json, sys, os, fcntl
D = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(D, os.environ.get("VAL_GRADES", "grades.json"))
CAUSES = {"type", "sleeves", "colour", "print", "parts", "shape", "feature", "clip", "missing"}
with open(os.path.join(D, ".lock"), "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    g = json.load(open(F)) if os.path.exists(F) else {}
    run = sys.argv[1]
    for spec in sys.argv[2:]:
        h, rest = spec.split("=", 1)
        parts = rest.split(":", 2)
        v = parts[0]
        cause = parts[1] if len(parts) > 1 else None
        assert v in ("ok", "minor", "fail", "na"), f"verdict {v}"
        assert v in ("ok", "na") or cause in CAUSES, f"cause {cause}"
        g.setdefault(run, {})[h] = {"v": v, "cause": cause, "note": parts[2] if len(parts) > 2 else None}
    tmp = F + ".tmp"; json.dump(g, open(tmp, "w"), indent=1); os.replace(tmp, F)
print(run, {h: x["v"] + (":" + x["cause"] if x["cause"] else "") for h, x in g[run].items()})
