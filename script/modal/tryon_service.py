"""Fitroom's try-on service on Modal, for the app: FASHN VTON 1.5 paints a shop's photo of a garment onto the
page's picture of the mannequin, and the three-gate validator (validate.py) decides whether the page may
show it. The spike's service (tryon_spike.py) carries Leffa too, for comparing; this one is what the server
calls, kept small so it starts fast and costs little:

- FASHN only (Leffa never made a picture on a free GPU, and its weights are for research), and FASHN's human
  parser off (research-only licence; the shop photos are product shots, which never need it).
- Jobs, not one long request: Modal cuts a web request off at 150 s (and answers with a redirect to poll),
  and a cold GPU can take longer than that. The `jobs` web app (a small CPU container, so asking how a job
  is doing never wakes or holds a GPU) starts a picture and answers at once with its id; the server asks
  for the result every few seconds and can cancel it. See tryon_jobs.py for the endpoints.
- One L4 per picture, at most TRYON_MAX_GPUS of them at once (default 2): the cost can't run away. A
  picture may run TRYON_PAINT_SECONDS (default 180), then Modal stops it.
- A GPU goes back to sleep TRYON_IDLE_SECONDS after its last picture (default 60), so idling costs little.
- Fast cold starts: the weights live in a Modal Volume, not in the image (a fresh worker no longer pulls
  10 GB of image), and the models are loaded once into a memory snapshot that later containers restore.
  TRYON_SNAPSHOT=cpu (default) snapshots them on the CPU and moves them to the GPU after each restore;
  =gpu uses Modal's GPU snapshot (alpha: faster, but newer); =off loads from the Volume on every start.
- {"warm": true} wakes one without painting anything: the server sends it when someone adds clothes with a
  shop photo, so the GPU is up by the time they ask for the AI picture.

    modal run script/modal/tryon_service.py::fetch_weights   # once: fills the Volume (idempotent)
    modal deploy script/modal/tryon_service.py
    TRYON_MAX_GPUS=3 TRYON_IDLE_SECONDS=120 modal deploy script/modal/tryon_service.py   # other limits

Then a Modal proxy auth token (Modal's dashboard: Settings > Proxy Auth Tokens) and the `jobs` app's URL go
in .env as FITROOM_TRYON_URL, FITROOM_TRYON_KEY, FITROOM_TRYON_SECRET (docs/ai-spike.md, "The service").
The old synchronous `tryon` endpoint stays for one release, so a server not yet updated keeps working.

Only the mannequin's picture, its outline and the shop's photo come in; the picture and the gates' scores go
back in the result. Nothing is written to disk, nothing is printed about a request. Modal keeps a finished
call's result for the server to fetch (up to 7 days, Modal's limit; the server fetches it within seconds).

Written against the `modal` client 1.6.2 (FunctionCall.from_id / .get(timeout=0) / .cancel(),
Cls methods' .spawn, enable_memory_snapshot with @modal.enter(snap=True), experimental_options
{"enable_gpu_snapshot": True}, Volume.from_name(create_if_missing=True), modal.Dict, asgi_app with
requires_proxy_auth, modal.current_function_call_id), as read in that version's source.
"""

import os

import modal

import tryon_jobs as jobs_logic

try:  # the GPU image and the deploying machine have the engine; the jobs app's small image doesn't
    import tryon_engine as engine
except ImportError:
    engine = None

WEIGHTS = "/weights"
MAX_GPUS = int(os.environ.get("TRYON_MAX_GPUS", "2"))
IDLE_SECONDS = int(os.environ.get("TRYON_IDLE_SECONDS", "60"))
# GPUs to try, in order: Modal runs on the first one it has free. L4 alone can wait minutes for capacity
# ("waiting to be scheduled on a GPU_L4 worker"); A10G and L40S are Ampere/Ada too (bf16), so FASHN runs the same.
GPUS = [g.strip() for g in os.environ.get("TRYON_GPUS", "L4,A10G,L40S").split(",") if g.strip()]
PAINT_SECONDS = int(os.environ.get("TRYON_PAINT_SECONDS", "180"))
SNAPSHOT = os.environ.get("TRYON_SNAPSHOT", "cpu")
if SNAPSHOT not in ("cpu", "gpu", "off"):
    raise ValueError("TRYON_SNAPSHOT is cpu, gpu or off")

