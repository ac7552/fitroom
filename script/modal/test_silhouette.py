import io
import os
import sys
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import silhouette as s  # noqa: E402


def mask_picture(w, h, box):
    a = np.zeros((h, w), dtype=np.uint8)
    x0, y0, x1, y1 = box
    a[y0:y1, x0:x1] = 255
    return Image.fromarray(a)


class SilhouetteTest(unittest.TestCase):
    def test_iou_of_matching_and_shifted_outlines(self):
        a = s.mask_of(mask_picture(400, 600, (100, 50, 300, 550)))
        self.assertEqual(s.iou(a, a), 1.0)
        # A hem let down by 10% of the figure's height still passes; a leg twice as wide doesn't.
        longer = s.mask_of(mask_picture(400, 600, (100, 50, 300, 600)))
        self.assertGreater(s.iou(a, longer), s.LEAST_IOU)
        wider = s.mask_of(mask_picture(400, 600, (50, 50, 390, 550)))
        self.assertLess(s.iou(a, wider), s.LEAST_IOU)

    def test_outlines_of_different_sizes_are_compared_at_one_size(self):
        small = mask_picture(200, 300, (50, 25, 150, 275))
        a = s.mask_of(mask_picture(400, 600, (100, 50, 300, 550)))
        self.assertGreater(s.iou(a, s.mask_of(small, (400, 600))), 0.97)
        with self.assertRaises(ValueError):
            s.iou(a, s.mask_of(small))

    def test_sdxl_size_keeps_the_shape_in_multiples_of_64(self):
        w, h = s.sdxl_size(1200, 1600)
        self.assertEqual((w % 64, h % 64), (0, 0))
        self.assertAlmostEqual(w / h, 0.75, delta=0.05)
        self.assertAlmostEqual(w * h, 1024 * 1024, delta=120_000)

    def test_load_rejects_what_isnt_a_picture_and_shrinks_big_ones(self):
        with self.assertRaises(ValueError):
            s.load(b"not a png")
        out = io.BytesIO()
        Image.new("RGB", (3000, 2000), "white").save(out, format="PNG")
        self.assertEqual(max(s.load(out.getvalue()).size), s.MAX_SIDE)
        tiny = io.BytesIO()
        Image.new("RGB", (40, 40)).save(tiny, format="PNG")
        with self.assertRaises(ValueError):
            s.load(tiny.getvalue())

    def test_guides_keep_only_the_figure(self):
        picture = Image.new("RGB", (400, 600), (90, 90, 90))
        guide = s.only_figure(picture, mask_picture(400, 600, (100, 50, 300, 550)))
        self.assertEqual(guide.getpixel((10, 10)), (0, 0, 0))
        self.assertEqual(guide.getpixel((200, 300)), (90, 90, 90))

    def test_depth_is_stretched_over_the_figure(self):
        a = np.zeros((600, 400), dtype=np.uint8)
        a[50:550, 100:300] = np.linspace(120, 138, 200, dtype=np.uint8)  # a narrow band, as the page draws it
        out = np.asarray(s.stretch_depth(Image.fromarray(a), mask_picture(400, 600, (100, 50, 300, 550))).convert("L"))
        self.assertEqual(out[10, 10], 0)
        self.assertGreater(int(out[300, 295]) - int(out[300, 105]), 200)

    def test_edges_find_a_hem(self):
        a = np.zeros((300, 300), dtype=np.uint8)
        a[:150] = 220
        lines = np.asarray(s.edges(Image.fromarray(a)).convert("L"))
        self.assertGreater(lines[145:155].max(), 0)
        self.assertEqual(lines[:100].max(), 0)

    def test_edge_guide_has_the_outline_even_on_a_dark_backdrop(self):
        dark = Image.new("RGB", (400, 600), (20, 21, 24))
        lines = np.asarray(s.guide_edges(dark, mask_picture(400, 600, (100, 50, 300, 550))).convert("L"))
        self.assertGreater(lines[300, 95:106].max(), 0)
        self.assertEqual(lines[300, 150:250].max(), 0)

    def test_prompt_keeps_plain_words_only(self):
        p = s.prompt_for("navy wool coat, black jeans <script>")
        self.assertIn("wearing navy wool coat, black jeans script", p)
        self.assertNotIn("<", p)
        self.assertNotIn("wearing", s.prompt_for(""))


if __name__ == "__main__":
    unittest.main()
