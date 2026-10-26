import os
import sys
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import validate as v  # noqa: E402


class ColourTest(unittest.TestCase):
    # Pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula", table 1.
    PAIRS = [
        ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
        ((50.0000, 3.1571, -77.2803), (50.0000, 0.0000, -82.7485), 2.8615),
        ((50.0000, 2.5000, 0.0000), (50.0000, 0.0000, -2.5000), 4.3065),
        ((50.0000, 2.5000, 0.0000), (73.0000, 25.0000, -18.0000), 27.1492),
        ((50.0000, 2.5000, 0.0000), (61.0000, -5.0000, 29.0000), 22.8977),
        ((50.0000, 2.5000, 0.0000), (50.0000, 3.1736, 0.5854), 1.0000),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
    ]

    def test_ciede2000_matches_the_papers_pairs(self):
        for a, b, wanted in self.PAIRS:
            self.assertAlmostEqual(v.ciede2000(a, b), wanted, places=3)
            self.assertAlmostEqual(v.delta_e(a, b), wanted, places=3)

    def test_rgb_to_lab_knows_white_black_and_red(self):
        white, black, red = v.rgb_to_lab([[255, 255, 255], [0, 0, 0], [255, 0, 0]])
        self.assertAlmostEqual(white[0], 100, delta=0.1)
        self.assertAlmostEqual(abs(white[1]) + abs(white[2]), 0, delta=0.1)
        self.assertAlmostEqual(black[0], 0, delta=0.1)
        self.assertAlmostEqual(red[0], 53.2, delta=0.5)
        self.assertAlmostEqual(red[1], 80.1, delta=0.5)

    def test_dominant_colours_find_a_two_tone_garment(self):
        a = np.zeros((100, 100, 3), dtype=np.uint8)
        a[:70] = (190, 30, 40)
        a[70:] = (245, 245, 245)
        colours = v.dominant_colours(Image.fromarray(a), np.ones((100, 100), dtype=bool))
        self.assertAlmostEqual(colours[0][1], 0.7, delta=0.02)
        self.assertLess(v.delta_e(colours[0][0], v.rgb_to_lab([190, 30, 40])), 1)
        self.assertEqual(v.dominant_colours(Image.fromarray(a), np.zeros((100, 100), dtype=bool)), [])

    def test_colour_distance_is_small_for_light_and_big_for_another_colour(self):
        red = Image.new("RGB", (50, 50), (190, 30, 40))
        lit = Image.new("RGB", (50, 50), (205, 45, 55))
        blue = Image.new("RGB", (50, 50), (30, 40, 190))
        everywhere = np.ones((50, 50), dtype=bool)
        self.assertLess(v.colour_distance(red, everywhere, lit, everywhere), v.THRESHOLDS["colour"])
        self.assertGreater(v.colour_distance(red, everywhere, blue, everywhere), 40)
        self.assertEqual(v.colour_distance(red, everywhere, blue, np.zeros_like(everywhere)), float("inf"))


class ShapeAndBoxTest(unittest.TestCase):
    def test_bbox_pads_and_clips(self):
        mask = np.zeros((100, 200), dtype=bool)
        mask[10:50, 20:120] = True
        self.assertEqual(v.bbox(mask, pad=0), (20, 10, 120, 50))
        self.assertEqual(v.bbox(mask, pad=0.1), (10, 6, 130, 54))
        self.assertIsNone(v.bbox(np.zeros((4, 4), dtype=bool)))
        edge = np.ones((10, 10), dtype=bool)
        self.assertEqual(v.bbox(edge), (0, 0, 10, 10))

    def test_as_mask_takes_pictures_and_arrays_at_any_size(self):
        picture = Image.fromarray(np.pad(np.full((50, 50), 255, dtype=np.uint8), 25))
        self.assertEqual(v.as_mask(picture).sum(), 2500)
        self.assertEqual(v.as_mask(picture, (200, 200)).sum(), 10000)
        self.assertEqual(v.as_mask(np.asarray(picture)).sum(), 2500)
        self.assertIsNone(v.as_mask(None))

    def test_band_mask_takes_the_top_or_the_bottom_of_the_figure(self):
        figure = np.zeros((400, 200), dtype=bool)
        figure[0:400, 50:150] = True
        tops, bottoms = v.band_mask(figure, "tops"), v.band_mask(figure, "bottoms")
        self.assertTrue(tops[150, 100] and not tops[300, 100])
        self.assertTrue(bottoms[300, 100] and not bottoms[150, 100])


