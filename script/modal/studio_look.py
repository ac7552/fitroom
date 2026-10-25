"""Fitroom's studio look on Modal: a photo of the 3D view, repainted by SDXL to look like a studio shot.

The page sends three pictures from one camera: the photo, a depth picture and the figure's outline. SDXL
repaints the photo lightly (img2img), held to the draped shape by two ControlNets, depth and edges, so the
hems, folds and fit stay where the cloth simulation put them; it only changes the light, the cloth's
texture and the mannequin's finish. Then the repaint's outline is cut out (BiRefNet) and compared with the
render's: under 85% overlap, it's tried once more with a lighter touch, and if that fails too, nothing is
returned and the page keeps its own photo. The page then takes colours and prints from its own photo and
only light and texture from the repaint (keepDetails in app/javascript/lib/local_studio.js).

Nothing is kept: the pictures arrive in the request, are worked on in memory and go back in the reply.
Nothing is written to disk or printed to the logs.

Models (all allowed for commercial use):
  stabilityai/stable-diffusion-xl-base-1.0    CreativeML Open RAIL++-M
  diffusers/controlnet-depth-sdxl-1.0         OpenRAIL++
  diffusers/controlnet-canny-sdxl-1.0         OpenRAIL++
  madebyollin/sdxl-vae-fp16-fix               MIT
  ZhengPeng7/BiRefNet                         MIT

Deploy (once, from the repo's root, with a Modal account):
  pip install modal && modal setup
  modal deploy script/modal/studio_look.py
Then in Modal's dashboard, Settings > Proxy Auth Tokens, make a token, and put its URL, key and secret in
the server's .env (FITROOM_STUDIO_URL, FITROOM_STUDIO_KEY, FITROOM_STUDIO_SECRET). Requests without the
token are turned away before any GPU starts.
"""

import base64

import modal

from silhouette import LEAST_IOU, NEGATIVE, guide_edges, iou, load, mask_of, png, prompt_for, sdxl_size, stretch_depth

BASE = "stabilityai/stable-diffusion-xl-base-1.0"
DEPTH = "diffusers/controlnet-depth-sdxl-1.0"
CANNY = "diffusers/controlnet-canny-sdxl-1.0"
VAE = "madebyollin/sdxl-vae-fp16-fix"
CUTOUT = "ZhengPeng7/BiRefNet"

# How much of the photo is repainted, first try then the lighter retry.
STRENGTHS = (0.38, 0.24)
STEPS = 30


def download():
    """Fetches the weights while the image is built, so a cold start doesn't download them."""
    import torch
    from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline
    from transformers import AutoModelForImageSegmentation

    controlnets = [ControlNetModel.from_pretrained(name, torch_dtype=torch.float16) for name in (DEPTH, CANNY)]
    vae = AutoencoderKL.from_pretrained(VAE, torch_dtype=torch.float16)
    StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
        BASE, controlnet=controlnets, vae=vae, torch_dtype=torch.float16, variant="fp16", use_safetensors=True
    )
    AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "diffusers==0.31.0",
        "transformers==4.46.3",
        "accelerate==1.1.1",
        "safetensors==0.4.5",
        "huggingface_hub==0.26.2",
        "opencv-python-headless==4.10.0.84",
        "timm==1.0.11",
        "kornia==0.7.4",
        "einops==0.8.0",
        "numpy==1.26.4",
        "pillow==11.0.0",
        "fastapi[standard]==0.115.5",
    )
    .env({"HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_ENABLE_HF_TRANSFER": "0"})
    .run_function(download, timeout=3600)
    .add_local_python_source("silhouette")
)

app = modal.App("fitroom-studio", image=image)


