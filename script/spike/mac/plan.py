"""The Mac spike's pure parts: which runs to make, in what order, and what they add up to. No torch here, so
`python3 -m unittest script/spike/mac/test_plan.py` runs anywhere.

A run is FASHN VTON 1.5 at one precision for some number of steps ("fp16:20"). The precisions:

    fp32    the model and the sampler in 32-bit floats: what the engine uses on a Mac today, and the
            reference every other run is compared against (at its most steps).
    fp16    everything in 16-bit floats, as the engine runs it on Kaggle's T4.
    bf16    everything in bfloat16, as FASHN runs it on newer NVIDIA cards (range of fp32, less precision).
    hybrid  fp16 weights and maths, with the parts that lose most to fp16 kept in fp32: the noisy picture the
            sampler carries from step to step, the time embedding, the layer norms and the last layer; and
            each block's output held inside fp16's range so one overflow can't turn the picture black.
"""

import os
import sys
from collections import namedtuple

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "modal"))
from tryon_prep import fit  # noqa: E402
from validate import ssim_map  # noqa: E402

PRECISIONS = ("fp32", "fp16", "bf16", "hybrid")
MIN_STEPS, MAX_STEPS = 1, 50

# A run "looks the same" as the full-quality one when DINOv2 sees the figure as this close (cosine). A starting
# point, like the validator's thresholds: the sheet is the judge.
LOOKS_SAME = 0.90

PRESETS = {
    # Every code path once, on one item, in a couple of minutes: run this first.
    "smoke": "fp32:2,fp16:2,bf16:2,hybrid:2",
    # One item, the likeliest answers.
    "quick": "fp32:30,fp32:20,fp16:20,hybrid:20,hybrid:12",
    # Both items, the whole grid.
    "full": "fp32:30,fp32:20,fp16:30,fp16:20,fp16:12,bf16:20,hybrid:30,hybrid:20,hybrid:12",
    # Both items: what fits in a minute. Few steps, and guidance (the second, garment-less pass the model makes
    # each step) on the first few only; the rest are one pass each, half the work.
    "minute": "fp32:30,fp32:12:g4,fp32:10:g3,fp32:8:g3,fp32:8:g0,fp32:6:g2,fp16:8:g3",
}
TARGET_SECONDS = 60


class Config(namedtuple("Config", "precision steps guided")):
    """guided: how many of the first steps use classifier-free guidance (two passes of the model, one with the
    garment and one without, pushed apart); the rest are one pass, with the garment. None is FASHN's own: every
    step but the last."""
    __slots__ = ()

    def __new__(cls, precision, steps, guided=None):
        return super().__new__(cls, precision, steps, None if guided == steps - 1 else guided)

    @property
    def guided_steps(self):
        return self.steps - 1 if self.guided is None else self.guided

    @property
    def name(self):
        """For file names and keys: "fp16-20", "fp32-8-g3"."""
        return f"{self.precision}-{self.steps}" + ("" if self.guided is None else f"-g{self.guided}")

    @property
    def title(self):
        """For the sheet: "fp16 · 20 steps", "fp32 · 8 steps · 3 guided"."""
        return f"{self.precision} · {self.steps} steps" + ("" if self.guided is None else f" · {self.guided} guided")


def parse_configs(text):
    """ "fp32:30, fp16:20 hybrid@12 fp32:8:g3" -> [Config]. ":gN" guides the first N steps only (0: none).
    Order kept, repeats dropped. Raises ValueError, saying why."""
    configs = []
    for part in str(text or "").replace(",", " ").split():
        precision, sep, rest = part.replace("@", ":").partition(":")
        precision = precision.strip().lower()
        if precision not in PRECISIONS:
            raise ValueError(f"{part!r}: the precision is one of {', '.join(PRECISIONS)}")
        steps, _, guided = rest.partition(":")
        if not sep or not steps.strip().isdigit():
            raise ValueError(f"{part!r}: give the steps after a colon, as in {precision}:20")
        steps = int(steps)
        if not MIN_STEPS <= steps <= MAX_STEPS:
            raise ValueError(f"{part!r}: steps from {MIN_STEPS} to {MAX_STEPS}")
        if guided:
            if not (guided[:1].lower() == "g" and guided[1:].isdigit()) or int(guided[1:]) > steps:
                raise ValueError(f"{part!r}: guidance as g and a number of steps up to {steps}, as in {precision}:{steps}:g3")
            guided = int(guided[1:])
        config = Config(precision, steps, guided if guided != "" else None)
        if config not in configs:
            configs.append(config)
    if not configs:
        raise ValueError("no runs given")
    return configs


def with_baseline(configs):
    """(configs, baseline, note): the baseline is the fp32 run with the most steps and FASHN's own guidance.
    When none is asked for, one is added at the most steps asked for (every other run is judged against it),
    and the note says so."""
    fp32 = [c for c in configs if c.precision == "fp32" and c.guided is None]
    if fp32:
        return list(configs), max(fp32, key=lambda c: c.steps), None
    baseline = Config("fp32", max(c.steps for c in configs))
    return [baseline, *configs], baseline, f"added {baseline.name} as the reference the others are compared with"