weights = modal.Volume.from_name("fitroom-tryon-weights", create_if_missing=True)
# Which calls a GPU has started on: {call id: "painting"} while it paints, so a pending result can say
# "painting" rather than "starting" (a FunctionCall can't tell). Ids only; nothing about the picture.
phases = modal.Dict.from_name("fitroom-tryon-phases", create_if_missing=True)

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
        "spandrel==0.4.0",
    )
    # FASHN imports the parser's label tables even with the parser off; both without their own requirements
    # (which would bring opencv-python beside the headless one), at the commit that was read.
    .run_commands(
        "pip install --no-deps fashn-human-parser==0.1.1",
        f"pip install --no-deps git+{engine.FASHN_REPO}@{engine.FASHN_COMMIT}" if engine else "true",
        # The upscaler's weights (64 MB) in the image itself, so nothing new has to go into the Volume.
        f"mkdir -p /opt/esrgan && python -c \"import urllib.request; urllib.request.urlretrieve('{engine.UPSCALER_URL}', "
        "'/opt/esrgan/RealESRGAN_x2plus.pth')\"" if engine else "true",
    )
    .env({
        "TRYON_WEIGHTS": WEIGHTS,
        "HF_HOME": f"{WEIGHTS}/hf",  # in the Volume: the validator's two models
        "HF_MODULES_CACHE": "/tmp/hf_modules",  # BiRefNet's remote code, rewritten per container, not in the Volume
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "FASHN_PARSER": "off",
    })
    .add_local_python_source("silhouette", "validate", "tryon_prep", "tryon_engine", "tryon_jobs", copy=True)
)

# The jobs app needs only FastAPI and tryon_jobs: it starts in a second or two and costs a CPU's pennies.
web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]==0.115.5").add_local_python_source("tryon_jobs")

app = modal.App("fitroom-tryon-service", image=image)


@app.function(volumes={WEIGHTS: weights}, timeout=3600)
def fill_weights():
    """FASHN's model and pose detector, and the validator's two models, into the Volume. Files already
    there are kept (hf_hub_download and from_pretrained skip what's cached), so running it again is cheap."""
    engine.download(WEIGHTS, models=("fashn",), checker=True)
    weights.commit()
    total = sum(os.path.getsize(os.path.join(root, name)) for root, _, names in os.walk(WEIGHTS) for name in names)
    return f"{total / 1e9:.1f} GB in the fitroom-tryon-weights Volume"


@app.local_entrypoint()
def fetch_weights():
    """modal run script/modal/tryon_service.py::fetch_weights"""
    print(fill_weights.remote())


snapshot_options = {"enable_memory_snapshot": SNAPSHOT != "off"}
if SNAPSHOT == "gpu":
    snapshot_options["experimental_options"] = {"enable_gpu_snapshot": True}