class PrintTest(unittest.TestCase):
    def test_ssim_is_one_for_the_same_picture_and_low_for_noise(self):
        rng = np.random.default_rng(1)
        a = rng.integers(0, 255, (64, 64)).astype(np.float64)
        self.assertAlmostEqual(v.ssim_map(a, a).mean(), 1.0, places=6)
        self.assertLess(v.ssim_map(a, rng.integers(0, 255, (64, 64)).astype(np.float64)).mean(), 0.1)
        with self.assertRaises(ValueError):
            v.ssim_map(a, a[:32])

    def test_own_ssim_agrees_with_scikit_image_when_present(self):
        try:
            from skimage.metrics import structural_similarity
        except ImportError:
            self.skipTest("no scikit-image here")
        rng = np.random.default_rng(2)
        a = rng.integers(0, 255, (40, 48)).astype(np.float64)
        b = np.clip(a + rng.normal(0, 20, a.shape), 0, 255)
        theirs = structural_similarity(a, b, data_range=255.0, win_size=7, full=True)[1]
        # The fallback has no scikit-image to call: run it by hiding the module.
        import builtins

        real_import = builtins.__import__

        def no_skimage(name, *args, **kwargs):
            if name.startswith("skimage"):
                raise ImportError(name)
            return real_import(name, *args, **kwargs)

        builtins.__import__ = no_skimage
        try:
            ours = v.ssim_map(a, b)
        finally:
            builtins.__import__ = real_import
        inner = (slice(3, -3), slice(3, -3))  # the borders differ only in how they're padded
        self.assertAlmostEqual(float(np.abs(ours[inner] - theirs[inner]).max()), 0, places=6)

    def test_print_score_maps_the_shop_box_onto_the_result_box(self):
        pictures, masks = v.synthetic()
        shop_box = v.bbox(v.as_mask(masks["shop_top"]))
        result_box = v.bbox(v.as_mask(masks["top"]))
        kept = v.print_score(pictures["shop"], shop_box, pictures["render"], result_box, masks["print"])
        self.assertGreater(kept, v.THRESHOLDS["print"])
        plain = np.asarray(pictures["render"]).copy()
        plain[v.as_mask(masks["top"])] = (190, 30, 40)
        lost = v.print_score(pictures["shop"], shop_box, Image.fromarray(plain), result_box, masks["print"])
        self.assertLess(lost, kept)
        self.assertIsNone(v.print_score(pictures["shop"], shop_box, pictures["render"], result_box, Image.new("L", pictures["shop"].size)))

    def test_a_print_mask_that_isnt_the_photos_size_covers_the_garment_box(self):
        pictures, masks = v.synthetic()
        shop_box = v.bbox(v.as_mask(masks["shop_top"]))
        result_box = v.bbox(v.as_mask(masks["top"]))
        front = masks["print"].crop(shop_box).resize((120, 160))
        score = v.print_score(pictures["shop"], shop_box, pictures["render"], result_box, front)
        self.assertGreater(score, v.THRESHOLDS["print"])


