"""Fitroom's AI try-on spike as one Kaggle script kernel (free GPU).

The Colab notebook's install, weights and run cells (script/colab/fitroom_tryon_spike.ipynb) in one file,
for Kaggle's image. `node script/spike/run.mjs` on the Mac fills the CONFIG line below, pushes this file
as the kernel `<user>/fitroom-tryon-spike` (kernel-metadata.json beside it) and downloads what it writes.

What it does, in order (each step prints a line with the time so far; the same lines go to log.txt):
  1. checks the GPU and the internet (both need a phone-verified Kaggle account);
  2. clones https://github.com/ac7552/fitroom (shallow) and the two model repos at the engine's pinned commits;
  3. pip installs the notebook's pins, quietly, over Kaggle's own torch;
  4. downloads the weights with tryon_engine.download into scratch space (outside /kaggle/working, so they
     aren't saved as kernel output: the output folder is capped at about 20 GB and the weights are ~10 GB);
  5. reads the inputs from the dataset /kaggle/input/fitroom-spike-inputs (spike.zip, or loose files);
  6. tryon_engine.run_sheet(..., flat_lay=True) with FASHN's research-only parser off;
  7. writes sheet.png, results.json, NAME-fashn.png, NAME-leffa.png and log.txt into /kaggle/working,
     which is what `kaggle kernels output` downloads.

Kaggle's image is built on Colab's runtime image (github.com/Kaggle/docker-python, Dockerfile.tmpl: Python
3.13, torch with CUDA preinstalled), so the pins are the notebook's; onnxruntime-gpu is left unpinned.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile

CONFIG = {"models": ["fashn"], "branch": "main", "dataset": "fitroom-spike-inputs", "steps": 30, "seed": 7}  # @config

FITROOM_REPO = "https://github.com/ac7552/fitroom"
FASHN_REPO = "https://github.com/fashn-AI/fashn-vton-1.5"
FASHN_COMMIT = "7c0f10af3f91ad4048fe9729c470a13ef905d25a"
LEFFA_REPO = "https://github.com/franciszzj/Leffa"
LEFFA_COMMIT = "05a259104b6927607776c7edb3e86b75406f20aa"

# Where things go. /kaggle/working is the kernel's output (saved, downloaded, capped); everything else lives
# in scratch space that is thrown away with the session.
OUT = os.environ.get("SPIKE_OUT", "/kaggle/working")
SCRATCH = os.environ.get("SPIKE_SCRATCH", "/kaggle/tmp" if os.path.isdir("/kaggle") else "/tmp/fitroom-spike")
INPUT_ROOT = os.environ.get("SPIKE_INPUT", "/kaggle/input")
WEIGHTS = f"{SCRATCH}/weights"
SPIKE = f"{SCRATCH}/spike"
ENGINE = f"{SCRATCH}/fitroom/script/modal"
LEFFA_DIR = f"{SCRATCH}/Leffa"
FASHN_DIR = f"{SCRATCH}/fashn-vton-1.5"

# A Kaggle GPU session ends after 12 hours; this run is about 20 minutes. Past the deadline no further model
# is loaded, so what is done is written and downloaded rather than lost with the session.
DEADLINE_SECONDS = int(os.environ.get("SPIKE_DEADLINE", 5 * 3600))

PINS = [
    "diffusers==0.31.0", "transformers==4.46.3", "accelerate==1.1.1", "safetensors==0.4.5", "huggingface_hub>=0.26.2,<1.0",
    "einops==0.8.0", "timm==1.0.11", "kornia==0.7.4", "onnxruntime-gpu>=1.20",
    "fvcore==0.1.5.post20221221", "iopath==0.1.10", "omegaconf==2.3.0", "yacs==0.1.8", "pycocotools==2.0.8",
    "cloudpickle==3.1.0", "tabulate==0.9.0", "termcolor==2.5.0", "av",
]

VERIFY_HINT = ("Kaggle gives notebooks a GPU and the internet only once the account has a verified phone number: "
               "kaggle.com/settings -> Phone verification. Then run again.")

BEGAN = time.time()
_timings = []


def log(message):
    """A progress line on stdout (the kernel's log) and in OUT/log.txt, stamped with the time so far."""
    stamp = f"[{time.time() - BEGAN:7.1f} s]"
    line = f"{stamp} {message}"
    print(line, flush=True)
    try:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, "log.txt"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def step(name):
    """Marks the start of a step; the step's duration goes into log.txt at the end."""
    _timings.append((name, time.time()))
    log(f"== {name}")


def fail(message):
    log(f"FAILED: {message}")
    sys.exit(1)


def sh(args, **kwargs):
    """Runs a command, quietly unless it fails."""
    done = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if done.returncode != 0:
        tail = "\n".join((done.stdout + done.stderr).strip().splitlines()[-25:])
        fail(f"{' '.join(args[:3])}... exited {done.returncode}:\n{tail}")
    return done


def pip(*args):
    sh([sys.executable, "-m", "pip", "install", "-q", "--no-warn-script-location", *args])


def clone_at(repo, commit, into):
    """A shallow clone of one commit (git can't --depth a bare commit, so init + fetch + checkout)."""
    if os.path.isdir(os.path.join(into, ".git")):
        return
    os.makedirs(into, exist_ok=True)
    sh(["git", "-C", into, "init", "-q"])
    sh(["git", "-C", into, "remote", "add", "origin", repo])
    sh(["git", "-C", into, "fetch", "-q", "--depth", "1", "origin", commit])
    sh(["git", "-C", into, "checkout", "-q", "FETCH_HEAD"])


def disk(path):
    try:
        usage = shutil.disk_usage(path)
        return f"{usage.free / 2**30:.1f} GB free of {usage.total / 2**30:.1f}"
    except OSError:
        return "?"


def over_deadline():
    return time.time() - BEGAN > DEADLINE_SECONDS


# 1. The session ----------------------------------------------------------------------------------------------

def check_session():
    step("session")
    log(f"python {sys.version.split()[0]} | output {OUT} ({disk(OUT)}) | scratch {SCRATCH}")
    os.makedirs(SCRATCH, exist_ok=True)
    log(f"scratch {disk(SCRATCH)}")
    try:
        smi = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
    except OSError as error:
        smi = subprocess.CompletedProcess([], 1, "", f"nvidia-smi: {error}")
    try:
        import torch
        cuda = torch.cuda.is_available()
        log(f"torch {torch.__version__} | cuda {torch.version.cuda} | gpu {smi.stdout.strip() or '-'}")
    except Exception as error:  # noqa: BLE001
        cuda = False
        log(f"torch import failed: {error}")
    if not cuda:
        fail(f"No GPU in this session (nvidia-smi: {smi.stdout.strip() or smi.stderr.strip() or 'nothing'}). "
             f"kernel-metadata.json asks for one (enable_gpu); if Kaggle ran it without, {VERIFY_HINT}")
    import urllib.request
    try:
        urllib.request.urlopen("https://github.com", timeout=20).read(1)
    except Exception as error:  # noqa: BLE001
        fail(f"No internet from this session ({type(error).__name__}: {error}); the code and weights can't be fetched. {VERIFY_HINT}")
    log("gpu and internet ok")


# 2. The code --------------------------------------------------------------------------------------------------

def fetch_code():
    step("code")
    branch = CONFIG.get("branch") or "main"
    fitroom = f"{SCRATCH}/fitroom"
    if not os.path.isdir(os.path.join(fitroom, ".git")):
        sh(["git", "clone", "-q", "--depth", "1", "--branch", branch, FITROOM_REPO, fitroom])
    head = subprocess.run(["git", "-C", fitroom, "log", "-1", "--format=%h %s"], capture_output=True, text=True).stdout.strip()
    log(f"fitroom {branch} @ {head}")
    if not os.path.isfile(os.path.join(ENGINE, "tryon_engine.py")):
        fail(f"{ENGINE}/tryon_engine.py isn't in the {branch} branch; push the engine first or set --branch")
    clone_at(FASHN_REPO, FASHN_COMMIT, FASHN_DIR)
    log(f"fashn-vton-1.5 @ {FASHN_COMMIT[:7]}")
    if "leffa" in CONFIG["models"]:
        clone_at(LEFFA_REPO, LEFFA_COMMIT, LEFFA_DIR)
        log(f"Leffa @ {LEFFA_COMMIT[:7]}")


# 3. The libraries ---------------------------------------------------------------------------------------------

def install():
    step("install")
    # The CPU onnxruntime, if the image has one, would shadow the GPU build.
    subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "onnxruntime"], capture_output=True)
    pip(*PINS)
    # --no-deps: their dependency lists would pull another torch or opencv over Kaggle's.
    pip("--no-deps", "fashn-human-parser==0.1.1")
    pip("--no-deps", FASHN_DIR)
    check = subprocess.run([sys.executable, "-c", "import torch, fashn_vton, onnxruntime; print(torch.__version__, onnxruntime.get_available_providers())"],
                           capture_output=True, text=True)
    if check.returncode != 0:
        fail(f"the installed libraries don't import:\n{check.stderr.strip()[-2000:]}")
    log(f"installed: torch {check.stdout.strip()}")
    if "CUDAExecutionProvider" not in check.stdout:
        log("warning: onnxruntime has no CUDAExecutionProvider; DWPose will run on the CPU (slower, still works)")


