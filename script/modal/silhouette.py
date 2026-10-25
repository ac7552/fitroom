"""The checks and guide pictures for the studio look (studio_look.py), kept free of the GPU so they can be
tested anywhere: python3 -m unittest script/modal/test_silhouette.py

A repainted photo is only used if its outline matches the render's: the image model may light and texture
the clothes, but not move a hem, widen a leg or add a sleeve. The outline of the render comes from the
browser (a white-on-black mask drawn from the same camera); the repaint's is found by a cut-out model.
"""

import io

import numpy as np
from PIL import Image

LEAST_IOU = 0.85   # how much of the two outlines must overlap
MAX_SIDE = 1536    # pictures larger than this are shrunk
MIN_SIDE = 256


def load(data, mode="RGB"):
    """A picture from PNG/JPEG bytes, shrunk to at most MAX_SIDE across. Raises ValueError if it isn't one."""
    try:
        picture = Image.open(io.BytesIO(data))
        picture.load()
    except Exception as error:  # noqa: BLE001 - any decoding problem is the caller's bad input
        raise ValueError("not a picture") from error
    if min(picture.size) < MIN_SIDE:
        raise ValueError("picture too small")
    picture = picture.convert(mode)
    k = MAX_SIDE / max(picture.size)
    if k < 1:
        picture = picture.resize((round(picture.width * k), round(picture.height * k)), Image.LANCZOS)
    return picture


def sdxl_size(width, height, pixels=1024 * 1024):
    """About a million pixels in the same shape, each side a multiple of 64, as SDXL likes."""
    k = (pixels / (width * height)) ** 0.5
    return max(64, round(width * k / 64) * 64), max(64, round(height * k / 64) * 64)


def mask_of(picture, size=None, threshold=0.5):
    """A boolean outline from a mask picture (white is the figure), optionally resized to `size`."""
    grey = picture.convert("L")
    if size and grey.size != size:
        grey = grey.resize(size, Image.BILINEAR)
    return np.asarray(grey, dtype=np.float32) / 255.0 >= threshold


def iou(a, b):
    """Intersection over union of two boolean outlines of the same size (1.0 when both are empty)."""
    if a.shape != b.shape:
        raise ValueError("outlines differ in size")
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(a, b).sum() / union)


def edges(picture, low=30, high=90):
    """Seams, hems and folds as white lines on black, for the edge guide (Canny when OpenCV is there)."""
    grey = np.asarray(picture.convert("L"))
    try:
        import cv2

        lines = cv2.Canny(grey, low, high)
    except ImportError:
        g = grey.astype(np.float32)
        gx = np.zeros_like(g)
        gy = np.zeros_like(g)
        gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
        gy[1:-1, :] = g[2:, :] - g[:-2, :]
        lines = np.where(np.hypot(gx, gy) > high, 255, 0).astype(np.uint8)
    return Image.fromarray(lines).convert("RGB")


def guide_edges(photo, mask):
    """The edge guide: seams, hems and folds inside the figure, and the figure's own outline (which can be
    faint where dark cloth meets a dark backdrop)."""
    inside = np.asarray(only_figure(edges(photo), mask).convert("L"))
    outline = np.asarray(edges(mask.convert("RGB").resize(photo.size)).convert("L"))
    return Image.fromarray(np.maximum(inside, outline)).convert("RGB")


def only_figure(picture, mask):
    """The guide picture with everything outside the figure's outline black (the floor's shadow, the
    backdrop's gradient), so the model is held to the clothes and not to the room."""
    keep = mask_of(mask, picture.size)
    pixels = np.asarray(picture.convert("RGB")).copy()
    pixels[~keep] = 0
    return Image.fromarray(pixels)


def stretch_depth(depth, mask):
    """The depth guide stretched over the figure's own range, nearest white and farthest black, with
    everything outside the outline black. The page's depth is only a narrow band of grey (the figure is
    a few tens of centimetres deep, seen from metres away), which would give the model almost no relief."""
    keep = mask_of(mask, depth.size)
    grey = np.asarray(depth.convert("L"), dtype=np.float32)
    out = np.zeros_like(grey)
    if keep.any():
        low, high = np.percentile(grey[keep], [1, 99])
        if high - low >= 1:
            out = np.clip((grey - low) / (high - low), 0, 1) * 235 + 20
        else:
            out[:] = 255
        out[~keep] = 0
    return Image.fromarray(out.astype(np.uint8)).convert("RGB")


def png(picture):
    out = io.BytesIO()
    picture.save(out, format="PNG")
    return out.getvalue()


def prompt_for(outfit):
    """The words for the model: a lookbook shot of the mannequin in what's worn (the outfit as described
    by the page, trimmed to plain words)."""
    words = "".join(c for c in str(outfit or "") if c.isalnum() or c in " ,-'&/").strip()[:300]
    wearing = f", wearing {words}" if words else ""
    return (
        "professional studio fashion photograph of a matte white faceless mannequin"
        f"{wearing}, seamless studio backdrop, soft large key light, gentle shadows, realistic fabric texture, "
        "natural folds and creases, crisp seams, sharp focus, high-end lookbook product photo"
    )


NEGATIVE = (
    "cartoon, 3d render, cgi, video game, plastic cloth, blurry, deformed, extra limbs, extra sleeves, "
    "text, watermark, logo, human face, real person, skin, hair, cluttered background"
)
