"""The torch side of the Mac spike: FASHN VTON 1.5 loaded at one precision (see plan.py for the four), with a
sampler that times itself and starts every run from the same noise, so pictures at different precisions and
step counts can be laid side by side.

Two things FASHN's own pipeline (src/fashn_vton/pipeline.py at tryon_engine.FASHN_COMMIT) does that this
changes, and why:

- The starting noise is drawn on the CPU in fp32 from the seed, then moved and cast. The pipeline draws it on
  the device in the inference dtype, so fp16 and fp32 would start from different noise and their pictures
  couldn't be compared.
- Apple's GPU (MPS) has no float64, and the model's positional embedding (tryon_mmdit.rope) is computed in
  float64 on the device it runs on: on a Mac it would stop there. It's computed on the CPU instead (the same
  numbers) and moved over. See patch_rope.
"""

import gc
import os
import sys
import time
import types

import torch
import torch.nn.functional as F
from torch import nn

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "modal"))
from tryon_engine import NoParser  # noqa: E402

DTYPES = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16, "hybrid": torch.float16}
F16_MAX = 65504.0  # the largest fp16 number


def sync(device):
    """Waits for the GPU to finish what it was given (its work runs ahead of Python), so a time is true."""
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize()


def free(device):
    gc.collect()
    if device.type == "mps":
        torch.mps.empty_cache()
    elif device.type == "cuda":
        torch.cuda.empty_cache()


def memory_gb(device):
    """What the GPU driver holds for this process (GB), or None off a GPU. On a Mac that's shared memory."""
    if device.type == "mps":
        return round(torch.mps.driver_allocated_memory() / 1e9, 2)
    if device.type == "cuda":
        return round(torch.cuda.max_memory_allocated() / 1e9, 2)
    return None


def probe(device, precision):
    """None when the device runs the model's kinds of operation at this precision (attention, layer norm, a
    linear layer, the patch convolution), else why not, in a line. bf16 on a Mac needs a recent macOS."""
    dtype = DTYPES[precision]
    try:
        x = torch.randn(1, 2, 64, 32).to(device, dtype)
        attended = F.scaled_dot_product_attention(x, x, x)
        normed = F.layer_norm(torch.randn(4, 64).to(device, dtype), (64,))
        linear = F.linear(normed, torch.randn(32, 64).to(device, dtype))
        conv = F.conv2d(torch.randn(1, 3, 24, 24).to(device, dtype), torch.randn(8, 3, 12, 12).to(device, dtype), stride=12)
        sync(device)
        if not all(bool(torch.isfinite(t).all()) for t in (attended, normed, linear, conv)):
            return "a test sum came out NaN"
        return None
    except Exception as error:  # noqa: BLE001 - any failure is the answer
        return f"{type(error).__name__}: {str(error).strip().splitlines()[0][:160]}"


def patch_rope(device):
    """On Apple's GPU, computes the positional embedding on the CPU (float64 there, as FASHN does) and moves
    it over: MPS has no float64. Elsewhere nothing changes. Returns whether it patched."""
    if device.type != "mps":
        return False
    import fashn_vton.tryon_mmdit as mmdit

    if getattr(mmdit.rope, "on_cpu", False):
        return True
    original = mmdit.rope

    def rope(pos, dim, theta):
        return original(pos.to("cpu"), dim, theta).to(pos.device)

    rope.on_cpu = True
    mmdit.rope = rope  # EmbedND.forward looks `rope` up in the module each call
    return True