def run_order(configs, baseline):
    """[(precision, [Config, ...])]: one model load per precision, the baseline's first (so the reference is
    there before anything is compared with it), then the rest in PRECISIONS order; most work first."""
    groups = {}
    for c in configs:
        groups.setdefault(c.precision, []).append(c)
    order = [baseline.precision] + [p for p in PRECISIONS if p != baseline.precision]
    return [(p, sorted(groups[p], key=lambda c: (c.steps, c.guided_steps), reverse=True)) for p in order if p in groups]


# Likeness to the reference ------------------------------------------------------------------------------------

def grey(picture, size=None):
    g = picture.convert("L")
    if size and g.size != size:
        g = g.resize(size, Image.BILINEAR)
    return np.asarray(g, dtype=np.float64)


def mask_array(mask, size):
    """A boolean array (height x width) from a mask picture, at `size`."""
    m = mask.convert("L")
    if m.size != size:
        m = m.resize(size, Image.NEAREST)
    return np.asarray(m) > 127


def ssim_in(a, b, mask=None):
    """Mean structural similarity of two pictures (b resized to a), over the mask's white part when given (the
    figure: the backdrop is the same in every run and would flatter the score). 1.0 is identical."""
    ga, gb = grey(a), grey(b, a.size)
    full = ssim_map(ga, gb)
    if mask is not None:
        inside = mask_array(mask, a.size)
        if inside.any():
            return round(float(full[inside].mean()), 4)
    return round(float(full.mean()), 4)


def bbox(mask, size, pad=0.02):
    """The mask's white part's box (left, top, right, bottom) at `size`, padded a little, or the whole picture."""
    inside = mask_array(mask, size)
    ys, xs = np.nonzero(inside)
    if not len(xs):
        return (0, 0, size[0], size[1])
    px, py = round(size[0] * pad), round(size[1] * pad)
    return (max(0, xs.min() - px), max(0, ys.min() - py), min(size[0], xs.max() + 1 + px), min(size[1], ys.max() + 1 + py))


# The results -------------------------------------------------------------------------------------------------

def run_ok(run):
    """A run counts when it made a picture with no NaN and, if the gates ran, passed them."""
    if run.get("error") or not run.get("finite", False):
        return False
    checks = run.get("checks")
    return True if checks is None else bool(checks.get("ok"))


def summarize(runs, configs, baseline):
    """One row per config, in `configs` order, over every item: mean seconds (the sampling on the GPU, and
    the whole call), seconds a step, speed against the baseline, whether every item came out (see run_ok),
    and the least likeness to the baseline's picture (DINOv2 cosine and SSIM, over the figure)."""

    def mean(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 1) if values else None

    by_name = {}
    for run in runs:
        by_name.setdefault(run["config"], []).append(run)
    base = mean(r.get("sample_seconds") for r in by_name.get(baseline.name, []))
    rows = []
    for c in configs:
        mine = by_name.get(c.name, [])
        seconds = mean(r.get("sample_seconds") for r in mine)
        likeness = [r["vs_full"] for r in mine if r.get("vs_full")]
        rows.append({
            "config": c.name,
            "title": c.title,
            "precision": c.precision,
            "steps": c.steps,
            "items": len(mine),
            "seconds": seconds,
            "wall_seconds": mean(r.get("wall_seconds") for r in mine),
            "wall_max": max((r["wall_seconds"] for r in mine if r.get("wall_seconds") is not None), default=None),
            "per_step": round(seconds / c.steps, 2) if seconds else None,
            "speedup": round(base / seconds, 2) if base and seconds else None,
            "ok": bool(mine) and all(run_ok(r) for r in mine),
            "checked": any(r.get("checks") is not None for r in mine),
            "dino": min((v["dino"] for v in likeness if v.get("dino") is not None), default=None),
            "ssim": min((v["ssim"] for v in likeness if v.get("ssim") is not None), default=None),
            "memory_gb": max((r["memory_gb"] for r in mine if r.get("memory_gb") is not None), default=None),
            "errors": sorted({r.get("error") or "NaN" for r in mine if r.get("error") or not r.get("finite", False)}),
        })
    return rows


def recommend(rows, baseline, looks_same=LOOKS_SAME):
    """The fastest config that came out on every item (run_ok) and looks the same as the baseline (DINOv2 at
    or above `looks_same`). Returns {"pick": name or None, "why": words}."""
    if all(r["dino"] is None for r in rows if r["config"] != baseline.name):
        # --no-checks: nothing was compared, so only speed and a clean picture can count.
        ran = [r for r in rows if r["ok"] and r["seconds"]]
        if not ran:
            return {"pick": None, "why": "nothing came out on every item; see the errors"}
        best = min(ran, key=lambda r: r["seconds"])
        return {"pick": best["config"], "why": f"the fastest that made a picture every time ({best['seconds']} s); "
                                               "likeness not measured, so check the sheet"}
    qualified = [r for r in rows if r["ok"] and r["seconds"] and (r["config"] == baseline.name or (r["dino"] is not None and r["dino"] >= looks_same))]
    if not qualified:
        return {"pick": None, "why": "nothing came out right on every item; see the errors and the sheet"}
    best = min(qualified, key=lambda r: r["seconds"])
    if best["config"] == baseline.name:
        return {"pick": best["config"], "why": "nothing faster both passed and looked the same as full quality"}
    gates = "passed the gates and " if best["checked"] else ""
    return {
        "pick": best["config"],
        "why": f"{best['speedup']}x the speed of {baseline.name} ({best['seconds']} s against "
               f"{round(best['seconds'] * best['speedup'], 1)} s); {gates}looks the same (DINOv2 {best['dino']})",
    }


