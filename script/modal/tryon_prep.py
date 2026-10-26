"""The parts of the try-on spike (tryon_spike.py) that need no GPU, so they can be tested anywhere:
python3 -m unittest script/modal/test_tryon_prep.py

- the page's pose keypoints turned into what FASHN's pipeline expects from DWPose,
- letterboxing a picture into Leffa's 768x1024 frame and back,
- the garment mask grown a little so the inpainting has room for seams,
- the contact sheet and its captions.
"""

import io

import numpy as np
from PIL import Image, ImageDraw

# OpenPose BODY_18 order, the one DWPose's `candidate` rows follow (fashn-vton-1.5,
# src/fashn_vton/dwpose/wholebody.py: mmpose_idx -> openpose_idx, neck = the shoulders' midpoint).
OPENPOSE_18 = (
    "nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist",
    "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear",
)


def dwpose_from_openpose(pose):
    """The page's pose -> the dict FASHN's pipeline gets from `DWposeDetector.__call__`
    (src/fashn_vton/dwpose/dwpose.py): `bodies.candidate`, 18 rows of (x, y) as fractions of the picture's
    width and height, -1 where a joint isn't seen; `bodies.subset`, one row of 18 that holds each seen
    joint's own index, -1 otherwise. No `hands` or `faces`, so draw_pose draws the body only, as it does for
    a flat-lay garment (get_dummy_dw_keypoints in src/fashn_vton/utils/keypoints.py).

    pose: {"width": W, "height": H, "keypoints": [[x, y, c], ...]} with 18 points in pixel coordinates of the
    person picture, in OPENPOSE_18 order; c <= 0 means not seen (the egg-head mannequin has no eyes or ears).
    """
    width, height = float(pose["width"]), float(pose["height"])
    if width <= 0 or height <= 0:
        raise ValueError("pose needs the picture's width and height")
    points = list(pose["keypoints"])
    if len(points) != 18:
        raise ValueError("pose needs 18 keypoints in OpenPose order")
    candidate = -np.ones((18, 2), dtype=np.float64)
    subset = -np.ones((1, 18), dtype=np.float64)
    for j, point in enumerate(points):
        x, y = float(point[0]), float(point[1])
        seen = (float(point[2]) if len(point) > 2 else 1.0) > 0
        if seen and 0 <= x <= width and 0 <= y <= height:
            candidate[j] = (x / width, y / height)
            subset[0, j] = j
    return {"bodies": {"candidate": candidate, "subset": subset}}


def letterbox(picture, width, height, fill):
    """`picture` shrunk to fit width x height and centred on a canvas of that size filled with `fill` (a
    colour for pictures, 0 for masks, which must not become 'repaint here' at the edges). Returns the canvas
    and the box the picture landed in, as Leffa's resize_and_center does (leffa_utils/utils.py) but with a
    choice of padding and the box kept so the result can be put back."""
    k = min(width / picture.width, height / picture.height)
    size = (max(1, round(picture.width * k)), max(1, round(picture.height * k)))
    canvas = Image.new(picture.mode, (width, height), fill)
    left, top = (width - size[0]) // 2, (height - size[1]) // 2
    canvas.paste(picture.resize(size, Image.LANCZOS), (left, top))
    return canvas, (left, top, left + size[0], top + size[1])


def unletterbox(picture, box, size):
    """The picture's part inside `box`, back at the original `size`."""
    return picture.crop(box).resize(size, Image.LANCZOS)


def grow(mask, pixels):
    """A mask picture (white is the garment) grown by `pixels` each way: the inpainting needs a little room
    outside the garment for seams and shadow, without letting the shape wander."""
    if pixels <= 0:
        return mask.convert("L")
    array = np.asarray(mask.convert("L")) >= 128
    try:
        import cv2

        kernel = np.ones((2 * pixels + 1, 2 * pixels + 1), np.uint8)
        grown = cv2.dilate(array.astype(np.uint8), kernel) > 0
    except ImportError:
        grown = array.copy()
        for _ in range(pixels):
            padded = np.pad(grown, 1)
            grown = padded[1:-1, 1:-1] | padded[:-2, 1:-1] | padded[2:, 1:-1] | padded[1:-1, :-2] | padded[1:-1, 2:]
    return Image.fromarray(grown.astype(np.uint8) * 255)


def fit(picture, width, height, fill=(21, 23, 27)):
    """A thumbnail for the sheet: fitted inside width x height on a graphite ground."""
    return letterbox(picture.convert("RGB"), width, height, fill)[0]


def contact_sheet(rows, cell=(300, 450), caption=64):
    """One row per name: shop photo | our render | FASHN | Leffa, each AI column captioned with its gates in
    words and its time. rows: [{"name", "shop", "render", "fashn", "leffa", "fashn_words", "leffa_words"}],
    pictures as PIL or None. Returns a PIL picture."""
    columns = ("shop", "render", "fashn", "leffa")
    heads = ("Store photo", "Our render", "FASHN VTON 1.5", "Leffa")
    w, h = cell
    gutter = 12
    width = gutter + len(columns) * (w + gutter)
    height = 40 + len(rows) * (h + caption + gutter)
    sheet = Image.new("RGB", (width, height), (21, 23, 27))
    draw = ImageDraw.Draw(sheet)
    for i, head in enumerate(heads):
        draw.text((gutter + i * (w + gutter), 14), head.upper(), fill=(154, 160, 171))
    for r, row in enumerate(rows):
        y = 40 + r * (h + caption + gutter)
        for i, column in enumerate(columns):
            x = gutter + i * (w + gutter)
            picture = row.get(column)
            if picture is None:
                draw.rectangle((x, y, x + w, y + h), outline=(44, 48, 55))
                draw.text((x + 12, y + 12), "no picture", fill=(154, 160, 171))
            else:
                sheet.paste(fit(picture, w, h), (x, y))
            words = row.get("name", "") if column == "shop" else row.get(f"{column}_words", "")
            for line, text in enumerate(str(words or "").split("\n")[:3]):
                draw.text((x, y + h + 8 + line * 16), text, fill=(233, 235, 239) if line == 0 else (154, 160, 171))
    return sheet


def png_bytes(picture):
    out = io.BytesIO()
    picture.save(out, format="PNG")
    return out.getvalue()
