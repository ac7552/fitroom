"""Draws test/fixtures/files/photos/striped-shirt-front.jpg: a made-up shop photo of a short-sleeve button-up
laid flat, with faint vertical stripes (pale blue on white, as on a pinstripe or a "placid" stripe shirt), a
collar, a placket with buttons, a chest pocket, two soft folds and a little lighting falloff. For the print
tests and the headless renders (script/headless/striped_shirt.mjs).

    python3 script/headless/make_striped_shirt.py
"""

import pathlib
import random

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "test/fixtures/files/photos/striped-shirt-front.jpg"

W = H = 1000
BACKDROP = (244, 244, 242)
WHITE = (238, 240, 243)
BLUE = (196, 211, 231)
PERIOD, BAND = 22, 12   # px: one stripe repeat, and the blue part of it


def stripe(x):
    return BLUE if (x - 300) % PERIOD < BAND else WHITE


def main():
    random.seed(7)
    image = Image.new("RGB", (W, H), BACKDROP)
    pixels = image.load()
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    # Body (shoulders at y 210, hem at 900), short sleeves out to the sides, a collar standing at the top.
    draw.polygon([(300, 225), (420, 205), (580, 205), (700, 225), (700, 900), (300, 900)], fill=255)
    draw.polygon([(300, 225), (170, 300), (210, 470), (305, 430)], fill=255)
    draw.polygon([(700, 225), (830, 300), (790, 470), (695, 430)], fill=255)
    m = mask.load()
    for y in range(H):
        for x in range(W):
            if not m[x, y]:
                continue
            # Sleeves: their stripes run along the arm, so tilted with it; good enough drawn straight here.
            c = stripe(x)
            # Light falling off toward the sides and the hem; two soft folds down the front.
            shade = 1 - 0.05 * abs(x - 500) / 200 - 0.03 * max(0, y - 500) / 400
            for fx, depth in ((395, 0.07), (612, 0.05)):
                shade -= depth * max(0, 1 - abs(x - fx) / 18) * (0.6 + 0.4 * (y - 200) / 700)
            pixels[x, y] = tuple(max(0, min(255, round(v * shade + random.gauss(0, 1.5)))) for v in c)
    d = ImageDraw.Draw(image)
    # The placket: a 26 px strip down the middle, its stripes a little off the body's, edged by a seam line.
    for y in range(240, 900):
        for x in range(487, 513):
            pixels[x, y] = BLUE if (x - 487) % PERIOD < BAND else WHITE
    d.line([(487, 240), (487, 900)], fill=(205, 208, 214), width=1)
    d.line([(513, 240), (513, 900)], fill=(205, 208, 214), width=1)
    for y in range(275, 880, 88):
        d.ellipse([(493, y - 6), (507, y + 6)], fill=(250, 250, 248), outline=(180, 182, 186))
    # The chest pocket (the wearer's left, the photo's right): stripes half a repeat off, a stitched edge.
    for y in range(330, 440):
        for x in range(560, 650):
            pixels[x, y] = BLUE if (x - 300 + PERIOD // 2) % PERIOD < BAND else WHITE
    d.rectangle([(560, 330), (650, 440)], outline=(200, 204, 212), width=2)
    # The collar: two points lying down over the shoulders' middle, white with a shadow under it.
    d.polygon([(420, 205), (500, 205), (500, 250), (455, 285)], fill=(246, 247, 249), outline=(200, 203, 208))
    d.polygon([(580, 205), (500, 205), (500, 250), (545, 285)], fill=(246, 247, 249), outline=(200, 203, 208))
    d.polygon([(430, 190), (570, 190), (580, 205), (420, 205)], fill=(232, 234, 238))
    image = image.filter(ImageFilter.GaussianBlur(0.6))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, quality=88)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
