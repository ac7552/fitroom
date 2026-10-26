"""Fitroom's own try-on on Modal: two open-source models paint the shop's photo of a garment onto the page's
mannequin render, and the three-gate validator (validate.py) decides whether the page may show the result.

The spike runs both models on the same inputs and writes a contact sheet to compare them:

    modal run script/modal/tryon_spike.py::spike --sheet tmp/spike
    modal run script/modal/tryon_spike.py::spike --person render.png --garment shop.jpg --category tops --out tmp/out

The service is the same code behind one endpoint, `tryon`, for the Rails server (app/models/try_on.rb):
    modal deploy script/modal/tryon_spike.py
then a Modal proxy auth token's URL, key and secret go in .env as FITROOM_TRYON_URL/_KEY/_SECRET.

Only the mannequin's render and the shop's photo come in; the picture and the gates' scores go back in the
same reply. Nothing is written to disk, nothing is printed about a request. docs/ai-spike.md has the rest.

Models:
  FASHN VTON 1.5    github.com/fashn-AI/fashn-vton-1.5, Apache-2.0. Maskless: person + garment -> picture at
                    576x864. Pose by DWPose (Apache-2.0) and a human parser (fashn-human-parser, which carries
                    NVIDIA's SegFormer licence: research only. FASHN_PARSER=off runs without it, see below).
  Leffa             github.com/franciszzj/Leffa, MIT (weights trained on VITON-HD, a research dataset).
                    SD 1.5 inpainting at 768x1024 with an agnostic mask and a DensePose map. The mask can
                    come from the page (--mask), which skips Leffa's SCHP parser and OpenPose; DensePose
                    (detectron2, Apache-2.0) still has to see a person in the render.
  DINOv2 small      facebook/dinov2-small, Apache-2.0 (the validator's likeness gate).
  BiRefNet          ZhengPeng7/BiRefNet, MIT (the validator's cut-out).

Both repositories were read at the commits pinned below; the file paths in the comments point into them.
"""

import base64
import os
import time

import modal

from tryon_prep import contact_sheet, dwpose_from_openpose, grow, letterbox, png_bytes, unletterbox

FASHN_REPO = "https://github.com/fashn-AI/fashn-vton-1.5"
FASHN_COMMIT = "7c0f10af3f91ad4048fe9729c470a13ef905d25a"
LEFFA_REPO = "https://github.com/franciszzj/Leffa"
LEFFA_COMMIT = "05a259104b6927607776c7edb3e86b75406f20aa"
LEFFA_DIR = "/opt/leffa"
WEIGHTS = "/weights"
DINO = "facebook/dinov2-small"
CUTOUT = "ZhengPeng7/BiRefNet"

CATEGORIES = ("tops", "bottoms")
LEFFA_GARMENT_TYPE = {"tops": "upper_body", "bottoms": "lower_body"}  # app.py's vt_garment_type
MASK_GROW = 0.012  # of the picture's height, each way, before Leffa inpaints


