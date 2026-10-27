"""The engine's pure parts, run without torch or a GPU: python3 -m unittest script/modal/test_tryon_engine.py"""

import base64
import io
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import tryon_engine as engine  # noqa: E402

from PIL import Image  # noqa: E402


def png(size=(300, 450), colour=(200, 30, 40), mode="RGB"):
    out = io.BytesIO()
    Image.new(mode, size, colour).save(out, format="PNG")
    return out.getvalue()


class DeviceTest(unittest.TestCase):
    def test_ampere_and_newer_get_bf16(self):
        self.assertEqual(engine.pick_device(cuda=True, capability=(8, 0)), ("cuda", "bfloat16"))
        self.assertEqual(engine.pick_device(cuda=True, capability=(8, 9)), ("cuda", "bfloat16"))  # L4
        self.assertEqual(engine.pick_device(cuda=True, capability=(9, 0)), ("cuda", "bfloat16"))

    def test_a_t4_gets_fp16(self):
        self.assertEqual(engine.pick_device(cuda=True, capability=(7, 5)), ("cuda", "float16"))
        self.assertEqual(engine.pick_device(cuda=True, capability=(7, 0)), ("cuda", "float16"))
        self.assertEqual(engine.pick_device(cuda=True, capability=None), ("cuda", "float16"))

    def test_no_cuda_is_fp32_on_mps_or_cpu(self):
        self.assertEqual(engine.pick_device(cuda=False, mps=True), ("mps", "float32"))
        self.assertEqual(engine.pick_device(), ("cpu", "float32"))

    def test_device_and_dtype_asks_a_fake_torch(self):
        fake = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: True, get_device_capability=lambda: (7, 5)),
            backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)),
            device=lambda name: f"device:{name}",
            float16="FP16", bfloat16="BF16", float32="FP32",
        )
        with mock.patch.dict(sys.modules, {"torch": fake}):
            self.assertEqual(engine.device_and_dtype(), ("device:cuda", "FP16"))
            self.assertEqual(engine.device_and_dtype("cpu", "float32"), ("device:cpu", "FP32"))
            self.assertEqual(engine.device_and_dtype(dtype="bfloat16"), ("device:cuda", "BF16"))

    def test_the_module_imports_without_torch(self):
        self.assertNotIn("torch", sys.modules)
        self.assertFalse(engine.parser_off())
        with mock.patch.dict(os.environ, {"FASHN_PARSER": "off"}):
            self.assertTrue(engine.parser_off())


