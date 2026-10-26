"""The three gates an AI try-on picture must pass before the page shows it (tryon_spike.py), kept free of
the GPU so they run and test anywhere: python3 -m unittest script/modal/test_validate.py

    1. shape     the figure's outline in the result overlaps the render's (IoU), so the model hasn't moved a
                 hem, widened a leg or added a sleeve: the fit stays the measured one.
    2. identity  the garment in the result looks like the shop's garment: DINOv2 embeddings of the two garment
                 crops agree (cosine), and their dominant colours are close (CIEDE2000).
    3. print     the print (a logo, lettering, an all-over pattern) survived: SSIM between the shop photo's
                 print region and the same region of the result, mapped through the two garment boxes.
                 Skipped when the garment has no print.

The models that need a GPU (BiRefNet for the cut-out, DINOv2 for the embedding) are passed in as callables,
so tests inject fakes and the defaults load lazily on the GPU box only. Nothing here writes to disk or logs.

Thresholds are starting points, to be tuned on the contact sheets the spike makes:
    IoU >= 0.85 (as the studio look), DINO cosine >= 0.80, dE2000 <= 12 (a clearly different shade), SSIM >= 0.45.
"""

import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from silhouette import iou, mask_of  # noqa: E402

THRESHOLDS = {"shape": 0.85, "identity": 0.80, "colour": 12.0, "print": 0.45}
PAD = 0.05  # how much the garment's box is padded for the crops

DINO = "facebook/dinov2-small"   # Apache-2.0
CUTOUT = "ZhengPeng7/BiRefNet"   # MIT


# Masks and boxes ----------------------------------------------------------------------------------------

def as_mask(given, size=None):
    """A boolean array from a mask picture (white is the thing), a boolean/uint8 array, or None."""
    if given is None:
        return None
    if isinstance(given, Image.Image):
        return mask_of(given, size)
    array = np.asarray(given)
    if array.dtype != bool:
        array = array.astype(np.float32) >= (0.5 if array.max() <= 1 else 127.5)
    if size and array.shape[::-1] != tuple(size):
        return mask_of(Image.fromarray(array.astype(np.uint8) * 255), size)
    return array


def bbox(mask, pad=PAD):
    """The box round a mask's pixels, padded by `pad` of its size each way and clipped to the picture:
    (x0, y0, x1, y1), or None when the mask is empty."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    dx, dy = round((x1 - x0) * pad), round((y1 - y0) * pad)
    h, w = mask.shape
    return (max(0, x0 - dx), max(0, y0 - dy), min(w, x1 + dx), min(h, y1 + dy))


def crop(picture, box):
    return picture.crop(box) if isinstance(picture, Image.Image) else picture[box[1]:box[3], box[0]:box[2]]


def band_mask(outline, category):
    """A rough garment region when the page gave none: a band of the figure's outline by height, tops from
    the shoulders to the hips, bottoms from the hips to the ankles. Only for the spike's sheets."""
    box = bbox(outline, pad=0)
    if box is None:
        return outline.copy()
    top, bottom = {"tops": (0.17, 0.56), "bottoms": (0.50, 0.96)}.get(category, (0.17, 0.96))
    y0 = box[1] + round((box[3] - box[1]) * top)
    y1 = box[1] + round((box[3] - box[1]) * bottom)
    out = np.zeros_like(outline)
    out[y0:y1] = outline[y0:y1]
    return out


# Colour -------------------------------------------------------------------------------------------------