class ValidateTest(unittest.TestCase):
    def setUp(self):
        self.pictures, self.masks = v.synthetic()

    def run_gates(self, result, **extra):
        return v.validate(self.masks["figure"], result, self.pictures["shop"], self.masks["top"], self.masks["shop_top"],
                          extra.pop("print_mask", self.masks["print"]), cutout=extra.pop("cutout", v.fake_cutout), embed=extra.pop("embed", v.fake_embed), **extra)

    def test_the_render_itself_passes_every_gate(self):
        checks = self.run_gates(self.pictures["render"])
        self.assertTrue(checks["ok"], checks)
        self.assertGreaterEqual(checks["shape"]["score"], 0.99)
        self.assertGreaterEqual(checks["identity"]["score"], 0.95)
        self.assertLess(checks["identity"]["colour"], 2)
        self.assertFalse(checks["print"]["skipped"])
        self.assertIn("shape 1.00 ok", v.words_for(checks))

    def test_a_wider_figure_fails_shape_only(self):
        wide = np.asarray(self.pictures["render"]).copy()
        wide[40:420, 60:240] = (200, 200, 200)
        wide[90:230, 95:205] = (190, 30, 40)
        wide[150:170, 110:190] = (245, 245, 245)
        checks = self.run_gates(Image.fromarray(wide))
        self.assertFalse(checks["shape"]["pass"])
        self.assertTrue(checks["identity"]["pass"])
        self.assertFalse(checks["ok"])

    def test_with_the_render_the_identity_gate_is_relative(self):
        # A flat shop photo and a worn garment never embed alike: with the render given, the bar is the
        # render's own likeness less a little slack, never under the floor, and the render itself passes.
        checks = self.run_gates(self.pictures["render"], render=self.pictures["render"])
        self.assertTrue(checks["identity"]["pass"], checks["identity"])
        self.assertEqual(checks["identity"]["baseline"], checks["identity"]["score"])
        self.assertAlmostEqual(checks["identity"]["threshold"], max(v.IDENTITY_FLOOR, checks["identity"]["baseline"] - v.RELATIVE_SLACK), places=3)
        # A result embedding far below the render's likeness fails, even though its colour is fine.
        # The gate embeds the shop crop, then the result's, then the render's: the result alone is unlike.
        calls = iter([np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), np.array([1.0, 0.0, 0.0])])
        far = lambda picture: next(calls)
        checks = v.validate(self.masks["figure"], self.pictures["render"], self.pictures["shop"], self.masks["top"], self.masks["shop_top"],
                            None, cutout=v.fake_cutout, embed=far, render=self.pictures["render"])
        self.assertFalse(checks["identity"]["pass"])

    def test_another_colour_fails_identity(self):
        blue = np.asarray(self.pictures["render"]).copy()
        blue[v.as_mask(self.masks["top"])] = (30, 40, 190)
        checks = self.run_gates(Image.fromarray(blue))
        self.assertTrue(checks["shape"]["pass"])
        self.assertFalse(checks["identity"]["pass"])
        self.assertGreater(checks["identity"]["colour"], v.THRESHOLDS["colour"])

    def test_a_lost_print_fails_print_and_no_print_skips_it(self):
        plain = np.asarray(self.pictures["render"]).copy()
        plain[v.as_mask(self.masks["top"])] = (190, 30, 40)
        checks = self.run_gates(Image.fromarray(plain))
        self.assertFalse(checks["print"]["pass"])
        skipped = self.run_gates(Image.fromarray(plain), print_mask=None)
        self.assertTrue(skipped["print"]["skipped"])
        self.assertTrue(skipped["print"]["pass"])

    def test_an_empty_garment_mask_fails_identity_instead_of_crashing(self):
        checks = v.validate(self.masks["figure"], self.pictures["render"], self.pictures["shop"], Image.new("L", self.pictures["render"].size),
                            self.masks["shop_top"], None, cutout=v.fake_cutout, embed=v.fake_embed)
        self.assertFalse(checks["identity"]["pass"])
        self.assertIsNone(checks["identity"]["colour"])
        self.assertFalse(checks["ok"])

    def test_the_injected_models_are_the_ones_called(self):
        calls = []

        def embed(picture):
            calls.append(picture.size)
            return v.fake_embed(picture)

        self.run_gates(self.pictures["render"], embed=embed)
        self.assertEqual(len(calls), 2)
        shop_box = v.bbox(v.as_mask(self.masks["shop_top"]))
        self.assertEqual(calls[0], (shop_box[2] - shop_box[0], shop_box[3] - shop_box[1]))

    def test_selfcheck_runs(self):
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = v.main(["--selfcheck"])
        self.assertEqual(code, 0)
        self.assertIn("refused", out.getvalue())


if __name__ == "__main__":
    unittest.main()
