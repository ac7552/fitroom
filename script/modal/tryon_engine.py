"""The try-on spike's engine: loads and runs the two models and the validator on whatever GPU (or CPU) is
there, with no Modal in it, so the same code runs on Modal (tryon_spike.py) and in a Google Colab notebook
(script/colab/fitroom_tryon_spike.ipynb) on a free T4.

    from tryon_engine import run_sheet
    run_sheet("tmp/spike", models=("fashn", "leffa"), flat_lay=True)
    # -> NAME-fashn.png, NAME-leffa.png, sheet.png, results.json in the folder

Device and dtype follow the hardware (`device_and_dtype`): CUDA with bf16 on Ampere and newer (an L4, an
A100), CUDA with fp16 on older cards (Colab's T4 has no bf16), fp32 on a CPU or Apple's MPS. Each loader
takes the device and dtype so a test can pass fakes.

The models and what the comments point at are described in tryon_spike.py's docstring and docs/ai-spike.md.
The helpers that need no model live in tryon_prep.py; the three gates in validate.py. The pure functions
here (`pick_device`, `pair_up`, `words`) are tested in test_tryon_engine.py without torch.
"""

import base64
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tryon_prep import contact_sheet, dwpose_from_openpose, grow, letterbox, png_bytes, unletterbox  # noqa: E402

FASHN_REPO = "https://github.com/fashn-AI/fashn-vton-1.5"
FASHN_COMMIT = "7c0f10af3f91ad4048fe9729c470a13ef905d25a"
LEFFA_REPO = "https://github.com/franciszzj/Leffa"
LEFFA_COMMIT = "05a259104b6927607776c7edb3e86b75406f20aa"
LEFFA_DIR = os.environ.get("LEFFA_DIR", "/opt/leffa")
WEIGHTS = os.environ.get("TRYON_WEIGHTS", "/weights")
DINO = "facebook/dinov2-small"
CUTOUT = "ZhengPeng7/BiRefNet"

# What download() fetches of franciszzj/Leffa. The try-on needs virtual_tryon.pth (every weight of the VAE
# and both UNets: leffa/model.py builds them `from_config` and load_state_dict's the whole thing), the
# configs under stable-diffusion-inpainting (scheduler/, vae/, unet/: only *.json is read), DensePose's
# config and weights, and, for Leffa's own mask path, the SCHP parsers and OpenPose's body model.
LEFFA_PATTERNS = (
    "virtual_tryon.pth",
    "stable-diffusion-inpainting/*.json",
    "densepose/*",
    "humanparsing/*",
    "openpose/*",
)

CATEGORIES = ("tops", "bottoms")
LEFFA_GARMENT_TYPE = {"tops": "upper_body", "bottoms": "lower_body"}  # app.py's vt_garment_type
MASK_GROW = 0.012  # of the picture's height, each way, before Leffa inpaints
GARMENT_EXTENSIONS = ("jpg", "jpeg", "png", "webp")


def parser_off():
    """FASHN_PARSER=off: run FASHN without fashn-human-parser (research-only licence, see docs/ai-spike.md)."""
    return os.environ.get("FASHN_PARSER") == "off"


# Device ---------------------------------------------------------------------------------------------------

def pick_device(cuda=False, capability=None, mps=False):
    """(device, dtype name) for the hardware described: cuda + bf16 from Ampere (compute capability 8.0) up,
    cuda + fp16 before that (a T4 is 7.5), else fp32 on mps or the cpu. Pure, so it can be tested without a GPU."""
    if cuda:
        return "cuda", "bfloat16" if tuple(capability or (0, 0)) >= (8, 0) else "float16"
    if mps:
        return "mps", "float32"
    return "cpu", "float32"


def device_and_dtype(device=None, dtype=None):
    """The torch device and dtype to run on, from `pick_device` unless given (strings or torch objects)."""
    import torch

    if device is None or dtype is None:
        cuda = torch.cuda.is_available()
        mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
        chosen_device, chosen_dtype = pick_device(cuda, torch.cuda.get_device_capability() if cuda else None, mps)
        device = device or chosen_device
        dtype = dtype or chosen_dtype
    if isinstance(dtype, str):
        dtype = getattr(torch, dtype)
    return torch.device(device), dtype


def free_memory():
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


# Downloading -----------------------------------------------------------------------------------------------