class SheetFolderTest(unittest.TestCase):
    def test_pairs_persons_with_garments_in_name_order(self):
        pairs, lonely = engine.pair_up([
            "tee-person.png", "tee-garment.jpg", "tee-category.txt",
            "coat-person.png", "coat-garment.webp",
            "jeans-person.png", "jeans-garment.png", "jeans-garment.jpg",
            "lonely-person.png", "sheet.png", "results.json", "tee-fashn.png",
        ])
        self.assertEqual(pairs, [("coat", "coat-garment.webp"), ("jeans", "jeans-garment.jpg"), ("tee", "tee-garment.jpg")])
        self.assertEqual(lonely, ["lonely"])

    def test_an_empty_folder_has_no_shots(self):
        self.assertEqual(engine.pair_up([]), ([], []))

    def test_shots_in_reads_the_files_it_finds(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            (folder / "hoodie-person.png").write_bytes(png())
            (folder / "hoodie-garment.png").write_bytes(png(colour=(10, 10, 200)))
            (folder / "hoodie-category.txt").write_text("bottoms\n")
            (folder / "hoodie-pose.json").write_text(json.dumps({"width": 300, "height": 450, "keypoints": []}))
            (folder / "alone-person.png").write_bytes(png())
            said = []
            shots = engine.shots_in(folder, say=said.append)
            self.assertEqual([s["name"] for s in shots], ["hoodie"])
            request = shots[0]["request"]
            self.assertEqual(request["category"], "bottoms")
            self.assertEqual(request["pose"]["width"], 300)
            self.assertIsNone(request["mask"])
            self.assertIsNone(request["outline"])
            self.assertEqual(base64.b64decode(request["garment"]), png(colour=(10, 10, 200)))
            self.assertEqual(shots[0]["garment_path"], str(folder / "hoodie-garment.png"))
            self.assertEqual(said, ["alone: no alone-garment.jpg, skipped"])

    def test_copy_suffixed_names_count_and_the_newest_copy_wins(self):
        self.assertEqual(engine.plain_name("tee-person (1).png"), "tee-person.png")
        self.assertEqual(engine.plain_name("tee-garment (12).jpg"), "tee-garment.jpg")
        self.assertEqual(engine.plain_name("tee (1)-person.png"), "tee (1)-person.png")
        self.assertEqual(engine.plain_name("tee-person.png"), "tee-person.png")
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            (folder / "tee-person (1).png").write_bytes(png())
            (folder / "tee-garment.jpg").write_bytes(png(colour=(1, 2, 3)))
            (folder / "tee-garment (1).jpg").write_bytes(png(colour=(200, 20, 20)))
            (folder / "tee-category (2).txt").write_text("bottoms")
            os.utime(folder / "tee-garment.jpg", (1_000_000, 1_000_000))
            os.utime(folder / "tee-garment (1).jpg", (2_000_000, 2_000_000))
            shots = engine.shots_in(folder, say=lambda *_: None)
            self.assertEqual([s["name"] for s in shots], ["tee"])
            request = shots[0]["request"]
            self.assertEqual(base64.b64decode(request["garment"]), png(colour=(200, 20, 20)))
            self.assertEqual(request["category"], "bottoms")
            self.assertEqual(shots[0]["garment_path"], str(folder / "tee-garment (1).jpg"))
            self.assertEqual(shots[0]["person_path"], str(folder / "tee-person (1).png"))
            self.assertEqual(base64.b64decode(request["person"]), png())
            # The older copy, made newer, wins instead.
            os.utime(folder / "tee-garment.jpg", (3_000_000, 3_000_000))
            self.assertEqual(engine.shots_in(folder, say=lambda *_: None)[0]["garment_path"], str(folder / "tee-garment.jpg"))

    def test_one_shot_names_itself_after_the_person_file(self):
        with tempfile.TemporaryDirectory() as folder:
            person, garment = os.path.join(folder, "render.png"), os.path.join(folder, "shop.png")
            pathlib.Path(person).write_bytes(png())
            pathlib.Path(garment).write_bytes(png())
            shot = engine.one_shot(person, garment, "tops")
            self.assertEqual(shot["name"], "render")
            self.assertEqual(shot["request"]["category"], "tops")
            self.assertIsNone(shot["request"]["print"])


class RequestTest(unittest.TestCase):
    def request(self, **extra):
        request = {"person": base64.b64encode(png()).decode(), "garment": base64.b64encode(png()).decode()}
        request.update(extra)
        return request

    def test_a_good_request_is_decoded_and_clamped(self):
        got = engine.parse_request(self.request(category="bottoms", seed=5, steps=99, mask=base64.b64encode(png(mode="L", colour=255)).decode()))
        self.assertEqual(got["person"].size, (300, 450))
        self.assertEqual(got["category"], "bottoms")
        self.assertEqual(got["steps"], 50)
        self.assertEqual(got["seed"], 5)
        self.assertEqual(got["pictures"]["mask"].mode, "L")
        self.assertFalse(got["flat_lay"])
        self.assertIsNone(got["pose"])

    def test_bad_requests_say_why(self):
        with self.assertRaisesRegex(ValueError, "invalid_category"):
            engine.parse_request(self.request(category="hats"))
        with self.assertRaisesRegex(ValueError, "^invalid$"):
            engine.parse_request({"person": "not base64 of a picture", "garment": ""})
        with self.assertRaisesRegex(ValueError, "^invalid$"):
            engine.parse_request({})

    def test_parser_off_forces_flat_lay(self):
        with mock.patch.dict(os.environ, {"FASHN_PARSER": "off"}):
            self.assertTrue(engine.parse_request(self.request())["flat_lay"])

    def test_paint_answers_without_a_model(self):
        self.assertEqual(engine.paint({}, None, self.request(), "fashn"), {"ok": False, "error": "model_not_loaded"})
        self.assertEqual(engine.paint({"fashn": object()}, None, {"person": "x"}, "fashn"), {"ok": False, "error": "invalid"})

    def test_paint_reports_a_models_failure_instead_of_raising(self):
        def broken(*_args, **_kwargs):
            raise RuntimeError("densepose_saw_no_person")

        with mock.patch.object(engine, "run_leffa", broken):
            answer = engine.paint({"leffa": object()}, None, self.request(), "leffa")
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["error"], "leffa_failed:RuntimeError")
        self.assertIn("seconds", answer)

    def test_fashn_paints_a_close_up_of_the_figure_and_it_goes_back_where_it_was_cut(self):
        stage = Image.new("RGB", (1280, 1000), (236, 233, 228))
        stage.paste((30, 30, 34), (500, 200, 620, 800))
        outline = Image.new("L", (1280, 1000), 0)
        outline.paste(255, (500, 200, 620, 800))

        def b64(picture):
            out = io.BytesIO()
            picture.save(out, format="PNG")
            return base64.b64encode(out.getvalue()).decode()

        seen = {}

        def fake_fashn(_pipe, person, *_args, **kwargs):
            seen["person"], seen["sharpen"] = person.size, kwargs.get("sharpen")
            return Image.new("RGB", person.size, (200, 20, 20))

        def fake_check(_checker, result, person, outline, *_args):
            seen["checked"], seen["outline"] = (result.size, person.size), outline.size
            return {"ok": True}

        request = {"person": b64(stage), "garment": base64.b64encode(png()).decode(), "outline": b64(outline)}
        with mock.patch.multiple(engine, run_fashn=fake_fashn, check=fake_check):
            answer = engine.paint({"fashn": object(), "upscaler": "sharp"}, None, request, "fashn")
        self.assertTrue(answer["ok"])
        width, height = seen["person"]
        self.assertAlmostEqual(width / height, 576 / 864, places=2)
        self.assertLess(height, 1000)
        self.assertEqual(seen["checked"], (seen["person"], seen["person"]))
        self.assertEqual(seen["outline"], seen["person"])
        self.assertEqual(seen["sharpen"], "sharp")
        back = Image.open(io.BytesIO(base64.b64decode(answer["image"])))
        self.assertEqual(back.size, (1280, 1000))
        self.assertEqual(back.convert("RGB").getpixel((560, 500)), (200, 20, 20))
        self.assertEqual(back.convert("RGB").getpixel((40, 40)), (236, 233, 228))

        with mock.patch.multiple(engine, run_fashn=fake_fashn, check=fake_check):
            engine.paint({"fashn": object()}, None, {**request, "close_up": False}, "fashn")
        self.assertEqual(seen["person"], (1280, 1000))


