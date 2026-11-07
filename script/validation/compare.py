# Before/after sheets, a few runs a page: each run its last sheet before (the previous steps' tmp/kith/<step>/raw,
# else the baseline's tmp/kith/review/raw) over its new one.
#
#     python3 script/validation/compare.py <tag> [per page] [width] [key prefixes,...] [out dir name]
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw
tag = sys.argv[1]; per = int(sys.argv[2]) if len(sys.argv) > 2 else 3; width = int(sys.argv[3]) if len(sys.argv) > 3 else 1400
new = Path(f"tmp/kith/{tag}/raw")
steps = sorted((p for p in Path("tmp/kith").glob("step*/raw") if p.parent.name < tag), reverse=True)
olds = [*steps, Path("tmp/kith/review/raw")]
before = lambda n: next((d / f"{n}.jpg" for d in olds if (d / f"{n}.jpg").exists()), olds[-1] / f"{n}.jpg")
out = Path(f"tmp/kith/{tag}/" + (sys.argv[5] if len(sys.argv) > 5 else "compare")); out.mkdir(exist_ok=True)
names = sorted(p.stem for p in new.glob("*.jpg"))
if len(sys.argv) > 4: names = [n for n in names if any(n.startswith(k) for k in sys.argv[4].split(","))]
pages = []
for k in range(0, len(names), per):
    rows = []
    for n in names[k:k + per]:
        for src, label in ((before(n), "before"), (new / f"{n}.jpg", "after")):
            if not src.exists(): continue
            im = Image.open(src).convert("RGB"); s = width / im.width
            im = im.resize((width, int(im.height * s)))
            d = ImageDraw.Draw(im); d.rectangle([width - 70, 0, width, 22], fill=(255, 230, 0) if label == "after" else (220, 220, 220)); d.text((width - 64, 5), label, fill=(0, 0, 0))
            rows.append(im)
    H = sum(r.height for r in rows)
    page = Image.new("RGB", (width, H), "white"); y = 0
    for r in rows: page.paste(r, (0, y)); y += r.height
    p = out / f"page_{k // per:02d}.jpg"; page.save(p, quality=80); pages.append(str(p))
print("\n".join(pages)); print(names)
