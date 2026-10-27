"""python3 -m unittest script/spike/mac/test_plan.py: the Mac spike's pure parts (no torch, no weights)."""

import os
import sys
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plan  # noqa: E402
from plan import Config  # noqa: E402


def run(item, config, seconds, finite=True, ok=True, dino=None, ssim=None, error=None, checks=True):
    r = {"item": item, "config": config, "sample_seconds": seconds, "wall_seconds": seconds + 2, "finite": finite}
    if checks:
        r["checks"] = {"ok": ok, "identity": {"score": 0.6}}
    if dino is not None:
        r["vs_full"] = {"dino": dino, "ssim": ssim}
    if error:
        r["error"] = error
    return r


class ParseConfigs(unittest.TestCase):
    def test_precision_and_steps_in_order_without_repeats(self):
        self.assertEqual(plan.parse_configs("fp32:30, fp16:20 hybrid@12,fp16:20"),
                         [Config("fp32", 30), Config("fp16", 20), Config("hybrid", 12)])

    def test_says_what_is_wrong(self):
        for bad, words in [("fp8:20", "precision"), ("fp16", "steps after a colon"), ("fp16:x", "steps after"),
                           ("fp16:0", "from 1 to 50"), ("fp16:80", "from 1 to 50"), ("", "no runs")]:
            with self.assertRaises(ValueError) as caught:
                plan.parse_configs(bad)
            self.assertIn(words, str(caught.exception), bad)

    def test_presets_parse(self):
        for name, text in plan.PRESETS.items():
            self.assertTrue(plan.parse_configs(text), name)
        self.assertEqual(len(plan.parse_configs(plan.PRESETS["full"])), 9)

    def test_names(self):
        self.assertEqual(Config("hybrid", 12).name, "hybrid-12")
        self.assertEqual(Config("hybrid", 12).title, "hybrid · 12 steps")


class Baseline(unittest.TestCase):
    def test_the_fp32_run_with_most_steps(self):
        configs, baseline, note = plan.with_baseline(plan.parse_configs("fp16:20,fp32:20,fp32:30"))
        self.assertEqual(baseline, Config("fp32", 30))
        self.assertEqual(len(configs), 3)
        self.assertIsNone(note)

    def test_added_when_missing(self):
        configs, baseline, note = plan.with_baseline(plan.parse_configs("fp16:20,hybrid:12"))
        self.assertEqual(baseline, Config("fp32", 20))
        self.assertEqual(configs[0], baseline)
        self.assertIn("fp32-20", note)

    def test_one_load_per_precision_reference_first(self):
        configs, baseline, _ = plan.with_baseline(plan.parse_configs(plan.PRESETS["full"]))
        self.assertEqual(plan.run_order(configs, baseline),
                         [("fp32", [30, 20]), ("fp16", [30, 20, 12]), ("bf16", [20]), ("hybrid", [30, 20, 12])])


class Likeness(unittest.TestCase):
    def picture(self, shade=128, square=None):
        p = Image.new("RGB", (60, 90), (240, 240, 240))
        d = ImageDraw.Draw(p)
        d.rectangle((15, 20, 45, 80), fill=(shade, 60, 60))
        if square:
            d.rectangle(square, fill=(0, 0, 0))
        return p

    def figure(self):
        m = Image.new("L", (60, 90), 0)
        ImageDraw.Draw(m).rectangle((15, 20, 45, 80), fill=255)
        return m

    def test_the_same_picture_is_one(self):
        self.assertAlmostEqual(plan.ssim_in(self.picture(), self.picture()), 1.0, places=4)

    def test_a_change_on_the_figure_counts_more_inside_the_mask(self):
        a, b = self.picture(), self.picture(square=(20, 30, 32, 44))
        inside, whole = plan.ssim_in(a, b, self.figure()), plan.ssim_in(a, b)
        self.assertLess(inside, 1.0)
        self.assertLess(inside, whole)  # the backdrop, the same in both, no longer flatters it

    def test_a_picture_of_another_size_is_compared_at_the_first_size(self):
        self.assertGreater(plan.ssim_in(self.picture(), self.picture().resize((120, 180))), 0.9)

    def test_the_figure_box(self):
        left, top, right, bottom = plan.bbox(self.figure(), (60, 90))
        self.assertTrue(left <= 15 and top <= 20 and right >= 46 and bottom >= 81)
        self.assertEqual(plan.bbox(Image.new("L", (60, 90), 0), (60, 90)), (0, 0, 60, 90))