# 4. The weights -----------------------------------------------------------------------------------------------

def engine_module():
    os.environ["HF_HOME"] = f"{WEIGHTS}/hf"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ.setdefault("FASHN_PARSER", "off")  # the research-only parser isn't fetched or loaded
    os.environ["LEFFA_DIR"] = LEFFA_DIR
    os.environ["TRYON_WEIGHTS"] = WEIGHTS
    for p in (ENGINE, LEFFA_DIR):
        if p not in sys.path:
            sys.path.insert(0, p)
    import tryon_engine
    return tryon_engine


def download_weights(engine):
    step("weights")
    os.makedirs(WEIGHTS, exist_ok=True)
    engine.download(WEIGHTS, models=tuple(CONFIG["models"]))
    log(f"weights in {WEIGHTS}: {sorted(os.listdir(WEIGHTS))} | scratch {disk(SCRATCH)}")


# 5. The inputs ------------------------------------------------------------------------------------------------

INPUT_NAME = re.compile(r"^(.*)-(person|garment|category|outline|mask|print|pose)\.\w+$")


def plain(name):
    """"tee-person (1).png" -> "tee-person.png"; the base name only."""
    return re.sub(r" \(\d+\)(?=\.\w+$)", "", os.path.basename(name))


def gather_inputs():
    """The dataset's files into SPIKE: a spike.zip (Kaggle usually unpacks zips on upload; if not, here) or
    loose files, wherever they are under the dataset folder."""
    step("inputs")
    shutil.rmtree(SPIKE, ignore_errors=True)
    os.makedirs(SPIKE)
    roots = [os.path.join(INPUT_ROOT, CONFIG.get("dataset") or "fitroom-spike-inputs")]
    if not os.path.isdir(roots[0]) and os.path.isdir(INPUT_ROOT):
        roots = [os.path.join(INPUT_ROOT, d) for d in sorted(os.listdir(INPUT_ROOT))]
    found = 0
    for root in roots:
        for folder, _, names in os.walk(root):
            for name in names:
                path = os.path.join(folder, name)
                if name.lower().endswith(".zip"):
                    with zipfile.ZipFile(path) as z:
                        for member in z.infolist():
                            base = os.path.basename(member.filename)
                            if member.is_dir() or "__MACOSX" in member.filename or base.startswith("."):
                                continue
                            with open(os.path.join(SPIKE, plain(base)), "wb") as f:
                                f.write(z.read(member))
                            found += 1
                elif INPUT_NAME.match(plain(name)):
                    shutil.copyfile(path, os.path.join(SPIKE, plain(name)))
                    found += 1
    if not found:
        fail(f"no inputs under {', '.join(roots)}: the dataset should hold spike.zip (node script/spike/inputs.mjs) or the NAME-* files")
    groups = {}
    for f in sorted(os.listdir(SPIKE)):
        m = INPUT_NAME.match(f)
        groups.setdefault(m.group(1) if m else "(not an input)", []).append(f)
    ready = 0
    for name, names in groups.items():
        if name == "(not an input)":
            log(f"   ignored: {', '.join(names)}")
            continue
        kinds = {INPUT_NAME.match(f).group(2) for f in names}
        ok = {"person", "garment"} <= kinds
        ready += ok
        log(f"{'ok ' if ok else '-- '}{name}: {', '.join(names)}" + ("" if ok else "   <- needs NAME-person.png and NAME-garment.jpg"))
    if not ready:
        fail("nothing to run: no NAME-person.png with its NAME-garment.jpg")
    log(f"{ready} ready to run")


