"""Fitroom's try-on service on Modal, for the app: FASHN VTON 1.5 paints a shop's photo of a garment onto the
page's picture of the mannequin, and the three-gate validator (validate.py) decides whether the page may
show it. The spike's service (tryon_spike.py) carries Leffa too, for comparing; this one is what the server
calls, kept small so it starts fast and costs little:

- FASHN only (Leffa never made a picture on a free GPU, and its weights are for research), and FASHN's human
  parser off (research-only licence; the shop photos are product shots, which never need it).
- One L4 per request, at most TRYON_MAX_GPUS of them at once (default 2): the cost can't run away.
- A GPU goes back to sleep TRYON_IDLE_SECONDS after its last picture (default 60), so idling costs little.
- {"warm": true} wakes one without painting anything: the server sends it when someone adds clothes with a
  shop photo, so the GPU is up by the time they ask for the AI picture (a cold start takes about a minute).

    modal deploy script/modal/tryon_service.py
    TRYON_MAX_GPUS=3 TRYON_IDLE_SECONDS=120 modal deploy script/modal/tryon_service.py   # other limits

Then a Modal proxy auth token (Modal's dashboard: Settings > Proxy Auth Tokens) and the endpoint's URL go in
.env as FITROOM_TRYON_URL, FITROOM_TRYON_KEY, FITROOM_TRYON_SECRET (docs/ai-spike.md, "The service").

Only the mannequin's picture, its outline and the shop's photo come in; the picture and the gates' scores go
back in the same reply. Nothing is written to disk, nothing is printed about a request.
"""

import os

import modal

import tryon_engine as engine
from tryon_engine import FASHN_COMMIT, FASHN_REPO

WEIGHTS = "/weights"
MAX_GPUS = int(os.environ.get("TRYON_MAX_GPUS", "2"))
IDLE_SECONDS = int(os.environ.get("TRYON_IDLE_SECONDS", "60"))


def download():
    """FASHN's model and pose detector, and the validator's two models, while the image is built."""
    engine.download(WEIGHTS, models=("fashn",), checker=True)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
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
        "onnxruntime-gpu==1.19.2",
    )
    # FASHN imports the parser's label tables even with the parser off; both without their own requirements
    # (which would bring opencv-python beside the headless one), at the commit that was read.
    .run_commands("pip install --no-deps fashn-human-parser==0.1.1", f"pip install --no-deps git+{FASHN_REPO}@{FASHN_COMMIT}")
    .env({
        "TRYON_WEIGHTS": WEIGHTS,
        "HF_HOME": f"{WEIGHTS}/hf",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "FASHN_PARSER": "off",
    })
    .add_local_python_source("silhouette", "validate", "tryon_prep", "tryon_engine", copy=True)
    .run_function(download, timeout=3600)
)

app = modal.App("fitroom-tryon-service", image=image)


@app.cls(gpu="L4", scaledown_window=IDLE_SECONDS, timeout=300, max_containers=MAX_GPUS)
class TryOn:
    @modal.enter()
    def start(self):
        from PIL import Image

        self.models = {"fashn": engine.load_fashn(f"{WEIGHTS}/fashn")}
        self.checker = engine.load_checker()
        # The validator's models load here too, not on the first picture: a warm GPU is ready for all of it.
        blank = Image.new("RGB", (64, 64), "white")
        self.checker.cutout(blank)
        self.checker.embed(blank)

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def tryon(self, request: dict):
        """{person, garment: base64 PNG/JPEG; category: tops|bottoms; mask?, outline?, print?: base64 PNG;
        steps?; seed?} -> {ok, image?, checks: {shape, identity, print, ok}, seconds}. `ok` false means the
        page keeps its own picture; the checks say which gate said no. {warm: true} -> {ok, warm} at once,
        once a GPU is up."""
        if isinstance(request, dict) and request.get("warm"):
            return {"ok": True, "warm": True}
        answer = engine.paint(self.models, self.checker, request, "fashn")
        if not answer["ok"]:
            answer.pop("image", None)
        return answer