def download(weights=WEIGHTS, models=("fashn", "leffa"), checker=True):
    """Fetches the weights into `weights` (Modal does this while the image is built; Colab in a cell)."""
    from huggingface_hub import hf_hub_download, snapshot_download

    if "fashn" in models:
        # FASHN: scripts/download_weights.py in the repo, done here with the same repo ids and file names.
        hf_hub_download("fashn-ai/fashn-vton-1.5", "model.safetensors", local_dir=f"{weights}/fashn")
        for name in ("yolox_l.onnx", "dw-ll_ucoco_384.onnx"):
            hf_hub_download("fashn-ai/DWPose", name, local_dir=f"{weights}/fashn/dwpose")
        if not parser_off():
            from fashn_human_parser import FashnHumanParser

            FashnHumanParser(device="cpu")  # caches its weights under HF_HOME, as the repo's script does
    if "leffa" in models:
        # Leffa: app.py downloads the whole franciszzj/Leffa repo into ./ckpts; only the try-on parts are taken.
        snapshot_download("franciszzj/Leffa", local_dir=f"{weights}/leffa", allow_patterns=list(LEFFA_PATTERNS))
    if checker:
        from transformers import AutoImageProcessor, AutoModel, AutoModelForImageSegmentation

        AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True)
        AutoImageProcessor.from_pretrained(DINO)
        AutoModel.from_pretrained(DINO)


# FASHN ----------------------------------------------------------------------------------------------------

class GivenPose:
    """Stands in for `pipeline.pose_model` (a DWposeDetector, src/fashn_vton/dwpose/dwpose.py) for one call.
    TryOnPipeline.__call__ (src/fashn_vton/pipeline.py) asks the detector for the person's pose first and
    the garment's second, so the first picture gets the page's keypoints and any other goes to DWPose."""

    def __init__(self, detector, pose):
        self.detector, self.pose, self.used = detector, pose, False

    def __call__(self, picture, single=True):
        if not self.used:
            self.used = True
            return self.pose
        return self.detector(picture, single=single)


class NoParser:
    """Stands in for FashnHumanParser when FASHN_PARSER=off: a blank parse. The pipeline ignores the parse
    when `segmentation_free=True` (create_clothing_agnostic_image, src/fashn_vton/preprocessing/agnostic.py:
    `if disable_masking: return img_np`) and the garment is 'flat-lay' (create_garment_image likewise), so
    nothing is lost but the choice of 'model' garment photos."""

    def predict(self, picture):
        import numpy as np

        return np.zeros(picture.shape[:2], dtype=np.int64)


def load_fashn(weights_dir=f"{WEIGHTS}/fashn", device=None, dtype=None):
    """FASHN's TryOnPipeline on `device` in `dtype`. The pipeline picks bf16 by itself whenever
    `torch.cuda.is_bf16_supported()` says yes, which on a T4 is emulation (slow), so the dtype is set before
    the weights are cast (pipeline.py: __init__ sets inference_dtype, then _setup_tryon_model casts to it).
    With FASHN_PARSER=off the parser is never built (pipeline.py: _setup_hp_model)."""
    import torch  # noqa: F401 - first, so onnxruntime-gpu finds the CUDA libraries torch ships
    from fashn_vton import TryOnPipeline

    device, dtype = device_and_dtype(device, dtype)

    class Pipeline(TryOnPipeline):
        def _setup_tryon_model(self):
            self.inference_dtype = dtype
            super()._setup_tryon_model()

        def _setup_hp_model(self):
            if parser_off():
                self.hp_model = NoParser()
            else:
                super()._setup_hp_model()

    return Pipeline(weights_dir=weights_dir, device=str(device))


def run_fashn(pipe, person, garment, category, *, flat_lay=False, seed=7, steps=30, pose_json=None):
    """One FASHN try-on. pose_json: the page's keypoints (see tryon_prep.dwpose_from_openpose), or None to
    let DWPose look for a person in the render. Returns the picture at the render's size."""
    from PIL import Image

    flat_lay = flat_lay or parser_off()
    detector = pipe.pose_model
    if pose_json is not None:
        pipe.pose_model = GivenPose(detector, dwpose_from_openpose(pose_json))
    try:
        out = pipe(
            person_image=person.convert("RGB"),
            garment_image=garment.convert("RGB"),
            category=category,
            garment_photo_type="flat-lay" if flat_lay else "model",
            num_timesteps=steps,
            seed=seed,
            segmentation_free=True,
        )
    finally:
        pipe.pose_model = detector
    return out.images[0].resize(person.size, Image.LANCZOS)


