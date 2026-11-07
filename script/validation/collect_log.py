"""Takes the runs export_log.js posted out of log/development.log: each run's contact sheet (.jpg) and record
(.json) into tmp/kith/<tag>/raw, named <group>__<handle> as collect.sh names them. The last copy of a run wins.

    python3 script/validation/collect_log.py <tag> [log]
"""
import base64
import json
import re
import sys
from pathlib import Path

tag = sys.argv[1]
log = Path(sys.argv[2] if len(sys.argv) > 2 else "log/development.log")
out = Path("tmp/kith") / tag / "raw"
out.mkdir(parents=True, exist_ok=True)
marker = f'"probe_marker" => "FITROOM_RUN {tag}"'
n = 0
with open(log, encoding="utf-8", errors="replace") as f:
    for line in f:
        if marker not in line:
            continue
        key = re.search(r'"key" => "([^"]*)"', line).group(1)
        name = key.replace(":", "__").replace("/", "__")
        record = re.search(r'"record" => "([A-Za-z0-9+/=]+)"', line)
        if record:
            (out / f"{name}.json").write_text(json.dumps(json.loads(base64.b64decode(record.group(1)).decode("utf-8"))))
        sheet = re.search(r'"sheet" => "data:image/jpeg;base64,([A-Za-z0-9+/=]+)"', line)
        if sheet:
            (out / f"{name}.jpg").write_bytes(base64.b64decode(sheet.group(1)))
        n += 1
print(f"{n} runs into {out}")
