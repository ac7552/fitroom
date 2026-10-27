import os
import sys
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import tryon_prep as p  # noqa: E402


class PoseTest(unittest.TestCase):
    def pose(self):
        points = [[100 + 10 * j, 50 + 20 * j, 0.9] for j in range(18)]
        for j in (14, 15, 16, 17):  # an egg head: no eyes, no ears
            points[j] = [0, 0, 0]
        return {"width": 400, "height": 600, "keypoints": points}

    def test_keypoints_become_dwpose_fractions_with_unseen_joints_at_minus_one(self):
        out = p.dwpose_from_openpose(self.pose())
        candidate, subset = out["bodies"]["candidate"], out["bodies"]["subset"]
        self.assertEqual(candidate.shape, (18, 2))
        self.assertEqual(subset.shape, (1, 18))
        self.assertAlmostEqual(candidate[2][0], 120 / 400)
        self.assertAlmostEqual(candidate[2][1], 90 / 600)
        self.assertEqual(subset[0][2], 2)
        self.assertEqual(list(candidate[14]), [-1, -1])
        self.assertEqual(subset[0][14], -1)
        self.assertNotIn("hands", out)

    def test_rejects_the_wrong_number_of_points_or_no_size(self):
        with self.assertRaises(ValueError):
            p.dwpose_from_openpose({"width": 400, "height": 600, "keypoints": [[1, 2, 1]] * 17})
        with self.assertRaises(ValueError):
            p.dwpose_from_openpose({"width": 0, "height": 600, "keypoints": [[1, 2, 1]] * 18})

    def test_points_outside_the_picture_count_as_unseen(self):
        pose = self.pose()
        pose["keypoints"][4] = [450, 100, 1]
        out = p.dwpose_from_openpose(pose)
        self.assertEqual(out["bodies"]["subset"][0][4], -1)


class LetterboxTest(unittest.TestCase):
    def test_a_tall_picture_fits_leffas_frame_and_comes_back(self):
        picture = Image.new("RGB", (500, 1000), (200, 30, 30))
        framed, box = p.letterbox(picture, 768, 1024, (255, 255, 255))
        self.assertEqual(framed.size, (768, 1024))
        self.assertEqual(box, (128, 0, 640, 1024))
        self.assertEqual(framed.getpixel((10, 500)), (255, 255, 255))
        self.assertEqual(framed.getpixel((384, 500)), (200, 30, 30))
        back = p.unletterbox(framed, box, picture.size)
        self.assertEqual(back.size, picture.size)
        self.assertEqual(back.getpixel((250, 500)), (200, 30, 30))

    def test_a_mask_is_padded_with_black_not_white(self):
        mask = Image.new("L", (300, 300), 255)
        framed, _ = p.letterbox(mask, 768, 1024, 0)
        self.assertEqual(framed.getpixel((384, 10)), 0)
        self.assertEqual(framed.getpixel((384, 512)), 255)

    def test_grow_widens_a_mask_by_the_given_pixels(self):
        a = np.zeros((100, 100), dtype=np.uint8)
        a[40:60, 40:60] = 255
        grown = np.asarray(p.grow(Image.fromarray(a), 5))
        self.assertEqual(grown[35, 50], 255)
        self.assertEqual(grown[34, 50], 0)
        self.assertEqual(grown[50, 65], 0)
        self.assertEqual(np.asarray(p.grow(Image.fromarray(a), 0)).sum(), a.sum())


class SheetTest(unittest.TestCase):
    def test_sheet_has_a_row_per_name_and_survives_missing_pictures(self):
        rows = [
            {"name": "hoodie", "shop": Image.new("RGB", (400, 500), "white"), "render": Image.new("RGB", (200, 300), "grey"),
             "fashn": Image.new("RGB", (576, 864), "red"), "leffa": None, "fashn_words": "shape 0.91 ok\n12.3 s", "leffa_words": "failed: no densepose"},
            {"name": "jeans", "shop": None, "render": None, "fashn": None, "leffa": None},
        ]
        sheet = p.contact_sheet(rows, cell=(100, 150), caption=40)
        self.assertEqual(sheet.size, (12 + 4 * 112, 40 + 2 * (150 + 40 + 12)))
        self.assertEqual(sheet.getpixel((12 + 2 * 112 + 50, 40 + 75)), (255, 0, 0))
        self.assertGreater(len(p.png_bytes(sheet)), 100)