def rgb_to_lab(rgb):
    """sRGB (0-255, shape (..., 3)) to CIE L*a*b* under D65."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = linear @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    lab = np.empty_like(f)
    lab[..., 0] = 116 * f[..., 1] - 16
    lab[..., 1] = 500 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200 * (f[..., 1] - f[..., 2])
    return lab


def delta_e(lab1, lab2):
    """CIEDE2000 between two L*a*b* colours (Sharma, Wu & Dalal 2005), kL = kC = kH = 1."""
    try:
        from skimage.color import deltaE_ciede2000

        return float(deltaE_ciede2000(np.asarray(lab1, dtype=np.float64), np.asarray(lab2, dtype=np.float64)))
    except ImportError:
        return ciede2000(lab1, lab2)


def ciede2000(lab1, lab2):
    """CIEDE2000 written out, for machines without scikit-image (tested against the paper's pairs)."""
    L1, a1, b1 = (float(v) for v in lab1)
    L2, a2, b2 = (float(v) for v in lab2)
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cbar = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cbar**7 / (Cbar**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)

    def hue(a, b):
        if a == 0 and b == 0:
            return 0.0
        h = math.degrees(math.atan2(b, a))
        return h + 360 if h < 0 else h

    h1p, h2p = hue(a1p, b1), hue(a2p, b2)
    dLp = L2 - L1
    dCp = C2p - C1p
    if C1p * C2p == 0:
        dhp = 0.0
    else:
        dhp = h2p - h1p
        if dhp > 180:
            dhp -= 360
        elif dhp < -180:
            dhp += 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbp = (h1p + h2p + 360) / 2
    else:
        hbp = (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dtheta = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    RC = 2 * math.sqrt(Cbp**7 / (Cbp**7 + 25**7))
    SL = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2)
    SC = 1 + 0.045 * Cbp
    SH = 1 + 0.015 * Cbp * T
    RT = -math.sin(math.radians(2 * dtheta)) * RC
    return math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH))


def dominant_colours(picture, mask, k=3, seed=0):
    """The garment's main colours: k-means (k=3) in L*a*b* over the masked pixels. Returns a list of
    (lab, weight) with the heaviest first; empty when the mask is."""
    pixels = np.asarray(picture.convert("RGB"))[mask]
    if len(pixels) == 0:
        return []
    rng = np.random.default_rng(seed)
    if len(pixels) > 20000:
        pixels = pixels[rng.choice(len(pixels), 20000, replace=False)]
    lab = rgb_to_lab(pixels)
    k = min(k, len(lab))
    centres = lab[rng.choice(len(lab), k, replace=False)]
    for _ in range(20):
        nearest = np.argmin(((lab[:, None, :] - centres[None, :, :]) ** 2).sum(-1), axis=1)
        moved = np.array([lab[nearest == i].mean(0) if (nearest == i).any() else centres[i] for i in range(k)])
        if np.allclose(moved, centres, atol=1e-3):
            break
        centres = moved
    counts = np.bincount(nearest, minlength=k) / len(lab)
    order = np.argsort(-counts)
    return [(centres[i], float(counts[i])) for i in order if counts[i] > 0]


def colour_distance(shop_photo, shop_mask, result, result_mask):
    """How far the result's garment colours are from the shop photo's: each shop colour's distance to the
    nearest result colour, weighted by how much of the garment it covers. Big when a navy comes back black
    or a print's ground changes; small for lighting alone."""
    ours = dominant_colours(shop_photo, shop_mask)
    theirs = dominant_colours(result, result_mask)
    if not ours or not theirs:
        return float("inf")
    return sum(weight * min(delta_e(lab, other) for other, _ in theirs) for lab, weight in ours)


# Likeness -----------------------------------------------------------------------------------------------

def cosine(a, b):
    a, b = np.asarray(a, dtype=np.float64).ravel(), np.asarray(b, dtype=np.float64).ravel()
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / norm) if norm > 0 else 0.0


def embed_default(picture):
    """A DINOv2 (small) embedding of a picture: the CLS token, loaded once, on the GPU when there is one."""
    global _dino
    import torch

    if "_dino" not in globals():
        from transformers import AutoImageProcessor, AutoModel

        device = "cuda" if torch.cuda.is_available() else "cpu"
        _dino = (AutoImageProcessor.from_pretrained(DINO), AutoModel.from_pretrained(DINO).to(device).eval(), device)
    processor, model, device = _dino
    with torch.no_grad():
        inputs = processor(images=picture.convert("RGB"), return_tensors="pt").to(device)
        return model(**inputs).last_hidden_state[0, 0].float().cpu().numpy()


def cutout_default(picture):
    """The figure cut out of a picture with BiRefNet: a greyscale PIL picture, white where the figure is."""
    global _birefnet
    import torch

    if "_birefnet" not in globals():
        from transformers import AutoModelForImageSegmentation

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True).to(device).eval()
        _birefnet = (model.half() if device == "cuda" else model, device)
    model, device = _birefnet
    x = np.asarray(picture.convert("RGB").resize((1024, 1024), Image.BILINEAR), dtype=np.float32) / 255.0
    x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    tensor = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device, torch.float16 if device == "cuda" else torch.float32)
    with torch.no_grad():
        alpha = model(tensor)[-1].sigmoid()[0, 0].float().cpu().numpy()
    return Image.fromarray((alpha * 255).astype("uint8")).resize(picture.size, Image.BILINEAR)