class WordsTest(unittest.TestCase):
    def test_a_failure_is_captioned(self):
        self.assertEqual(engine.words({"ok": False, "error": "fashn_failed:X", "seconds": 3.2}), "failed: fashn_failed:X\n3.2 s")

    def test_checks_are_three_lines(self):
        checks = {
            "shape": {"score": 0.91, "pass": True},
            "identity": {"score": 0.85, "colour": 4.2, "pass": True},
            "print": {"skipped": True},
            "ok": True,
        }
        lines = engine.words({"ok": True, "checks": checks, "seconds": 12.0}).split("\n")
        self.assertEqual(lines, ["shape 0.91 ok · look 0.85 colour 4.2 ok", "print skipped", "12.0 s · PASS"])


class WriteSheetTest(unittest.TestCase):
    def test_writes_pictures_sheet_and_results(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            (folder / "tee-person.png").write_bytes(png())
            (folder / "tee-garment.jpg").write_bytes(png())
            shots = engine.shots_in(folder)
            checks = {"shape": {"score": 0.9, "pass": True}, "identity": {"score": 0.9, "colour": 1.0, "pass": True}, "print": {"skipped": True}, "ok": True}
            answers = {"tee": {
                "fashn": {"ok": True, "image": base64.b64encode(png(colour=(0, 255, 0))).decode(), "checks": checks, "seconds": 1.0},
                "leffa": {"ok": False, "error": "leffa_failed:RuntimeError", "seconds": 0.5},
                "wall_seconds": 2.0,
            }}
            sheet, results = engine.write_sheet(shots, answers, folder / "out")
            self.assertTrue(sheet.exists())
            self.assertTrue((folder / "out" / "tee-fashn.png").exists())
            self.assertFalse((folder / "out" / "tee-leffa.png").exists())
            written = json.loads(results.read_text())
            self.assertEqual(written["tee"]["wall_seconds"], 2.0)
            self.assertEqual(written["tee"]["category"], "tops")
            self.assertNotIn("image", written["tee"]["fashn"])
            self.assertEqual(written["tee"]["leffa"]["error"], "leffa_failed:RuntimeError")


class RunSheetTest(unittest.TestCase):
    """run_sheet end to end with fake models: the loaders, the two run_* functions and the validator's two
    models are stood in for, so the folder handling, the gates and the written files are the real code."""

    def test_runs_each_model_once_over_every_shot_and_writes_the_sheet(self):
        import validate

        pictures, masks = validate.synthetic()
        loads, frees = [], []

        class FakeChecker:
            cutout = staticmethod(validate.fake_cutout)
            embed = staticmethod(validate.fake_embed)

        def fake_load(which):
            def load(*_args, **_kwargs):
                loads.append(which)
                return which
            return load

        def fake_run(model, person, garment, category, **_kwargs):
            if model == "leffa":
                raise RuntimeError("densepose_saw_no_person")
            return pictures["render"]  # the render itself, so every gate passes

        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            for name in ("a", "b"):
                pictures["render"].save(folder / f"{name}-person.png")
                pictures["shop"].save(folder / f"{name}-garment.jpg")
                masks["figure"].save(folder / f"{name}-outline.png")
                masks["top"].save(folder / f"{name}-mask.png")
            with mock.patch.multiple(engine, load_fashn=fake_load("fashn"), load_leffa=fake_load("leffa"), load_checker=lambda *a, **k: FakeChecker(),
                                     run_fashn=fake_run, run_leffa=fake_run, free_memory=lambda: frees.append(1)):
                results = engine.run_sheet(folder, out=folder / "out", flat_lay=True, say=lambda *_: None)
            self.assertEqual(loads, ["fashn", "leffa"])
            self.assertEqual(len(frees), 2)
            written = json.loads(pathlib.Path(results).read_text())
            self.assertEqual(sorted(written), ["a", "b"])
            self.assertTrue(written["a"]["fashn"]["ok"])
            self.assertTrue(written["a"]["fashn"]["checks"]["shape"]["pass"])
            self.assertEqual(written["a"]["leffa"]["error"], "leffa_failed:RuntimeError")
            self.assertIsInstance(written["a"]["wall_seconds"], float)
            self.assertTrue((folder / "out" / "sheet.png").exists())
            self.assertTrue((folder / "out" / "b-fashn.png").exists())
            self.assertFalse((folder / "out" / "b-leffa.png").exists())

    def test_refuses_an_unknown_model_or_an_empty_folder(self):
        with self.assertRaises(ValueError):
            engine.run_sheet("/nowhere", models=("dalle",))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                engine.run_sheet(folder, models="fashn", say=lambda *_: None)


if __name__ == "__main__":
    unittest.main()