def patch_attention(device, chunk=1024):
    """On Apple's GPU, attention a block of `chunk` queries at a time. The double and single blocks attend over
    6912 tokens (the picture's and the garment's): in one go that's a 2 x 10 x 6912 x 6912 score matrix, 3.8 GB in
    fp32, which on a 16 GB Mac pushes everything else into swap (the owner's smoke run sat in its first double
    block for minutes). Each query's softmax is its own, so the result is the same, a few hundred MB at a time.
    chunk 0 leaves attention as it is. Returns whether it patched."""
    if device.type != "mps" or not chunk:
        return False
    import fashn_vton.tryon_mmdit as mmdit

    if getattr(mmdit._attn_processor, "chunk", None) == chunk:
        return True

    def attend(q, k, v):
        length = q.shape[-2]
        if length <= chunk:
            return F.scaled_dot_product_attention(q, k, v)
        return torch.cat([F.scaled_dot_product_attention(q[..., i:i + chunk, :], k, v) for i in range(0, length, chunk)], dim=-2)

    attend.chunk = chunk
    mmdit._attn_processor = attend  # attention() looks `_attn_processor` up in the module each call
    return True


# hybrid ------------------------------------------------------------------------------------------------------

def _layer_norm_fp32(self, x):
    """nn.LayerNorm's forward, worked in fp32 and handed back in the input's dtype."""
    weight = None if self.weight is None else self.weight.float()
    bias = None if self.bias is None else self.bias.float()
    return F.layer_norm(x.float(), self.normalized_shape, weight, bias, self.eps).to(x.dtype)


def _within_fp16(module, inputs, output):
    """A block's output held inside fp16's range: one value past it would be inf, then NaN everywhere after."""
    if isinstance(output, tuple):
        return tuple(o.clamp(-F16_MAX, F16_MAX) for o in output)
    return output.clamp(-F16_MAX, F16_MAX)


def make_hybrid(model):
    """An fp16 TryOnModel with fp32 where fp16 loses most: every layer norm works in fp32; the time embedding
    is made in fp32 from an fp32 time (in fp16, 1000·t is rounded to the nearest half step); the last layer,
    which turns the blocks' output into the picture's velocity, runs in fp32 and answers in fp32; and every
    block's output is clamped into fp16's range. The sampler keeps its picture in fp32 (SpikePipeline)."""
    from fashn_vton.tryon_mmdit import DoubleStreamBlock, SingleStreamBlock

    half = next(model.parameters()).dtype
    for module in model.modules():
        if isinstance(module, nn.LayerNorm):
            module.forward = types.MethodType(_layer_norm_fp32, module)
        if isinstance(module, (DoubleStreamBlock, SingleStreamBlock)):
            module.register_forward_hook(_within_fp16)

    model.t_embedder.float()
    time_forward = model.t_embedder.forward
    model.t_embedder.forward = lambda t: time_forward(t.float()).to(half)

    model.final_layer.float()
    last_forward = model.final_layer.forward
    model.final_layer.forward = lambda x, vec: last_forward(x.float(), vec.float())
    return model


# The pipeline ------------------------------------------------------------------------------------------------