# Print --------------------------------------------------------------------------------------------------

def ssim_map(a, b, window=7):
    """Structural similarity between two greyscale float arrays (0-255) of one size, pixel by pixel, with
    a uniform window as scikit-image's default; the mean of the map is the usual SSIM."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if a.shape != b.shape:
        raise ValueError("pictures differ in size")
    try:
        from skimage.metrics import structural_similarity

        return structural_similarity(a, b, data_range=255.0, win_size=window, full=True)[1]
    except ImportError:
        pass
    pad = window // 2

    def mean(x):
        padded = np.pad(x, pad, mode="reflect")
        return np.lib.stride_tricks.sliding_window_view(padded, (window, window)).mean(axis=(-1, -2))

    mu_a, mu_b = mean(a), mean(b)
    cov_norm = window**2 / (window**2 - 1)
    var_a = cov_norm * (mean(a * a) - mu_a**2)
    var_b = cov_norm * (mean(b * b) - mu_b**2)
    cov = cov_norm * (mean(a * b) - mu_a * mu_b)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))


def grey(picture, size=None):
    g = picture.convert("L")
    return np.asarray(g.resize(size, Image.BILINEAR) if size and g.size != size else g, dtype=np.float64)


def print_score(shop_photo, shop_box, result, result_box, print_mask):
    """SSIM over the print region only. The shop photo's garment box is laid over the result's (an affine
    map: scale and shift) and the print mask with it. The mask is either the shop photo's size (the page's
    print areas over the whole photo) or any other size, taken as covering the garment's box (the page's
    `print.image`, the garment's front from collar to hem). None when the region is empty."""
    size = (result_box[2] - result_box[0], result_box[3] - result_box[1])
    if min(size) < 8:
        return None
    mask_picture = print_mask if isinstance(print_mask, Image.Image) else Image.fromarray(as_mask(print_mask).astype(np.uint8) * 255)
    if mask_picture.size == shop_photo.size:
        mask_picture = crop(mask_picture, shop_box)
    region = mask_of(mask_picture, size)
    if region.sum() < 16:
        return None
    ours = grey(crop(shop_photo, shop_box), size)
    theirs = grey(crop(result, result_box), size)
    return float(np.clip(ssim_map(ours, theirs)[region].mean(), -1, 1))


# The gates ----------------------------------------------------------------------------------------------

def validate(render_mask, result, shop_photo, garment_mask_in_result, shop_garment_mask, print_mask=None, cutout=None, embed=None, thresholds=THRESHOLDS):
    """render_mask: the figure's outline from the page (white on black), any size. result: the try-on
    picture (PIL). shop_photo: the shop's picture of the garment (PIL). garment_mask_in_result and
    shop_garment_mask: where the garment is in each (mask pictures or boolean arrays). print_mask: see
    print_score, or None for a plain garment. cutout(picture) -> greyscale PIL of the figure; embed(picture)
    -> vector. Returns {shape, identity, print, ok}, each gate with its score, threshold and pass."""
    cutout = cutout or cutout_default
    embed = embed or embed_default
    result = result.convert("RGB")
    shop_photo = shop_photo.convert("RGB")

    # 1. Shape
    wanted = as_mask(render_mask, result.size)
    found = as_mask(cutout(result), result.size)
    overlap = iou(wanted, found)
    shape = {"score": round(overlap, 3), "threshold": thresholds["shape"], "pass": overlap >= thresholds["shape"]}

    # 2. Identity
    theirs = as_mask(garment_mask_in_result, result.size)
    ours = as_mask(shop_garment_mask, shop_photo.size)
    result_box, shop_box = bbox(theirs), bbox(ours)
    if result_box is None or shop_box is None:
        identity = {"score": 0.0, "colour": None, "threshold": thresholds["identity"], "colour_threshold": thresholds["colour"], "pass": False}
    else:
        likeness = cosine(embed(crop(shop_photo, shop_box)), embed(crop(result, result_box)))
        distance = colour_distance(shop_photo, ours, result, theirs)
        identity = {
            "score": round(likeness, 3),
            "colour": None if math.isinf(distance) else round(distance, 1),
            "threshold": thresholds["identity"],
            "colour_threshold": thresholds["colour"],
            "pass": likeness >= thresholds["identity"] and distance <= thresholds["colour"],
        }

    # 3. Print
    score = None
    if print_mask is not None and result_box is not None and shop_box is not None:
        score = print_score(shop_photo, shop_box, result, result_box, print_mask)
    if score is None:
        printed = {"skipped": True, "score": None, "threshold": thresholds["print"], "pass": True}
    else:
        printed = {"skipped": False, "score": round(score, 3), "threshold": thresholds["print"], "pass": score >= thresholds["print"]}

    return {"shape": shape, "identity": identity, "print": printed, "ok": bool(shape["pass"] and identity["pass"] and printed["pass"])}