# 6. The run ---------------------------------------------------------------------------------------------------

def run(engine):
    step("run")
    models = tuple(CONFIG["models"])
    if over_deadline():
        fail(f"past the {DEADLINE_SECONDS} s deadline before the run began; nothing painted")
    results = engine.run_sheet(SPIKE, models=models, out=OUT, flat_lay=True, steps=int(CONFIG.get("steps", 30)), seed=int(CONFIG.get("seed", 7)),
                               weights=WEIGHTS, leffa_dir=LEFFA_DIR, say=log)
    return results


def summarize(results_path):
    step("done")
    try:
        results = json.load(open(results_path))
    except (OSError, ValueError) as error:
        fail(f"no results.json: {error}")
    for name, item in results.items():
        for which in ("fashn", "leffa"):
            answer = item.get(which)
            if not answer:
                continue
            if answer.get("checks"):
                log(f"{name} {which}: {'PASS' if answer['ok'] else 'REFUSED'} · {answer['seconds']} s")
            else:
                log(f"{name} {which}: FAILED {answer.get('error', '?')}")
    marks = _timings + [("end", time.time())]
    for (name, began), (_, ended) in zip(marks, marks[1:]):
        log(f"timing {name}: {ended - began:.0f} s")
    log(f"output: {sorted(os.listdir(OUT))} ({disk(OUT)})")


def main():
    if isinstance(CONFIG.get("models"), str):
        CONFIG["models"] = ["fashn", "leffa"] if CONFIG["models"] == "both" else [CONFIG["models"]]
    if os.environ.get("MODELS"):  # by hand, outside run.mjs
        CONFIG["models"] = ["fashn", "leffa"] if os.environ["MODELS"] == "both" else [os.environ["MODELS"]]
    for which in CONFIG["models"]:
        if which not in ("fashn", "leffa"):
            fail(f"unknown model {which!r}: fashn or leffa")
    os.makedirs(OUT, exist_ok=True)
    try:
        os.remove(os.path.join(OUT, "log.txt"))
    except OSError:
        pass
    log(f"fitroom try-on spike on Kaggle: models {CONFIG['models']}, branch {CONFIG.get('branch', 'main')}, steps {CONFIG.get('steps', 30)}, seed {CONFIG.get('seed', 7)}")
    check_session()
    fetch_code()
    install()
    engine = engine_module()
    download_weights(engine)
    gather_inputs()
    results = run(engine)
    summarize(results)


if __name__ == "__main__":
    main()