def download():
    """Fetches every weight while the image is built, so a cold start downloads nothing."""
    from huggingface_hub import hf_hub_download, snapshot_download
    from transformers import AutoImageProcessor, AutoModel, AutoModelForImageSegmentation

    # FASHN: scripts/download_weights.py in the repo, done here with the same repo ids and file names.
    hf_hub_download("fashn-ai/fashn-vton-1.5", "model.safetensors", local_dir=f"{WEIGHTS}/fashn")
    for name in ("yolox_l.onnx", "dw-ll_ucoco_384.onnx"):
        hf_hub_download("fashn-ai/DWPose", name, local_dir=f"{WEIGHTS}/fashn/dwpose")
    if os.environ.get("FASHN_PARSER") != "off":
        from fashn_human_parser import FashnHumanParser

        FashnHumanParser(device="cpu")  # caches its weights under HF_HOME, as the repo's script does
    # Leffa: app.py downloads the whole franciszzj/Leffa repo into ./ckpts; only the try-on parts are taken.
    snapshot_download(
        "franciszzj/Leffa",
        local_dir=f"{WEIGHTS}/leffa",
        allow_patterns=["densepose/*", "stable-diffusion-inpainting/*", "virtual_tryon.pth", "humanparsing/*", "openpose/*"],
    )
    # The validator's models.
    AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True)
    AutoImageProcessor.from_pretrained(DINO)
    AutoModel.from_pretrained(DINO)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "diffusers==0.31.0",
        "transformers==4.46.3",
        "accelerate==1.1.1",
        "safetensors==0.4.5",
        "huggingface_hub==0.26.2",
        "opencv-python-headless==4.10.0.84",
        "numpy==1.26.4",
        "pillow==11.0.0",
        "einops==0.8.0",
        "tqdm==4.67.1",
        "matplotlib==3.9.2",
        "scipy==1.14.1",
        "scikit-image==0.24.0",
        "timm==1.0.11",
        "kornia==0.7.4",
        "fastapi[standard]==0.115.5",
        # FASHN's own dependencies (pyproject.toml), minus opencv-python (the headless one is above).
        "onnxruntime-gpu==1.19.2",
        "fashn-human-parser==0.1.1",
        # Leffa's (requirements.txt is unpinned; these are the ones its vendored detectron2 and densepose import).
        "fvcore==0.1.5.post20221221",
        "iopath==0.1.10",
        "omegaconf==2.3.0",
        "hydra-core==1.3.2",
        "yacs==0.1.8",
        "pycocotools==2.0.8",
        "cloudpickle==3.1.0",
        "tabulate==0.9.0",
        "termcolor==2.5.0",
        "psutil==6.1.0",
        "pyyaml==6.0.2",
    )
    # FASHN as a package, at the commit that was read; --no-deps so pip doesn't swap torch or opencv.
    .run_commands(f"pip install --no-deps git+{FASHN_REPO}@{FASHN_COMMIT}")
    # Leffa isn't a package: its code is imported from a checkout on PYTHONPATH (as its app.py expects).
    .run_commands(f"git clone {LEFFA_REPO} {LEFFA_DIR} && cd {LEFFA_DIR} && git checkout {LEFFA_COMMIT} && rm -rf .git")
    .env({
        "PYTHONPATH": LEFFA_DIR,
        "HF_HOME": f"{WEIGHTS}/hf",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_ENABLE_HF_TRANSFER": "0",
        "FASHN_PARSER": os.environ.get("FASHN_PARSER", "on"),
    })
    # Baked in (copy=True) before the download step: that step imports this module, which imports them.
    .add_local_python_source("silhouette", "validate", "tryon_prep", copy=True)
    .run_function(download, timeout=3600)
)

app = modal.App("fitroom-tryon", image=image)


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


def load_fashn():
    import torch  # noqa: F401 - first, so onnxruntime-gpu finds the CUDA libraries torch ships
    from fashn_vton import TryOnPipeline

    if os.environ.get("FASHN_PARSER") == "off":
        TryOnPipeline._setup_hp_model = lambda self: setattr(self, "hp_model", NoParser())  # pipeline.py: _setup_hp_model
    return TryOnPipeline(weights_dir=f"{WEIGHTS}/fashn", device="cuda")


def run_fashn(pipeline, person, garment, category, pose=None, flat_lay=False, seed=7, steps=30):
    """One FASHN try-on. pose: the page's keypoints (see tryon_prep.dwpose_from_openpose), or None to let
    DWPose look for a person in the render. Returns the picture at the render's size."""
    flat_lay = flat_lay or os.environ.get("FASHN_PARSER") == "off"
    detector = pipeline.pose_model
    if pose is not None:
        pipeline.pose_model = GivenPose(detector, dwpose_from_openpose(pose))
    try:
        out = pipeline(
            person_image=person.convert("RGB"),
            garment_image=garment.convert("RGB"),
            category=category,
            garment_photo_type="flat-lay" if flat_lay else "model",
            num_timesteps=steps,
            seed=seed,
            segmentation_free=True,
        )
    finally:
        pipeline.pose_model = detector
    from PIL import Image

    return out.images[0].resize(person.size, Image.LANCZOS)


# Leffa ----------------------------------------------------------------------------------------------------

class Leffa:
    """Leffa's virtual try-on as app.py's LeffaPredictor.leffa_predict does it, without Gradio and with the
    mask optionally given by the page."""

    def __init__(self, ckpts=f"{WEIGHTS}/leffa"):
        from leffa.inference import LeffaInference
        from leffa.model import LeffaModel
        from leffa.transform import LeffaTransform
        from leffa_utils.densepose_predictor import DensePosePredictor

        self.ckpts = ckpts
        # leffa_utils/densepose_predictor.py: detectron2's DefaultPredictor on the R50-FPN DensePose weights.
        self.densepose = DensePosePredictor(
            config_path=f"{ckpts}/densepose/densepose_rcnn_R_50_FPN_s1x.yaml",
            weights_path=f"{ckpts}/densepose/model_final_162be9.pkl",
        )
        model = LeffaModel(
            pretrained_model_name_or_path=f"{ckpts}/stable-diffusion-inpainting",
            pretrained_model=f"{ckpts}/virtual_tryon.pth",
            dtype="float16",
        )
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


