"""Whether a word printed down a leg reads as itself: OCR (tesseract) of the pale-on-dark lettering on the
left half of a picture (the wearer's right leg, where Kith's Essentials sweatpant prints ESSENTIALS), turned
to run across, scored by how near the text read is to the word (0 to 1). Torn lettering (each row of it
shifted its own way, as the photo's row-by-row registration laid it) doesn't read; lettering laid as one
piece reads like the shop's photo. Exits 1 when the last picture scores below --min.

    python3 script/headless/lettering_check.py tmp/kith/ess-front.png tmp/shots/ess-t-on.png --min 0.6

On the Essentials sweatpant: the shop photo 0.64, laid by the photo row by row 0.17, laid as one piece
(leg_prints.js) 0.90 (--psm 8; other page modes and scales give 0.17-0.33 against 0.61-0.90).

Render the leg turned to show its side (render.mjs --turn -0.9)."""
import difflib
import subprocess
import sys
import tempfile
import numpy as np
from PIL import Image

def lettering(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(int)
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    pale = (r > 120) & (r - b > 14) & (g > 105)
    pale[: h // 6] = False
    pale[:, w // 2:] = False
    # On the cloth: black within a few pixels on both sides (not the mannequin, nor the backdrop).
    dark = (r + g + b) < 150
    near = max(5, w // 120)
    left = np.zeros_like(dark); right = np.zeros_like(dark)
    for k in range(1, near + 1):
        left[:, k:] |= dark[:, :-k]
        right[:, :-k] |= dark[:, k:]
    raw = pale.copy()
    pale &= left | right
    ys, xs = np.nonzero(pale)
    if len(xs) < 50:
        return None
    # The lettering's column: the densest band of pale pixels across.
    hist = np.bincount(xs, minlength=w)
    band = max(10, w // 40)
    centre = int(np.argmax(np.convolve(hist, np.ones(band), "same")))
    keep = np.abs(xs - centre) < band * 2
    xs, ys = xs[keep], ys[keep]
    y0, y1 = np.percentile(ys, 1), np.percentile(ys, 99)
    # Then every pale pixel in that column (the letters' edges, which the test above trims).
    x0, x1 = max(0, centre - band * 3), min(w, centre + band * 3)
    m = 8
    crop = raw[int(max(0, y0 - m)):int(y1 + m), int(x0):int(x1)]
    cols = np.nonzero(crop.any(axis=0))[0]
    crop = crop[:, max(0, cols.min() - m):cols.max() + m]
    return Image.fromarray(np.where(crop, 0, 255).astype("uint8"))

def read(image):
    best = ""
    for turn in (90, -90):
        im = image.rotate(turn, expand=True)
        scale = max(1, 160 // max(1, im.height))
        im = im.resize((im.width * scale, im.height * scale))
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            im.save(f.name)
            text = subprocess.run(["tesseract", f.name, "-", "--psm", "8", "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ"], capture_output=True, text=True).stdout
        text = "".join(c for c in text.upper() if c.isalpha())
        if score(text) > score(best):
            best = text
    return best

def score(text, word="ESSENTIALS"):
    return difflib.SequenceMatcher(None, text, word).ratio()

args, least = [], None
it = iter(sys.argv[1:])
for a in it:
    if a == "--min":
        least = float(next(it))
    else:
        args.append(a)
last = None
for path in args:
    image = lettering(path)
    text = read(image) if image is not None else ""
    last = score(text)
    print(f"{last:.2f}  read {text!r:16}  {path}")
if least is not None and last is not None and last < least:
    sys.exit(1)