@app.cls(gpu="L4", scaledown_window=180, timeout=300, max_containers=2)
class Studio:
    @modal.enter()
    def start(self):
        import torch
        from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline
        from transformers import AutoModelForImageSegmentation

        self.torch = torch
        controlnets = [ControlNetModel.from_pretrained(name, torch_dtype=torch.float16) for name in (DEPTH, CANNY)]
        vae = AutoencoderKL.from_pretrained(VAE, torch_dtype=torch.float16)
        self.pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
            BASE, controlnet=controlnets, vae=vae, torch_dtype=torch.float16, variant="fp16", use_safetensors=True
        ).to("cuda")
        self.pipe.set_progress_bar_config(disable=True)
        self.cutout = AutoModelForImageSegmentation.from_pretrained(CUTOUT, trust_remote_code=True).to("cuda").eval().half()

    def outline(self, picture):
        """The figure's outline in a repainted photo, as a boolean array the photo's size."""
        import numpy as np
        import torch
        from PIL import Image

        x = np.asarray(picture.convert("RGB").resize((1024, 1024), Image.BILINEAR), dtype=np.float32) / 255.0
        x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        tensor = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to("cuda", torch.float16)
        with torch.no_grad():
            alpha = self.cutout(tensor)[-1].sigmoid()[0, 0].float().cpu().numpy()
        return mask_of(Image.fromarray((alpha * 255).astype("uint8")), picture.size)

    def repaint(self, photo, depth, lines, outfit, strength, seed):
        generator = self.torch.Generator("cuda").manual_seed(seed)
        return self.pipe(
            prompt=prompt_for(outfit),
            negative_prompt=NEGATIVE,
            image=photo,
            control_image=[depth, lines],
            strength=strength,
            num_inference_steps=STEPS,
            guidance_scale=6.0,
            controlnet_conditioning_scale=[0.6, 0.45],
            control_guidance_end=[0.9, 0.8],
            generator=generator,
        ).images[0]

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def look(self, request: dict):
        """{photo, depth, mask: base64 PNGs; outfit: words; seed?} -> {ok, image?: base64 PNG, iou, error?}"""
        return self.paint_request(request)

    @modal.method()
    def paint(self, request: dict):
        """The same as `look`, for `modal run` (see try_photos below)."""
        return self.paint_request(request)

    def paint_request(self, request):
        try:
            photo = load(base64.b64decode(request["photo"]))
            size = sdxl_size(*photo.size)
            photo = photo.resize(size)
            mask_picture = load(base64.b64decode(request["mask"]), "L").resize(size)
            depth = stretch_depth(load(base64.b64decode(request["depth"])).resize(size), mask_picture)
            lines = guide_edges(photo, mask_picture)
            outfit = str(request.get("outfit", ""))
            seed = int(request.get("seed", 7)) % 2**31
        except (KeyError, ValueError, TypeError):
            return {"ok": False, "error": "invalid"}

        wanted = mask_of(mask_picture)
        best = 0.0
        for strength in STRENGTHS:
            painted = self.repaint(photo, depth, lines, outfit, strength, seed)
            overlap = iou(wanted, self.outline(painted))
            best = max(best, overlap)
            if overlap >= LEAST_IOU:
                return {"ok": True, "image": base64.b64encode(png(painted)).decode(), "iou": round(overlap, 3), "strength": strength}
        return {"ok": False, "error": "shape_changed", "iou": round(best, 3)}


@app.local_entrypoint()
def try_photos(folder: str, outfit: str = ""):
    """Repaints saved pictures, to check the look before the server uses it:
        modal run script/modal/studio_look.py --folder path/to/shots --outfit "olive hoodie, blue jeans"
    The folder holds NAME-photo.png, NAME-depth.png and NAME-mask.png for each shot; NAME-look.png is
    written next to them, and each shot's overlap is printed."""
    import pathlib

    shots = sorted(pathlib.Path(folder).glob("*-photo.png"))
    studio = Studio()
    for photo in shots:
        name = photo.name[: -len("-photo.png")]
        request = {
            kind: base64.b64encode((photo.parent / f"{name}-{kind}.png").read_bytes()).decode()
            for kind in ("photo", "depth", "mask")
        }
        answer = studio.paint.remote({**request, "outfit": outfit})
        if answer.get("ok"):
            (photo.parent / f"{name}-look.png").write_bytes(base64.b64decode(answer["image"]))
        print(name, "ok" if answer.get("ok") else answer.get("error"), "overlap", answer.get("iou"), "strength", answer.get("strength"))