# Leffa ----------------------------------------------------------------------------------------------------

class Leffa:
    """Leffa's virtual try-on as app.py's LeffaPredictor.leffa_predict does it, without Gradio and with the
    mask optionally given by the page."""

    def __init__(self, ckpts, dtype):
        import torch
        from leffa.inference import LeffaInference
        from leffa.model import LeffaModel
        from leffa.transform import LeffaTransform
        from leffa_utils.densepose_predictor import DensePosePredictor

        self.ckpts = ckpts
        # leffa_utils/densepose_predictor.py: detectron2's DefaultPredictor on the R50-FPN DensePose weights
        # (cfg.MODEL.DEVICE is cuda when there is one, else cpu: Leffa's code picks the device itself, here
        # and in LeffaInference below, so only the dtype is ours to choose).
        self.densepose = DensePosePredictor(
            config_path=f"{ckpts}/densepose/densepose_rcnn_R_50_FPN_s1x.yaml",
            weights_path=f"{ckpts}/densepose/model_final_162be9.pkl",
        )
        # The weights are loaded here and not by LeffaModel (leffa/model.py: `self.load_state_dict(torch.load(
        # pretrained_model, map_location="cpu"))` after building the fp32 modules), so the fp32 state dict
        # (some GB) is memory-mapped and copied into an already half-precision model: on Colab's 12 GB of RAM
        # the two fp32 copies side by side would not fit.
        model = LeffaModel(pretrained_model_name_or_path=f"{ckpts}/stable-diffusion-inpainting", pretrained_model="", dtype="float32")
        if dtype == torch.float16:
            model.half()
        try:
            state = torch.load(f"{ckpts}/virtual_tryon.pth", map_location="cpu", mmap=True, weights_only=True)
        except (TypeError, RuntimeError):  # an old torch, or a checkpoint in the old (non-zip) format
            state = torch.load(f"{ckpts}/virtual_tryon.pth", map_location="cpu")
        model.load_state_dict(state)
        del state
        # leffa/inference.py: LeffaInference moves the model to cuda when there is one, else the cpu.
        self.inference = LeffaInference(model=model)
        self.transform = LeffaTransform()
        self.parsing = self.openpose = None

    def agnostic_mask(self, src, category):
        """Leffa's own mask when the page gave none: SCHP parsing + OpenPose -> get_agnostic_mask_hd
        (leffa_utils/utils.py), at 384x512 as app.py does, then up to the frame."""
        if self.parsing is None:
            from preprocess.humanparsing.run_parsing import Parsing
            from preprocess.openpose.run_openpose import OpenPose

            self.parsing = Parsing(atr_path=f"{self.ckpts}/humanparsing/parsing_atr.onnx", lip_path=f"{self.ckpts}/humanparsing/parsing_lip.onnx")
            self.openpose = OpenPose(body_model_path=f"{self.ckpts}/openpose/body_pose_model.pth")
        from leffa_utils.utils import get_agnostic_mask_hd

        small = src.resize((384, 512))
        parse, _ = self.parsing(small)
        keypoints = self.openpose(small)
        return get_agnostic_mask_hd(parse, keypoints, LEFFA_GARMENT_TYPE[category]).resize((768, 1024))

    def __call__(self, person, garment, category, mask=None, seed=7, steps=30, scale=2.5):
        import numpy as np
        from PIL import Image

        src, box = letterbox(person.convert("RGB"), 768, 1024, (255, 255, 255))
        ref, _ = letterbox(garment.convert("RGB"), 768, 1024, (255, 255, 255))
        if mask is not None:
            grown = grow(mask.resize(person.size), round(person.height * MASK_GROW))
            agnostic = letterbox(grown, 768, 1024, 0)[0]
        else:
            agnostic = self.agnostic_mask(src, category)
        # app.py, virtual_tryon + viton_hd: the fine-segmentation picture, channels flipped.
        dense = Image.fromarray(self.densepose.predict_seg(np.array(src))[:, :, ::-1])
        if not dense.getbbox():
            raise RuntimeError("densepose_saw_no_person")
        data = self.transform({"src_image": [src], "ref_image": [ref], "mask": [agnostic], "densepose": [dense]})
        out = self.inference(data, ref_acceleration=False, num_inference_steps=steps, guidance_scale=scale, seed=seed, repaint=False)
        return unletterbox(out["generated_image"][0], box, person.size)