def words_for(checks):
    """The gates in plain words, for a sheet or a log line: 'shape 0.91 ok · colour 4.2 ok · print skipped'."""
    parts = [f"shape {checks['shape']['score']:.2f} {'ok' if checks['shape']['pass'] else 'OFF'}"]
    identity = checks["identity"]
    colour = "-" if identity["colour"] is None else f"{identity['colour']:.1f}"
    parts.append(f"look {identity['score']:.2f} colour {colour} {'ok' if identity['pass'] else 'OFF'}")
    printed = checks["print"]
    parts.append("print skipped" if printed["skipped"] else f"print {printed['score']:.2f} {'ok' if printed['pass'] else 'OFF'}")
    return " · ".join(parts)


# A check without any model -------------------------------------------------------------------------------

def synthetic():
    """Made-up pictures for --selfcheck and the tests: a grey figure on black with a red 'top' carrying a
    white stripe print, a 'shop photo' of the same red top on white, and the masks."""
    w, h = 300, 450
    figure = np.zeros((h, w), dtype=bool)
    figure[40:420, 100:200] = True
    top = np.zeros_like(figure)
    top[90:230, 95:205] = True
    figure |= top  # the page's outline is the figure with its clothes on
    render = np.full((h, w, 3), 10, dtype=np.uint8)
    render[figure] = (200, 200, 200)
    render[top] = (190, 30, 40)
    render[150:170, 110:190] = (245, 245, 245)  # the print
    shop = np.full((h, w, 3), 255, dtype=np.uint8)
    shop_top = np.zeros_like(figure)
    shop_top[60:340, 40:260] = True
    shop[shop_top] = (190, 30, 40)
    shop[180:220, 70:230] = (245, 245, 245)
    print_mask = np.zeros_like(figure)
    print_mask[180:220, 70:230] = True
    pictures = {name: Image.fromarray(a) for name, a in {"render": render, "shop": shop}.items()}
    masks = {name: Image.fromarray(a.astype(np.uint8) * 255) for name, a in {"figure": figure, "top": top, "shop_top": shop_top, "print": print_mask}.items()}
    return pictures, masks


def fake_cutout(picture):
    """Everything that isn't the dark backdrop, for pictures made by synthetic()."""
    grey_ = np.asarray(picture.convert("L"))
    return Image.fromarray(((grey_ > 30) & (grey_ < 250)).astype(np.uint8) * 255)


def fake_embed(picture):
    """A colour histogram in place of DINOv2, so --selfcheck runs without a model."""
    pixels = np.asarray(picture.convert("RGB").resize((64, 64))).reshape(-1, 3) // 64
    return np.bincount(pixels[:, 0] * 16 + pixels[:, 1] * 4 + pixels[:, 2], minlength=64).astype(np.float64)


def main(argv):
    if "--selfcheck" not in argv:
        print("usage: python3 validate.py --selfcheck", file=sys.stderr)
        return 2
    pictures, masks = synthetic()
    same = validate(masks["figure"], pictures["render"], pictures["shop"], masks["top"], masks["shop_top"], masks["print"], cutout=fake_cutout, embed=fake_embed)
    print("the render against itself:", words_for(same), "->", "ok" if same["ok"] else "refused")
    wrong = np.asarray(pictures["render"]).copy()
    wrong[as_mask(masks["top"])] = (30, 40, 190)
    other = validate(masks["figure"], Image.fromarray(wrong), pictures["shop"], masks["top"], masks["shop_top"], masks["print"], cutout=fake_cutout, embed=fake_embed)
    print("a blue top instead of red:", words_for(other), "->", "ok" if other["ok"] else "refused")
    print(json.dumps({"same": same, "wrong": other}, indent=1))
    return 0 if same["ok"] and not other["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
