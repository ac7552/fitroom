"""The try-on service's job endpoints' pure parts, and the engine's CPU-to-GPU move with fakes:
python3 -m unittest script/modal/test_tryon_jobs.py"""

import importlib
import os
import subprocess
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import tryon_engine as engine  # noqa: E402
import tryon_jobs as jobs  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class OutputExpiredError(Exception):  # stands in for modal.exception.OutputExpiredError (not a built-in TimeoutError)
    pass


class FunctionTimeoutError(Exception):  # likewise modal.exception.FunctionTimeoutError
    pass


class CallIdTest(unittest.TestCase):
    def test_modal_call_ids_pass_and_anything_else_does_not(self):
        self.assertTrue(jobs.valid_id("fc-01JABCDEF0123456789abcdefXYZ"))
        for bad in ("", "fc-", "in-0123", "fc-../../etc", "fc-abc def", None, 12, "fc-" + "a" * 65):
            self.assertFalse(jobs.valid_id(bad), bad)


class StartBodyTest(unittest.TestCase):
    def test_a_wake_up(self):
        self.assertEqual(jobs.start_body({"warm": True}), ("warm", None))

    def test_a_picture_keeps_only_the_fields_the_engine_reads(self):
        kind, request = jobs.start_body({"person": "AAA", "garment": "BBB", "category": "tops", "steps": 20, "extra": "x"})
        self.assertEqual(kind, "paint")
        self.assertEqual(request, {"person": "AAA", "garment": "BBB", "category": "tops", "steps": 20})

    def test_no_pictures_or_no_object_is_invalid(self):
        for body in (None, [], "x", {}, {"person": "AAA"}, {"person": 1, "garment": "B"}):
            self.assertEqual(jobs.start_body(body), ("invalid", None), body)


class OutcomeTest(unittest.TestCase):
    def test_pending_is_a_202_with_the_phase(self):
        self.assertEqual(jobs.outcome(error=TimeoutError()), (202, {"status": "pending", "phase": "starting"}))
        self.assertEqual(jobs.outcome(error=TimeoutError(), phase="painting"), (202, {"status": "pending", "phase": "painting"}))
        self.assertEqual(jobs.outcome(error=TimeoutError(), phase="odd"), (202, {"status": "pending", "phase": "starting"}))

    def test_a_passed_picture_comes_back_whole(self):
        status, body = jobs.outcome({"ok": True, "image": "PNG", "checks": {"ok": True}, "seconds": 12.0})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "image": "PNG", "checks": {"ok": True}, "seconds": 12.0, "status": "done"})

    def test_a_refused_picture_comes_back_without_its_image(self):
        status, body = jobs.outcome({"ok": False, "image": "PNG", "checks": {"ok": False}})
        self.assertEqual(status, 200)
        self.assertNotIn("image", body)
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["checks"], {"ok": False})

    def test_failures_are_answers(self):
        self.assertEqual(jobs.outcome(error=OutputExpiredError()), (410, {"status": "failed", "error": "expired"}))
        self.assertEqual(jobs.outcome(error=FunctionTimeoutError()), (200, {"status": "failed", "error": "timeout"}))
        self.assertEqual(jobs.outcome(error=RuntimeError("boom")), (200, {"status": "failed", "error": "RuntimeError"}))

    def test_a_non_answer_is_a_refusal_not_a_crash(self):
        self.assertEqual(jobs.outcome(None), (200, {"ok": False, "error": "no_answer", "status": "done"}))


class Device:
    def __init__(self, kind):
        self.type = kind


class FakeModule:
    def __init__(self):
        self.device, self.precision = None, "float"

    def to(self, device):
        self.device = device
        return self

    def half(self):
        self.precision = "half"
        return self

    def float(self):
        self.precision = "float"
        return self


class MoveTest(unittest.TestCase):
    def test_the_pipeline_moves_and_builds_its_pose_detector_there(self):
        built = []
        pipe = types.SimpleNamespace(tryon_model=FakeModule(), device=Device("cpu"), pose_model=None)
        pipe._setup_pose_model = lambda: built.append((pipe.device.type, getattr(pipe, "pose_now", False)))
        gpu = Device("cuda")

        engine.move_fashn(pipe, gpu)

        self.assertIs(pipe.tryon_model.device, gpu)
        self.assertIs(pipe.device, gpu)
        self.assertEqual(built, [("cuda", True)])

    def test_the_checker_moves_birefnet_in_half_precision_and_dino_as_is(self):
        checker = engine.Checker(Device("cpu"))
        checker._birefnet, dino = FakeModule(), FakeModule()
        checker._dino = ("processor", dino)
        gpu = Device("cuda")

        checker.move(gpu)

        self.assertIs(checker.device, gpu)
        self.assertEqual((checker._birefnet.device, checker._birefnet.precision), (gpu, "half"))
        self.assertEqual(checker._dino, ("processor", dino))
        self.assertIs(dino.device, gpu)

    def test_an_unloaded_checker_only_changes_device(self):
        checker = engine.Checker(Device("cpu")).move(Device("cuda"))
        self.assertIsNone(checker._birefnet)
        self.assertEqual(checker.device.type, "cuda")


@unittest.skipIf(importlib.util.find_spec("modal") is None, "the modal client isn't installed")
class ServiceTest(unittest.TestCase):
    def run_python(self, code, **env):
        return subprocess.run([sys.executable, "-c", code], cwd=HERE, env={**os.environ, **env}, capture_output=True, text=True)

    def test_it_defines_the_jobs_app_the_gpu_class_and_the_weights_entrypoint_in_every_snapshot_mode(self):
        for mode in ("cpu", "gpu", "off"):
            done = self.run_python("import tryon_service as s; print(sorted(s.app.registered_functions))", TRYON_SNAPSHOT=mode)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("jobs", done.stdout)
            self.assertIn("TryOn.*", done.stdout)
            self.assertIn("fill_weights", done.stdout)

    def test_the_jobs_app_imports_without_the_engine(self):
        # Its image has only FastAPI and tryon_jobs: importing the module there mustn't need torch or numpy.
        code = (
            "import sys\n"
            "class Block:\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name in ('tryon_engine', 'tryon_prep', 'numpy', 'PIL'): raise ImportError(name)\n"
            "sys.meta_path.insert(0, Block())\n"
            "import tryon_service as s\n"
            "assert s.engine is None\n"
        )
        done = self.run_python(code)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == "__main__":
    unittest.main()