# The service ----------------------------------------------------------------------------------------------

@app.cls(gpu="L4", scaledown_window=180, timeout=900, max_containers=2)
class TryOn:
    @modal.enter()
    def start(self):
        import validate

        self.validate = validate
        self.models = {m.strip() for m in os.environ.get("TRYON_MODELS", "fashn,leffa").split(",")}
        self.fashn = load_fashn() if "fashn" in self.models else None
        self.leffa = Leffa() if "leffa" in self.models else None
        # The validator's models load on first use (validate.cutout_default / embed_default).

    def check(self, result, person, outline, garment, garment_mask, category, print_mask, flat_lay):
        """The three gates on one result. Without an outline from the page, the render's own cut-out stands
        in; without a garment mask, a band of the figure by category (tryon_prep's inputs say which)."""
        v = self.validate
        outline_mask = v.as_mask(outline, person.size) if outline is not None else v.as_mask(v.cutout_default(person), person.size)
        in_result = v.as_mask(garment_mask, person.size) if garment_mask is not None else v.band_mask(outline_mask, category)
        shop_cut = v.as_mask(v.cutout_default(garment), garment.size)
        in_shop = shop_cut if flat_lay else v.band_mask(shop_cut, category)
        return v.validate(outline_mask, result, garment, in_result, in_shop, print_mask)

    def paint(self, request, which):
        """Runs one model and the gates. Returns {ok, image?, seconds, checks?, error?}; never raises."""
        from silhouette import load

        try:
            person = load(base64.b64decode(request["person"]))
            garment = load(base64.b64decode(request["garment"]))
            category = str(request.get("category", "tops"))
            if category not in CATEGORIES:
                return {"ok": False, "error": "invalid_category"}
            pictures = {}
            for name, mode in (("mask", "L"), ("outline", "L"), ("print", "L")):
                if request.get(name):
                    pictures[name] = load(base64.b64decode(request[name]), mode)
            seed = int(request.get("seed", 7)) % 2**31
            steps = max(10, min(50, int(request.get("steps", 30))))
            flat_lay = bool(request.get("flat_lay", False)) or os.environ.get("FASHN_PARSER") == "off"
            pose = request.get("pose") or None
        except (KeyError, ValueError, TypeError):
            return {"ok": False, "error": "invalid"}

        began = time.perf_counter()
        try:
            if which == "fashn":
                if self.fashn is None:
                    return {"ok": False, "error": "model_not_loaded"}
                result = run_fashn(self.fashn, person, garment, category, pose=pose, flat_lay=flat_lay, seed=seed, steps=steps)
            else:
                if self.leffa is None:
                    return {"ok": False, "error": "model_not_loaded"}
                result = self.leffa(person, garment, category, mask=pictures.get("mask"), seed=seed, steps=steps)
        except Exception as error:  # noqa: BLE001 - the model's own failure is the answer, not a crash
            return {"ok": False, "error": f"{which}_failed:{type(error).__name__}", "seconds": round(time.perf_counter() - began, 1)}
        painted = time.perf_counter() - began

        checks = self.check(result, person, pictures.get("outline"), garment, pictures.get("mask"), category, pictures.get("print"), flat_lay)
        return {
            "ok": checks["ok"],
            "image": base64.b64encode(png_bytes(result)).decode(),
            "checks": checks,
            "seconds": round(painted, 1),
            "check_seconds": round(time.perf_counter() - began - painted, 1),
        }

    @modal.method()
    def run(self, request):
        """Both models (or `model`: "fashn" | "leffa") on one request, for `modal run`."""
        which = request.get("model", "both")
        names = ("fashn", "leffa") if which == "both" else (which,)
        return {name: self.paint(request, name) for name in names}

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def tryon(self, request: dict):
        """{person, garment: base64 PNG/JPEG; category: tops|bottoms; mask?, outline?, print?: base64 PNG;
        pose?: keypoints; model?: fashn|leffa; seed?} -> {ok, image?, checks: {shape, identity, print, ok}}.
        `ok` false means the page should keep its own render; the checks say which gate said no."""
        which = request.get("model", "fashn") if isinstance(request, dict) else "fashn"
        if which not in ("fashn", "leffa"):
            return {"ok": False, "error": "invalid_model"}
        answer = self.paint(request, which)
        if not answer["ok"]:
            answer.pop("image", None)
        return answer


# The spike -------------------------------------------------------------------------------------------------

def read_b64(path):
    return base64.b64encode(open(path, "rb").read()).decode() if path and os.path.exists(path) else None