def load_leffa(leffa_dir=LEFFA_DIR, weights_dir=f"{WEIGHTS}/leffa", device=None, dtype=None):
    """Leffa from a checkout at `leffa_dir` (put on sys.path: it isn't a package) and its weights. fp16 on
    CUDA, fp32 elsewhere (SD 1.5's UNet runs in fp16 everywhere; bf16 isn't what the checkpoint was made for)."""
    import torch

    if leffa_dir and leffa_dir not in sys.path:
        sys.path.insert(0, leffa_dir)
    device, _ = device_and_dtype(device, dtype)
    return Leffa(weights_dir, torch.float16 if device.type == "cuda" else torch.float32)


def run_leffa(leffa, person, garment, category, *, mask=None, seed=7, steps=30, scale=2.5):
    """One Leffa try-on. mask: the garment's region in the render (white on black) or None for Leffa's own
    parser and OpenPose. Returns the picture at the render's size."""
    return leffa(person, garment, category, mask=mask, seed=seed, steps=steps, scale=scale)


# The validator ---------------------------------------------------------------------------------------------

class Checker:
    """The validator's two models, loaded on first use: BiRefNet for the figure's cut-out, DINOv2 (small)
    for the likeness. fp16 on CUDA, fp32 elsewhere. `cutout` and `embed` fit validate.validate's arguments."""

    def __init__(self, device=None):
        self.device = device
        self._birefnet = self._dino = None

    def _device(self):
        if self.device is None:
            self.device, _ = device_and_dtype()
        return self.device

    def cutout(self, picture):
        """The figure cut out of a picture with BiRefNet: a greyscale PIL picture, white where the figure is."""
        import numpy as np
        import torch
        from PIL import Image

        device = self._device()
        half = device.type == "cuda"
        if self._birefnet is None:
            from transformers import AutoModelForImageSegmentation

            model = AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True).to(device).eval()
            self._birefnet = model.half() if half else model
        x = np.asarray(picture.convert("RGB").resize((1024, 1024), Image.BILINEAR), dtype=np.float32) / 255.0
        x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        tensor = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device, torch.float16 if half else torch.float32)
        with torch.no_grad():
            alpha = self._birefnet(tensor)[-1].sigmoid()[0, 0].float().cpu().numpy()
        return Image.fromarray((alpha * 255).astype("uint8")).resize(picture.size, Image.BILINEAR)

    def embed(self, picture):
        """A DINOv2 (small) embedding of a picture: the CLS token."""
        import torch

        device = self._device()
        if self._dino is None:
            from transformers import AutoImageProcessor, AutoModel

            self._dino = (AutoImageProcessor.from_pretrained(DINO), AutoModel.from_pretrained(DINO).to(device).eval())
        processor, model = self._dino
        with torch.no_grad():
            inputs = processor(images=picture.convert("RGB"), return_tensors="pt").to(device)
            return model(**inputs).last_hidden_state[0, 0].float().cpu().numpy()


def load_checker(device=None):
    """The validator's models, lazily (nothing is loaded until the first check)."""
    return Checker(device)


def check(checker, result, person, outline, garment, garment_mask, category, print_mask, flat_lay):
    """The three gates on one result. Without an outline from the page, the render's own cut-out stands
    in; without a garment mask, a band of the figure by category (tryon_prep's inputs say which)."""
    import validate as v

    outline_mask = v.as_mask(outline, person.size) if outline is not None else v.as_mask(checker.cutout(person), person.size)
    in_result = v.as_mask(garment_mask, person.size) if garment_mask is not None else v.band_mask(outline_mask, category)
    shop_cut = v.as_mask(checker.cutout(garment), garment.size)
    in_shop = shop_cut if flat_lay else v.band_mask(shop_cut, category)
    return v.validate(outline_mask, result, garment, in_result, in_shop, print_mask, cutout=checker.cutout, embed=checker.embed)


# One request -----------------------------------------------------------------------------------------------

def parse_request(request):
    """The pictures and numbers out of a request ({person, garment: base64; category; mask?, outline?, print?:
    base64 PNG; pose?; seed?; steps?; flat_lay?}). Raises ValueError on bad input."""
    from silhouette import load

    try:
        person = load(base64.b64decode(request["person"]))
        garment = load(base64.b64decode(request["garment"]))
        category = str(request.get("category", "tops"))
        pictures = {}
        for name in ("mask", "outline", "print"):
            if request.get(name):
                pictures[name] = load(base64.b64decode(request[name]), "L")
        seed = int(request.get("seed", 7)) % 2**31
        steps = max(10, min(50, int(request.get("steps", 30))))
        flat_lay = bool(request.get("flat_lay", False)) or parser_off()
        pose = request.get("pose") or None
    except (KeyError, ValueError, TypeError) as error:
        raise ValueError("invalid") from error
    if category not in CATEGORIES:
        raise ValueError("invalid_category")
    return {"person": person, "garment": garment, "category": category, "pictures": pictures, "seed": seed, "steps": steps, "flat_lay": flat_lay, "pose": pose}


