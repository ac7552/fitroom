#!/bin/bash
# Once, before script/spike/mac/run.py: a Python venv in tmp/venv-mac with PyTorch (which uses the Mac's GPU),
# FASHN VTON 1.5 at the commit the engine pins (tryon_engine.FASHN_COMMIT) in tmp/fashn-vton-1.5, and the
# weights in tmp/weights: FASHN's model and pose detector (~2 GB) and the validator's BiRefNet and DINOv2
# (~1 GB). FASHN's research-only human parser isn't fetched (FASHN_PARSER=off, as on Kaggle).
# Run again any time: what's there is kept.
set -euo pipefail
cd "$(dirname "$0")/../../.."

VENV=tmp/venv-mac
FASHN_DIR=tmp/fashn-vton-1.5
WEIGHTS=tmp/weights
COMMIT=$(sed -n 's/^FASHN_COMMIT = "\(.*\)"/\1/p' script/modal/tryon_engine.py)

if [ "$(uname -s)" != "Darwin" ]; then echo "This is for a Mac (it runs FASHN on Apple's GPU)."; fi

# A Python with wheels for everything below: 3.13 or 3.12 when there is one, else the newest python3.
PY=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY=$candidate; break; fi
done
[ -n "$PY" ] || { echo "No python3 found. brew install python@3.13"; exit 1; }

if [ ! -x "$VENV/bin/python" ]; then
  echo "== venv ($($PY --version)) in $VENV"
  "$PY" -m venv "$VENV"
fi
PIP=("$VENV/bin/python" -m pip install -q --disable-pip-version-check)

echo "== libraries (a few minutes the first time)"
# The engine's pins where it has them (script/spike/kaggle/spike.py); onnxruntime is the plain one, as
# onnxruntime-gpu has no Mac build (DWPose runs on the CPU, a second or two a picture).
"${PIP[@]}" --upgrade pip
# PyTorch 2.9 and later use Apple's GPU only on macOS 14 or newer; on macOS 13 they quietly fall back to the
# CPU. There, PyTorch 2.8 (the last that supports it, with Python 3.13 at most) keeps the GPU.
TORCH=(torch torchvision)
MACOS=$(sw_vers -productVersion 2>/dev/null || echo 0)
if [ "${MACOS%%.*}" -lt 14 ] 2>/dev/null && [ "$(uname -s)" = "Darwin" ]; then
  echo "   macOS $MACOS: PyTorch 2.8, the last that uses Apple's GPU before macOS 14"
  TORCH=("torch==2.8.0" "torchvision==0.23.0")
fi
"${PIP[@]}" "${TORCH[@]}" numpy pillow opencv-python-headless matplotlib tqdm onnxruntime \
  "transformers==4.46.3" "safetensors>=0.4.5" "huggingface_hub>=0.26.2,<1.0" "einops==0.8.0" "timm==1.0.11" "kornia==0.7.4"
# Optional: the validator has its own SSIM and colour difference when scikit-image is missing.
"${PIP[@]}" scikit-image || echo "(scikit-image didn't install; the validator uses its own maths)"
# FASHN imports the parser's label tables even with the parser off; --no-deps on both, as on Kaggle (their
# own requirements would pull opencv-python and onnxruntime-gpu).
"${PIP[@]}" --no-deps "fashn-human-parser==0.1.1"

echo "== FASHN VTON 1.5 @ ${COMMIT:0:7}"
if [ ! -d "$FASHN_DIR/.git" ]; then git clone -q https://github.com/fashn-AI/fashn-vton-1.5 "$FASHN_DIR"; fi
git -C "$FASHN_DIR" fetch -q origin 2>/dev/null || true
git -C "$FASHN_DIR" checkout -q "$COMMIT"
"${PIP[@]}" --no-deps -e "$FASHN_DIR"

echo "== weights in $WEIGHTS (~3 GB the first time)"
mkdir -p "$WEIGHTS"
FASHN_PARSER=off HF_HOME="$WEIGHTS/hf" HF_HUB_DISABLE_TELEMETRY=1 "$VENV/bin/python" -c "
import sys; sys.path.insert(0, 'script/modal')
import tryon_engine
tryon_engine.download('$WEIGHTS', models=('fashn',), checker=True)
"

"$VENV/bin/python" -c "
import torch, fashn_vton, onnxruntime
mps = torch.backends.mps.is_available()
print(f'== ready: torch {torch.__version__}, Apple GPU (MPS): {\"yes\" if mps else \"NO: run.py will stop (see docs/ai-spike.md, On the Mac)\"}')
"
echo "Next: $VENV/bin/python script/spike/mac/run.py --smoke"