def shots_in(folder):
    """The sheet's inputs: NAME-person.png, NAME-garment.(jpg|png|webp), NAME-category.txt, and optional
    NAME-mask.png (the garment in the render), NAME-outline.png (the figure), NAME-print.png (the print
    region in the shop photo, or the page's print.image), NAME-pose.json (keypoints for FASHN)."""
    import glob
    import json
    import pathlib

    shots = []
    for person in sorted(pathlib.Path(folder).glob("*-person.png")):
        name = person.name[: -len("-person.png")]
        garments = [g for ext in ("jpg", "jpeg", "png", "webp") for g in glob.glob(str(person.parent / f"{name}-garment.{ext}"))]
        if not garments:
            print(f"{name}: no {name}-garment.jpg, skipped")
            continue
        category_file = person.parent / f"{name}-category.txt"
        category = category_file.read_text().strip() if category_file.exists() else "tops"
        pose_file = person.parent / f"{name}-pose.json"
        shots.append({
            "name": name,
            "folder": person.parent,
            "request": {
                "person": read_b64(str(person)),
                "garment": read_b64(garments[0]),
                "category": category,
                "mask": read_b64(str(person.parent / f"{name}-mask.png")),
                "outline": read_b64(str(person.parent / f"{name}-outline.png")),
                "print": read_b64(str(person.parent / f"{name}-print.png")),
                "pose": json.loads(pose_file.read_text()) if pose_file.exists() else None,
            },
            "garment_path": garments[0],
            "person_path": str(person),
        })
    return shots


def words(answer):
    """A caption for the sheet: the gates and the time, or why the model failed."""
    import validate

    if not answer.get("checks"):
        return f"failed: {answer.get('error', '?')}\n{answer.get('seconds', '-')} s"
    checks = answer["checks"]
    shape, look, printed = validate.words_for(checks).split(" · ")
    return f"{shape} · {look}\n{printed}\n{answer['seconds']} s · {'PASS' if checks['ok'] else 'REFUSED'}"


@app.local_entrypoint()
def spike(
    person: str = "",
    garment: str = "",
    category: str = "tops",
    mask: str = "",
    outline: str = "",
    print_mask: str = "",
    pose_json: str = "",
    out: str = "tmp/spike-out",
    seed: int = 7,
    sheet: str = "",
    model: str = "both",
    flat_lay: bool = False,
    steps: int = 30,
):
    """One pair of pictures, or a folder of them (--sheet). Writes NAME-fashn.png, NAME-leffa.png,
    sheet.png and results.json into --out (or next to the sheet's inputs)."""
    import json
    import pathlib

    from PIL import Image

    if sheet:
        shots = shots_in(sheet)
        out_dir = pathlib.Path(out) if out != "tmp/spike-out" else pathlib.Path(sheet)
    else:
        if not (person and garment):
            raise SystemExit("give --person and --garment, or --sheet FOLDER")
        shots = [{
            "name": pathlib.Path(person).stem,
            "request": {
                "person": read_b64(person), "garment": read_b64(garment), "category": category,
                "mask": read_b64(mask), "outline": read_b64(outline), "print": read_b64(print_mask),
                "pose": json.loads(open(pose_json).read()) if pose_json else None,
            },
            "garment_path": garment, "person_path": person,
        }]
        out_dir = pathlib.Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)

    service = TryOn()
    rows, results = [], {}
    for shot in shots:
        request = {k: v for k, v in shot["request"].items() if v is not None}
        request.update(seed=seed, model=model, flat_lay=flat_lay, steps=steps)
        began = time.time()
        answers = service.run.remote(request)
        wall = round(time.time() - began, 1)
        row = {"name": shot["name"], "shop": Image.open(shot["garment_path"]), "render": Image.open(shot["person_path"])}
        results[shot["name"]] = {"wall_seconds": wall, "category": request["category"]}
        for which, answer in answers.items():
            if answer.get("image"):
                path = out_dir / f"{shot['name']}-{which}.png"
                path.write_bytes(base64.b64decode(answer["image"]))
                row[which] = Image.open(path)
            row[f"{which}_words"] = words(answer)
            results[shot["name"]][which] = {k: v for k, v in answer.items() if k != "image"}
            print(f"{shot['name']} {which}: {answer.get('error') or ('PASS' if answer['ok'] else 'REFUSED')} {answer.get('seconds', '-')} s")
        rows.append(row)

    if rows:
        contact_sheet(rows).save(out_dir / "sheet.png")
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))
    print(f"wrote {out_dir / 'sheet.png'} and {out_dir / 'results.json'}")