def paint(models, checker, request, which):
    """Runs one model (`models`: {"fashn": pipe, "leffa": Leffa}) and the gates on a request. Returns
    {ok, image?: base64 PNG, seconds, checks?, error?}; never raises."""
    try:
        got = parse_request(request)
    except ValueError as error:
        return {"ok": False, "error": str(error)}
    model = models.get(which)
    if model is None:
        return {"ok": False, "error": "model_not_loaded"}

    began = time.perf_counter()
    try:
        if which == "fashn":
            result = run_fashn(model, got["person"], got["garment"], got["category"], flat_lay=got["flat_lay"], seed=got["seed"], steps=got["steps"], pose_json=got["pose"])
        else:
            result = run_leffa(model, got["person"], got["garment"], got["category"], mask=got["pictures"].get("mask"), seed=got["seed"], steps=got["steps"])
    except Exception as error:  # noqa: BLE001 - the model's own failure is the answer, not a crash
        return {"ok": False, "error": f"{which}_failed:{type(error).__name__}", "seconds": round(time.perf_counter() - began, 1)}
    painted = time.perf_counter() - began

    pictures = got["pictures"]
    checks = check(checker, result, got["person"], pictures.get("outline"), got["garment"], pictures.get("mask"), got["category"], pictures.get("print"), got["flat_lay"])
    return {
        "ok": checks["ok"],
        "image": base64.b64encode(png_bytes(result)).decode(),
        "checks": checks,
        "seconds": round(painted, 1),
        "check_seconds": round(time.perf_counter() - began - painted, 1),
    }


# The sheet -------------------------------------------------------------------------------------------------

def read_b64(path):
    return base64.b64encode(pathlib.Path(path).read_bytes()).decode() if path and os.path.exists(path) else None


def pair_up(filenames):
    """The sheet's names from a folder's file names: each NAME with a NAME-person.png and a NAME-garment.jpg
    (or .jpeg/.png/.webp; the first by that order). Returns [(name, garment file)] sorted by name, and the
    names that had a person but no garment. Pure, for the tests."""
    names = set(filenames)
    pairs, lonely = [], []
    for filename in sorted(names):
        if not filename.endswith("-person.png"):
            continue
        name = filename[: -len("-person.png")]
        garment = next((f"{name}-garment.{ext}" for ext in GARMENT_EXTENSIONS if f"{name}-garment.{ext}" in names), None)
        (pairs if garment else lonely).append((name, garment) if garment else name)
    return pairs, lonely


def shots_in(folder, say=print):
    """The sheet's inputs: NAME-person.png, NAME-garment.(jpg|png|webp), NAME-category.txt, and optional
    NAME-mask.png (the garment in the render), NAME-outline.png (the figure), NAME-print.png (the print
    region in the shop photo, or the page's print.image), NAME-pose.json (keypoints for FASHN)."""
    folder = pathlib.Path(folder)
    pairs, lonely = pair_up(p.name for p in folder.iterdir() if p.is_file())
    for name in lonely:
        say(f"{name}: no {name}-garment.jpg, skipped")
    shots = []
    for name, garment in pairs:
        category_file = folder / f"{name}-category.txt"
        pose_file = folder / f"{name}-pose.json"
        shots.append({
            "name": name,
            "request": {
                "person": read_b64(str(folder / f"{name}-person.png")),
                "garment": read_b64(str(folder / garment)),
                "category": category_file.read_text().strip() if category_file.exists() else "tops",
                "mask": read_b64(str(folder / f"{name}-mask.png")),
                "outline": read_b64(str(folder / f"{name}-outline.png")),
                "print": read_b64(str(folder / f"{name}-print.png")),
                "pose": json.loads(pose_file.read_text()) if pose_file.exists() else None,
            },
            "garment_path": str(folder / garment),
            "person_path": str(folder / f"{name}-person.png"),
        })
    return shots