class Summary(unittest.TestCase):
    def setUp(self):
        self.configs, self.baseline, _ = plan.with_baseline(plan.parse_configs("fp32:30,fp16:20,fp16:12,hybrid:12"))
        self.runs = [
            run("a", "fp32-30", 300), run("b", "fp32-30", 320),
            run("a", "fp16-20", 100, dino=0.97, ssim=0.9), run("b", "fp16-20", 110, dino=0.95, ssim=0.88),
            run("a", "fp16-12", 60, dino=0.84, ssim=0.7), run("b", "fp16-12", 62, dino=0.93, ssim=0.8),
            run("a", "hybrid-12", 70, dino=0.96, ssim=0.9), run("b", "hybrid-12", 72, ok=False, dino=0.95, ssim=0.9),
        ]

    def test_rows(self):
        rows = {r["config"]: r for r in plan.summarize(self.runs, self.configs, self.baseline)}
        self.assertEqual(rows["fp32-30"]["seconds"], 310.0)
        self.assertEqual(rows["fp32-30"]["speedup"], 1.0)
        self.assertEqual(rows["fp16-20"]["speedup"], round(310 / 105, 2))
        self.assertEqual(rows["fp16-20"]["per_step"], 5.25)
        self.assertEqual(rows["fp16-12"]["dino"], 0.84)  # the worst item
        self.assertTrue(rows["fp16-12"]["ok"])
        self.assertFalse(rows["hybrid-12"]["ok"])  # refused on one item
        self.assertEqual(rows["hybrid-12"]["errors"], [])
        nan = plan.summarize([run("a", "fp32-30", 300), run("a", "fp16-12", 60, finite=False)], self.configs, self.baseline)
        self.assertEqual({r["config"]: r["errors"] for r in nan}["fp16-12"], ["NaN"])

    def test_the_fastest_that_passes_and_looks_the_same(self):
        rows = plan.summarize(self.runs, self.configs, self.baseline)
        pick = plan.recommend(rows, self.baseline)
        # fp16-12 is faster but doesn't look the same on one item; hybrid-12 was refused on one.
        self.assertEqual(pick["pick"], "fp16-20")
        self.assertIn("2.95x", pick["why"])

    def test_nan_or_an_error_never_counts(self):
        self.assertFalse(plan.run_ok(run("a", "fp16-20", 10, finite=False)))
        self.assertFalse(plan.run_ok(run("a", "fp16-20", 10, error="RuntimeError: x")))
        self.assertTrue(plan.run_ok(run("a", "fp16-20", 10, checks=False)))  # gates not run: the picture's enough

    def test_the_reference_when_nothing_faster_qualifies(self):
        runs = [run("a", "fp32-30", 300), run("a", "fp16-20", 100, dino=0.5, ssim=0.3)]
        configs, baseline, _ = plan.with_baseline(plan.parse_configs("fp32:30,fp16:20"))
        self.assertEqual(plan.recommend(plan.summarize(runs, configs, baseline), baseline)["pick"], "fp32-30")

    def test_nothing_when_everything_failed(self):
        runs = [run("a", "fp32-30", 300, error="x"), run("a", "fp16-20", 100, finite=False)]
        configs, baseline, _ = plan.with_baseline(plan.parse_configs("fp32:30,fp16:20"))
        self.assertIsNone(plan.recommend(plan.summarize(runs, configs, baseline), baseline)["pick"])

    def test_table_and_captions(self):
        rows = plan.summarize(self.runs, self.configs, self.baseline)
        text = plan.table(rows, self.baseline)
        self.assertIn("| fp32 · 30 steps | 310.0 |", text)
        self.assertIn("reference", text)
        self.assertIn("| hybrid · 12 steps | 71.0 | 5.92 | 4.37x | no: refused |", text)
        self.assertIn("| fp16 · 12 steps | 61.0 | 5.08 | 5.08x | yes | 0.84 / 0.7 |", text)
        self.assertEqual(plan.caption(self.runs[2], self.baseline), "100 s\nPASS · look 0.6\nlike full 0.97 / 0.9")
        self.assertEqual(plan.caption(self.runs[0], self.baseline).split("\n")[2], "reference")
        self.assertIn("NaN", plan.caption(run("a", "fp16-20", 10, finite=False), self.baseline))
        self.assertTrue(plan.caption({"config": "bf16-20", "error": "unsupported here"}, self.baseline).startswith("failed"))

    def test_sheet(self):
        shop, render = Image.new("RGB", (40, 60), "white"), Image.new("RGB", (80, 120), "grey")
        items = [{"name": "a", "shop": shop, "render": render}, {"name": "b", "shop": shop, "render": render}]
        pictures = {("a", "fp32-30"): render, ("b", "fp16-20"): render}
        out = plan.sheet(items, self.configs, pictures, {("a", "fp32-30"): "300 s\nPASS\nreference"}, cell=(100, 150))
        self.assertEqual(out.size, (10 + 6 * 110, 40 + 2 * (150 + 58 + 10)))


if __name__ == "__main__":
    unittest.main()