class CloseUpTest(unittest.TestCase):
    def stage(self):
        """A wide stage: a light backdrop and a dark figure 120 wide, 600 tall, a little left of the middle."""
        picture = Image.new("RGB", (1280, 1000), (236, 233, 228))
        figure = Image.new("RGB", (120, 600), (30, 30, 34))
        picture.paste(figure, (500, 200))
        outline = Image.new("L", (1280, 1000), 0)
        outline.paste(255, (500, 200, 620, 800))
        return picture, outline

    def test_the_box_is_fashn_shaped_round_the_figure_with_a_margin(self):
        picture, outline = self.stage()
        box = p.figure_box(picture, outline)
        left, top, right, bottom = box
        self.assertAlmostEqual((right - left) / (bottom - top), 576 / 864, places=2)
        self.assertLessEqual(top, 200 - 30)
        self.assertGreaterEqual(bottom, 800 + 30)
        self.assertLess(left, 500)
        self.assertGreater(right, 620)
        self.assertAlmostEqual((left + right) / 2, 560, delta=1)
        # The figure fills most of the box's height: a close-up, not the wide stage.
        self.assertGreater(600 / (bottom - top), 0.8)

    def test_without_an_outline_the_backdrop_is_left_out(self):
        picture, outline = self.stage()
        self.assertEqual(p.figure_box(picture), p.figure_box(picture, outline))

    def test_no_figure_no_box(self):
        self.assertIsNone(p.figure_box(Image.new("RGB", (200, 300), (236, 233, 228))))
        self.assertIsNone(p.figure_box(Image.new("RGB", (200, 300)), Image.new("L", (200, 300), 0)))

    def test_a_box_past_the_edge_is_padded_with_the_backdrop(self):
        picture, _ = self.stage()
        piece = p.cut(picture, (-40, -20, 160, 280))
        self.assertEqual(piece.size, (200, 300))
        self.assertEqual(piece.getpixel((0, 0)), (236, 233, 228))
        mask = p.cut(Image.new("L", (100, 100), 255), (-10, 0, 90, 100))
        self.assertEqual(mask.getpixel((0, 50)), 0)
        self.assertEqual(mask.getpixel((50, 50)), 255)

    def test_put_back_lands_where_it_was_cut_with_soft_edges(self):
        picture, outline = self.stage()
        box = p.figure_box(picture, outline)
        piece = p.cut(picture, box)
        painted = Image.new("RGB", (576, 864), (200, 20, 20))
        out = p.put_back(picture, painted, box)
        self.assertEqual(out.size, picture.size)
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        self.assertEqual(out.getpixel((cx, cy)), (200, 20, 20))
        self.assertEqual(out.getpixel((10, 10)), (236, 233, 228))
        edge = out.getpixel((box[0] + 1, cy))
        self.assertTrue(200 < edge[1] < 233 or edge[0] > 200, edge)
        self.assertEqual(piece.size, (box[2] - box[0], box[3] - box[1]))

    def test_a_box_past_the_edge_is_put_back_inside_the_picture(self):
        picture = Image.new("RGB", (300, 200), (236, 233, 228))
        out = p.put_back(picture, Image.new("RGB", (100, 150), (0, 0, 0)), (-50, -50, 150, 250))
        self.assertEqual(out.size, (300, 200))
        self.assertEqual(out.getpixel((50, 100)), (0, 0, 0))
        self.assertEqual(out.getpixel((250, 100)), (236, 233, 228))


if __name__ == "__main__":
    unittest.main()