def within(rows, baseline, target=TARGET_SECONDS, looks_same=LOOKS_SAME):
    """Of the configs whose whole call (the slowest item's: what a person waits for) fits in `target` seconds
    and came out on every item, the one that looks most like the baseline. Returns {"pick", "why"}."""
    fits = [r for r in rows if r["ok"] and r["wall_max"] is not None and r["wall_max"] <= target]
    if not fits:
        timed = [r for r in rows if r["wall_max"] is not None]
        fastest = min(timed, key=lambda r: r["wall_max"]) if timed else None
        return {"pick": None, "why": f"nothing came out within {target} s" + (
            f"; the fastest was {fastest['config']} at {fastest['wall_max']} s" if fastest else "")}
    best = max(fits, key=lambda r: (r["dino"] if r["dino"] is not None else -1, -r["wall_max"]))
    like = "unjudged (no likeness measured)" if best["dino"] is None else (
        f"DINOv2 {best['dino']} against full quality" + ("" if best["dino"] >= looks_same else ", below the look-the-same line: check the sheet"))
    return {"pick": best["config"], "why": f"{best['wall_max']} s at worst, within {target} s; {like}"}


def table(rows, baseline):
    """The summary as a Markdown table."""
    lines = [
        "| Run | Seconds (GPU) | Whole call (worst) | Per step | Speed | Came out | Like full (DINOv2 / SSIM) | Memory |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        like = "reference" if r["config"] == baseline.name else (
            f"{r['dino']} / {r['ssim']}" if r["dino"] is not None else "-")
        if r["errors"]:
            came = f"no: {', '.join(r['errors'])}"
        else:
            came = ("yes" if r["ok"] else "no: refused") + ("" if r["checked"] else " (gates not run)")
        lines.append(
            f"| {r['title']} | {r['seconds'] if r['seconds'] is not None else '-'} | "
            f"{r['wall_max'] if r['wall_max'] is not None else '-'} | {r['per_step'] or '-'} | "
            f"{str(r['speedup']) + 'x' if r['speedup'] else '-'} | {came} | {like} | "
            f"{str(r['memory_gb']) + ' GB' if r['memory_gb'] else '-'} |"
        )
    return "\n".join(lines)


def caption(run, baseline):
    """Three short lines under a picture on the sheet."""
    if run.get("error"):
        return f"failed\n{run['error'][:40]}"
    seconds = run.get("sample_seconds")
    first = f"{seconds} s" if seconds is not None else "-"
    if not run.get("finite", True):
        return f"{first}\nNaN: picture lost"
    checks = run.get("checks")
    second = "gates not run" if checks is None else ("PASS" if checks.get("ok") else "REFUSED") + (
        f" · look {checks['identity']['score']}" if checks.get("identity") else "")
    likeness = run.get("vs_full") or {}
    third = "reference" if run["config"] == baseline.name else (
        f"like full {likeness.get('dino')} / {likeness.get('ssim')}" if likeness else "")
    return f"{first}\n{second}\n{third}"


def sheet(items, configs, pictures, captions, cell=(220, 330), gap=10, caption_height=58):
    """One row per item: store photo | our render | a picture per config, each captioned. items: [{"name",
    "shop", "render"}] (PIL); pictures and captions: {(item name, config name): PIL / text}. Returns a PIL."""
    heads = ["Store photo", "Our render", *[c.title for c in configs]]
    w, h = cell
    width = gap + len(heads) * (w + gap)
    height = 40 + len(items) * (h + caption_height + gap)
    out = Image.new("RGB", (width, height), (21, 23, 27))
    draw = ImageDraw.Draw(out)
    for i, head in enumerate(heads):
        draw.text((gap + i * (w + gap), 14), head.upper(), fill=(154, 160, 171))
    for row, item in enumerate(items):
        y = 40 + row * (h + caption_height + gap)
        cells = [(item.get("shop"), item["name"][:34]), (item.get("render"), "")]
        cells += [(pictures.get((item["name"], c.name)), captions.get((item["name"], c.name), "")) for c in configs]
        for col, (picture, words) in enumerate(cells):
            x = gap + col * (w + gap)
            if picture is None:
                draw.rectangle((x, y, x + w, y + h), outline=(44, 48, 55))
                draw.text((x + 10, y + 10), "no picture", fill=(154, 160, 171))
            else:
                out.paste(fit(picture, w, h), (x, y))
            for line, text in enumerate(str(words).split("\n")[:3]):
                draw.text((x, y + h + 6 + line * 16), text, fill=(233, 235, 239) if line == 0 else (154, 160, 171))
    return out