@app.cls(
    gpu=GPUS,
    volumes={WEIGHTS: weights},
    # The weights are all in the Volume; and the container reads TRYON_SNAPSHOT too, so `load` agrees with
    # how the class was deployed.
    secrets=[modal.Secret.from_dict({"HF_HUB_OFFLINE": "1", "TRYON_SNAPSHOT": SNAPSHOT})],
    scaledown_window=IDLE_SECONDS,
    timeout=PAINT_SECONDS,
    startup_timeout=600,  # the first start after a deploy reads the Volume and takes the snapshot
    max_containers=MAX_GPUS,
    **snapshot_options,
)
class TryOn:
    @modal.enter(snap=SNAPSHOT != "off")
    def load(self):
        """The models, loaded once. With TRYON_SNAPSHOT=cpu this runs before the snapshot, where there is no
        GPU (and torch.cuda mustn't be asked): everything goes to the CPU in bf16 (an L4 is Ada, bf16 is
        native) and DWPose waits for `to_gpu`. With gpu or off it loads straight onto the GPU."""
        import torch

        device = torch.device("cpu" if SNAPSHOT == "cpu" else "cuda")
        self.models = {"fashn": engine.load_fashn(f"{WEIGHTS}/fashn", device=device, dtype=torch.bfloat16, pose=SNAPSHOT != "cpu")}
        # FASHN's picture doubled before it goes back into the page's (None, and skipped, if it won't load).
        try:
            self.models["upscaler"] = engine.load_upscaler(device=device)
        except Exception as error:  # noqa: BLE001 - the picture still goes, just not sharpened
            print(f"[tryon] upscaler not loaded: {type(error).__name__}: {error}")
        # The validator's models load here too, not on the first picture: a warm GPU is ready for all of it.
        self.checker = engine.load_checker(device).preload()

    @modal.enter(snap=False)
    def to_gpu(self):
        """After each restore of a CPU snapshot: the weights onto the GPU (a few seconds) and DWPose built there."""
        if SNAPSHOT != "cpu":
            return
        import torch

        gpu = torch.device("cuda")
        engine.move_fashn(self.models["fashn"], gpu)
        if self.models.get("upscaler") is not None:
            self.models["upscaler"].move(gpu)
        self.checker.move(gpu)

    @modal.method()
    def paint(self, request: dict):
        """{person, garment: base64 PNG/JPEG; category: tops|bottoms; mask?, outline?, print?: base64 PNG;
        steps?; seed?} -> {ok, image, checks: {shape, identity, print, ok}, seconds}. `ok` false means the
        page keeps its own picture; the checks say which gate said no (the jobs app drops the image then)."""
        call_id = modal.current_function_call_id()
        mark(call_id, "painting")
        try:
            return engine.paint(self.models, self.checker, request, "fashn")
        finally:
            mark(call_id, None)

    @modal.method()
    def warm(self):
        """Nothing: by the time this runs, `load` (and `to_gpu`) have, so a GPU is up for the next minute."""
        return {"ok": True, "warm": True}

    # The old synchronous endpoint, for one release: a server still on it keeps working (with Modal's 150 s
    # limit, which is why it's going). Delete it once FITROOM_TRYON_URL points at the jobs app.
    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def tryon(self, request: dict):
        if isinstance(request, dict) and request.get("warm"):
            return {"ok": True, "warm": True}
        answer = engine.paint(self.models, self.checker, request, "fashn")
        if not answer["ok"]:
            answer.pop("image", None)
        return answer


def mark(call_id, phase):
    """Notes (or forgets) that a GPU is painting a call. Best effort: a label, never a reason to fail."""
    if not call_id:
        return
    try:
        if phase:
            phases.put(call_id, phase)
        else:
            phases.pop(call_id, None)
    except Exception:  # noqa: BLE001
        pass


@app.function(image=web_image, scaledown_window=300, timeout=60)
@modal.concurrent(max_inputs=50)
@modal.asgi_app(requires_proxy_auth=True)
def jobs():
    """POST /start, GET /result/{id}, POST /cancel/{id}: see tryon_jobs.py. One base URL; Modal's proxy
    auth turns away anything without the token before it gets here."""
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.post("/start")
    async def start(request: Request):
        try:
            body = await request.json()
        except ValueError:
            body = None
        kind, paint_request = jobs_logic.start_body(body)
        if kind == "invalid":
            return JSONResponse({"ok": False, "error": "invalid"}, status_code=422)
        worker = TryOn()
        call = await (worker.warm.spawn.aio() if kind == "warm" else worker.paint.spawn.aio(paint_request))
        return {"id": call.object_id}

    @api.get("/result/{call_id}")
    async def result(call_id: str):
        if not jobs_logic.valid_id(call_id):
            return JSONResponse({"status": "failed", "error": "unknown"}, status_code=404)
        answer = error = None
        phase = "starting"
        try:
            answer = await modal.FunctionCall.from_id(call_id).get.aio(timeout=0)
        except TimeoutError as pending:  # the built-in one: not done yet
            error = pending
            try:
                phase = await phases.get.aio(call_id) or "starting"
            except Exception:  # noqa: BLE001
                pass
        except Exception as failed:  # noqa: BLE001 - expired, timed out, cancelled, crashed: all answers
            error = failed
        status, body = jobs_logic.outcome(answer, error, phase)
        return JSONResponse(body, status_code=status)

    @api.post("/cancel/{call_id}")
    async def cancel(call_id: str):
        if not jobs_logic.valid_id(call_id):
            return JSONResponse({"status": "failed", "error": "unknown"}, status_code=404)
        # The input is cancelled; its container stays up (terminate_containers=False) for the next picture.
        await modal.FunctionCall.from_id(call_id).cancel.aio()
        return {"status": "cancelled"}

    return api