def one_shot(person, garment, category="tops", mask="", outline="", print_mask="", pose_json=""):
    """A single pair of files as a shot, like shots_in makes."""
    return {
        "name": pathlib.Path(person).stem,
        "request": {
            "person": read_b64(person), "garment": read_b64(garment), "category": category,
            "mask": read_b64(mask), "outline": read_b64(outline), "print": read_b64(print_mask),
            "pose": json.loads(pathlib.Path(pose_json).read_text()) if pose_json else None,
        },
        "garment_path": garment, "person_path": person,
    }


def words(answer):
    """A caption for the sheet: the gates and the time, or why the model failed."""
    import validate

    if not answer.get("checks"):
        return f"failed: {answer.get('error', '?')}\n{answer.get('seconds', '-')} s"
    checks = answer["checks"]
    shape, look, printed = validate.words_for(checks).split(" · ")
    return f"{shape} · {look}\n{printed}\n{answer['seconds']} s · {'PASS' if checks['ok'] else 'REFUSED'}"


def write_sheet(shots, answers, out_dir):
    """NAME-fashn.png, NAME-leffa.png, sheet.png and results.json from each shot's answers
    ({name: {"fashn": answer, "leffa": answer}}), as the Modal spike writes them."""
    from PIL import Image

    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, results = [], {}
    for shot in shots:
        name = shot["name"]
        row = {"name": name, "shop": Image.open(shot["garment_path"]), "render": Image.open(shot["person_path"])}
        results[name] = {"wall_seconds": answers[name].pop("wall_seconds", None), "category": shot["request"]["category"]}
        for which, answer in answers[name].items():
            if answer.get("image"):
                path = out_dir / f"{name}-{which}.png"
                path.write_bytes(base64.b64decode(answer["image"]))
                row[which] = Image.open(path)
            row[f"{which}_words"] = words(answer)
            results[name][which] = {k: v for k, v in answer.items() if k != "image"}
        rows.append(row)
    if rows:
        contact_sheet(rows).save(out_dir / "sheet.png")
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))
    return out_dir / "sheet.png", out_dir / "results.json"


def run_shots(shots, models=("fashn", "leffa"), *, seed=7, steps=30, flat_lay=False, weights=WEIGHTS, leffa_dir=LEFFA_DIR, say=print):
    """Every shot through each model in turn, one model loaded at a time (a T4's 15 GB holds either model and
    the validator, not both at once), then the gates. Returns {name: {"fashn": answer, "leffa": answer}}."""
    checker = load_checker()
    answers = {shot["name"]: {} for shot in shots}
    for which in models:
        say(f"loading {which}...")
        began = time.time()
        loaded = load_fashn(f"{weights}/fashn") if which == "fashn" else load_leffa(leffa_dir, f"{weights}/leffa")
        say(f"{which} loaded in {round(time.time() - began)} s")
        for shot in shots:
            request = {k: v for k, v in shot["request"].items() if v is not None}
            request.update(seed=seed, flat_lay=flat_lay, steps=steps)
            began = time.time()
            answer = paint({which: loaded}, checker, request, which)
            answers[shot["name"]][which] = answer
            answers[shot["name"]]["wall_seconds"] = round(answers[shot["name"]].get("wall_seconds", 0) + time.time() - began, 1)
            say(f"{shot['name']} {which}: {answer.get('error') or ('PASS' if answer['ok'] else 'REFUSED')} {answer.get('seconds', '-')} s")
        del loaded
        free_memory()
    return answers


def run_sheet(folder, models=("fashn", "leffa"), *, out=None, seed=7, steps=30, flat_lay=False, weights=WEIGHTS, leffa_dir=LEFFA_DIR, say=print):
    """A folder of inputs (see shots_in) -> NAME-fashn.png, NAME-leffa.png, sheet.png and results.json in
    `out` (default: the folder itself). models: ("fashn", "leffa"), ("fashn",) or ("leffa",)."""
    models = (models,) if isinstance(models, str) else tuple(models)
    for which in models:
        if which not in ("fashn", "leffa"):
            raise ValueError(f"unknown model {which!r}: fashn or leffa")
    shots = shots_in(folder, say)
    if not shots:
        raise FileNotFoundError(f"no NAME-person.png with a NAME-garment.jpg in {folder}")
    answers = run_shots(shots, models, seed=seed, steps=steps, flat_lay=flat_lay, weights=weights, leffa_dir=leffa_dir, say=say)
    sheet, results = write_sheet(shots, answers, out or folder)
    say(f"wrote {sheet} and {results}")
    return results
