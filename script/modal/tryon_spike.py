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

Modal needs a payment method on the account before it will start a GPU. Without one, the same engine runs on
Google Colab's free T4: script/colab/fitroom_tryon_spike.ipynb (see docs/ai-spike.md, "Running on Google
Colab"). Everything that loads or runs a model is in tryon_engine.py, which has no Modal in it; this file is
the Modal image, the container class and the `modal run` entrypoint.

Models:
  FASHN VTON 1.5    github.com/fashn-AI/fashn-vton-1.5, Apache-2.0. Maskless: person + garment -> picture at
                    576x864. Pose by DWPose (Apache-2.0) and a human parser (fashn-human-parser, which carries
                    NVIDIA's SegFormer licence: research only. FASHN_PARSER=off runs without it, see the engine).
  Leffa             github.com/franciszzj/Leffa, MIT (weights trained on VITON-HD, a research dataset).
                    SD 1.5 inpainting at 768x1024 with an agnostic mask and a DensePose map. The mask can
                    come from the page (--mask), which skips Leffa's SCHP parser and OpenPose; DensePose
                    (detectron2, Apache-2.0) still has to see a person in the render.
  DINOv2 small      facebook/dinov2-small, Apache-2.0 (the validator's likeness gate).
  BiRefNet          ZhengPeng7/BiRefNet, MIT (the validator's cut-out).

Both repositories were read at the commits pinned in tryon_engine.py; the file paths in the comments there
point into them.
"""

import os
import time

import modal

import tryon_engine as engine
from tryon_engine import FASHN_COMMIT, FASHN_REPO, LEFFA_COMMIT, LEFFA_REPO

LEFFA_DIR = "/opt/leffa"
WEIGHTS = "/weights"


def download():
    """Fetches every weight while the image is built, so a cold start downloads nothing."""
    engine.download(WEIGHTS)


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
        "LEFFA_DIR": LEFFA_DIR,
        "TRYON_WEIGHTS": WEIGHTS,
        "HF_HOME": f"{WEIGHTS}/hf",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_ENABLE_HF_TRANSFER": "0",
        "FASHN_PARSER": os.environ.get("FASHN_PARSER", "on"),
    })
    # Baked in (copy=True) before the download step: that step imports this module, which imports them.
    .add_local_python_source("silhouette", "validate", "tryon_prep", "tryon_engine", copy=True)
    .run_function(download, timeout=3600)
)

app = modal.App("fitroom-tryon", image=image)


# The service ----------------------------------------------------------------------------------------------

@app.cls(gpu="L4", scaledown_window=180, timeout=900, max_containers=2)
class TryOn:
    @modal.enter()
    def start(self):
        wanted = {m.strip() for m in os.environ.get("TRYON_MODELS", "fashn,leffa").split(",")}
        self.models = {}
        if "fashn" in wanted:
            self.models["fashn"] = engine.load_fashn(f"{WEIGHTS}/fashn")
        if "leffa" in wanted:
            self.models["leffa"] = engine.load_leffa(LEFFA_DIR, f"{WEIGHTS}/leffa")
        self.checker = engine.load_checker()  # BiRefNet and DINOv2 load on first use

    def paint(self, request, which):
        """Runs one model and the gates. Returns {ok, image?, seconds, checks?, error?}; never raises."""
        return engine.paint(self.models, self.checker, request, which)

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
    import pathlib

    if sheet:
        shots = engine.shots_in(sheet)
        out_dir = pathlib.Path(out) if out != "tmp/spike-out" else pathlib.Path(sheet)
    else:
        if not (person and garment):
            raise SystemExit("give --person and --garment, or --sheet FOLDER")
        shots = [engine.one_shot(person, garment, category, mask, outline, print_mask, pose_json)]
        out_dir = pathlib.Path(out)

    service = TryOn()
    answers = {}
    for shot in shots:
        request = {k: v for k, v in shot["request"].items() if v is not None}
        request.update(seed=seed, model=model, flat_lay=flat_lay, steps=steps)
        began = time.time()
        answers[shot["name"]] = service.run.remote(request)
        answers[shot["name"]]["wall_seconds"] = round(time.time() - began, 1)
        for which, answer in answers[shot["name"]].items():
            if which != "wall_seconds":
                print(f"{shot['name']} {which}: {answer.get('error') or ('PASS' if answer['ok'] else 'REFUSED')} {answer.get('seconds', '-')} s")

    sheet_path, results_path = engine.write_sheet(shots, answers, out_dir)
    print(f"wrote {sheet_path} and {results_path}")