def spike_pipeline(weights_dir, device, precision, seed=7):
    """FASHN's TryOnPipeline at `precision` on `device`, with the spike's sampler (see SpikePipeline)."""
    from fashn_vton import TryOnPipeline
    from fashn_vton.utils import get_rf_schedule, tensor_to_pil

    class SpikePipeline(TryOnPipeline):
        """After each call, `last_sample` holds {seconds, steps, finite, memory_gb} for the sampling alone."""

        def __init__(self):
            self.spike_precision = precision
            self.noise_seed = seed
            self.guided_steps = None  # None: FASHN's own, guidance on every step but the last
            # A guided step's two passes one after the other (batch 1 each) rather than side by side (batch 2):
            # on the owner's M2 Pro a batch-2 step took ~25 s against ~7 s for one batch-1 pass.
            self.split_guidance = True
            self.last_sample = None
            super().__init__(weights_dir=weights_dir, device=str(device))

        def _setup_tryon_model(self):
            # As the pipeline's own (load the checkpoint, cast, eval), at the spike's dtype, then the hybrid's
            # changes. The model is built empty (on the meta device) and handed the checkpoint's own tensors, so
            # the CPU never holds a second, fp32 copy of the weights beside them (~4 GB more on a 16 GB Mac).
            from safetensors.torch import load_file
            from fashn_vton.tryon_mmdit import TryOnModel

            self.inference_dtype = DTYPES[self.spike_precision]
            state = load_file(os.path.join(self.weights_dir, "model.safetensors"), device="cpu")
            with torch.device("meta"):
                model = TryOnModel()
            model.load_state_dict(state, assign=True)
            del state
            model.to(self.device, dtype=self.inference_dtype).eval()
            if self.spike_precision == "hybrid":
                make_hybrid(model)
            self.tryon_model = model

        def _setup_hp_model(self):
            # The research-only parser stays off, as on Kaggle (flat-lay shop photos never read it).
            self.hp_model = NoParser()

        @torch.inference_mode()
        def _sample(self, *, ca_images, garment_images, person_poses, garment_poses, garment_categories,
                    num_timesteps=30, time_shift_mu=1.5, guidance_scale=1.5, skip_cfg_last_n_steps=1, use_tqdm=True):
            # FASHN's Euler sampler with classifier-free guidance (pipeline.py, _sample), line for line, but
            # for the noise (drawn on the CPU from the seed), for hybrid the picture kept in fp32, and the steps
            # without guidance: FASHN still runs both passes there and keeps one; here they're one pass, the
            # garment's (forward with no mask is forward_for_cfg's first half), so they cost half as much.
            model = self.tryon_model
            dev, dtype = ca_images.device, ca_images.dtype
            carry = torch.float32 if self.spike_precision == "hybrid" else dtype
            batch = ca_images.shape[0]
            c, h, w = model.channels_in, *model.input_shape
            noise = torch.randn((batch, c, h, w), generator=torch.Generator("cpu").manual_seed(self.noise_seed), dtype=torch.float32)
            images = noise.to(dev, carry)
            timesteps = get_rf_schedule(num_steps=num_timesteps, mu=time_shift_mu)
            kwargs = {
                "person_poses": person_poses, "garment_poses": garment_poses, "ca_images": ca_images,
                "garment_images": garment_images, "garment_categories": garment_categories,
            }
            sync(dev)
            began = time.perf_counter()
            guided = num_timesteps - skip_cfg_last_n_steps if self.guided_steps is None else self.guided_steps
            for i, (t_curr, t_prev) in enumerate(zip(timesteps[:-1], timesteps[1:])):
                t_vec = torch.full((batch,), t_curr, dtype=carry, device=dev)
                if i < guided and self.split_guidance:
                    # forward_for_cfg's two halves as two calls: with the garment (no mask), then without (a
                    # mask of False drops the picture, poses, garment and category, as its second half does).
                    x = images.to(dtype)
                    v_c = model(x, t_vec, **kwargs)["x"].to(carry)
                    v_u = model(x, t_vec, mask=torch.zeros(batch, dtype=torch.bool, device=dev), **kwargs)["x"].to(carry)
                    v = v_u + guidance_scale * (v_c - v_u)
                elif i < guided:
                    pred = model.forward_for_cfg(images.to(dtype), t_vec, **kwargs)
                    v_c, v_u = pred["v_c"].to(carry), pred["v_u"].to(carry)
                    v = v_u + guidance_scale * (v_c - v_u)
                else:
                    v = model(images.to(dtype), t_vec, **kwargs)["x"].to(carry)
                images = images + (t_prev - t_curr) * v
            finite = bool(torch.isfinite(images).all())
            sync(dev)
            self.last_sample = {
                "seconds": round(time.perf_counter() - began, 2),
                "steps": num_timesteps,
                "guided": min(guided, num_timesteps),
                "finite": finite,
                "memory_gb": memory_gb(dev),
            }
            images = images.to(dtype=torch.float).clamp_(-1.0, 1.0)
            return [tensor_to_pil(img.cpu(), unnormalize=True) for img in images]

    return SpikePipeline()
