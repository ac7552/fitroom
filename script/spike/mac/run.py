"""How fast, and how good, FASHN VTON 1.5 is on this Mac at fewer steps and lower precision. Every run is timed,
put through the validator's three gates, and compared with the full-quality picture (fp32, most steps), and
all of it lands on one contact sheet. docs/ai-spike.md, "On the Mac", says what to look for.

    script/spike/mac/setup.sh                                         # once: the venv and the weights (~2.5 GB)
    tmp/venv-mac/bin/python script/spike/mac/run.py --smoke           # every code path, a couple of minutes
    tmp/venv-mac/bin/python script/spike/mac/run.py --quick           # one item, the likely answers (~15 min)
    tmp/venv-mac/bin/python script/spike/mac/run.py                   # both items, the whole grid (~45 min)
    tmp/venv-mac/bin/python script/spike/mac/run.py --configs fp16:16,hybrid:16

The inputs are the spike's (tmp/spike: NAME-person.png, NAME-garment.jpg, NAME-category.txt, NAME-outline.png,
as inputs.mjs makes them). Out: tmp/spike/mac/<time>/ with NAME-<run>.png, sheet.png, summary.md, results.json.
The Mac stays as it is: the pictures are made here, nothing is uploaded.
"""

import argparse
import datetime
import faulthandler
import json
import os
import platform
import re
import resource
import subprocess
import sys
import time
import warnings

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
# Before torch is imported: an operation Apple's GPU lacks runs on the CPU instead of failing (each such
# operation is listed in results.json, as it slows the run), and the weights are where setup.sh put them.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("FASHN_PARSER", "off")
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "tmp", "weights", "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "script", "modal"))
import plan  # noqa: E402

BEGAN = time.time()
LOG = []
faulthandler.enable()  # a hard crash in the GPU code still prints where Python was


LIVE = {"log": None, "stacks": None}
WARNED = set()
QUIET_SECONDS = 90  # this long without a line, and where Python is goes into stacks.txt (again every 90 s)


def say(message):
    """A line on the terminal and, once the out folder exists, in its log.txt at once (so a run that stalls
    or is stopped still leaves its story). Each line restarts the quiet-time clock for stacks.txt."""
    line = f"[{time.time() - BEGAN:7.1f} s] {message}"
    print(line, flush=True)
    LOG.append(line)
    if LIVE["log"]:
        LIVE["log"].write(line + "\n")
        LIVE["log"].flush()
    if LIVE["stacks"]:
        faulthandler.cancel_dump_traceback_later()
        faulthandler.dump_traceback_later(QUIET_SECONDS, repeat=True, file=LIVE["stacks"])


def go_live(out):
    LIVE["log"] = open(os.path.join(out, "log.txt"), "w")
    LIVE["log"].write("\n".join(LOG) + "\n")
    LIVE["log"].flush()
    LIVE["stacks"] = open(os.path.join(out, "stacks.txt"), "w")
    faulthandler.enable(file=LIVE["stacks"])
    faulthandler.dump_traceback_later(QUIET_SECONDS, repeat=True, file=LIVE["stacks"])


def arguments(argv):
    p = argparse.ArgumentParser(description="FASHN VTON 1.5 on this Mac: steps x precision.")
    p.add_argument("--inputs", default=os.path.join(ROOT, "tmp", "spike"), help="the spike's inputs (default tmp/spike)")
    p.add_argument("--out", default=None, help="where the results go (default tmp/spike/mac/<time>)")
    p.add_argument("--weights", default=os.path.join(ROOT, "tmp", "weights"), help="setup.sh's weights (default tmp/weights)")
    preset = p.add_mutually_exclusive_group()
    preset.add_argument("--smoke", action="store_true", help=f"one item, {plan.PRESETS['smoke']}: checks everything works")
    preset.add_argument("--quick", action="store_true", help=f"one item, {plan.PRESETS['quick']}")
    preset.add_argument("--configs", default=None, help=f"runs as precision:steps (default {plan.PRESETS['full']})")
    p.add_argument("--items", default=None, help="only these items (names, comma-separated)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--device", default=None, help="mps (default on a Mac), cuda or cpu")
    p.add_argument("--checker-device", default="cpu", help="where the gates' models run (default cpu: off the clock)")
    p.add_argument("--no-checks", action="store_true", help="skip the gates and the likeness (times only)")
    p.add_argument("--no-warmup", action="store_true", help="skip the short untimed run after each load")
    return p.parse_args(argv)


def machine():
    """The Mac this ran on: chip, memory, macOS, and the libraries."""
    import torch

    def sysctl(name):
        try:
            return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            return None

    def gpu_cores():
        try:
            shown = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True, timeout=20).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        found = re.search(r"Total Number of Cores:\s*(\d+)", shown)
        return int(found.group(1)) if found else None

    memory = sysctl("hw.memsize")
    return {
        "chip": sysctl("machdep.cpu.brand_string") or platform.processor() or platform.machine(),
        "memory_gb": round(int(memory) / 2**30) if memory and memory.isdigit() else None,
        "gpu_cores": gpu_cores(),
        "macos": platform.mac_ver()[0] or platform.platform(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
        "mps_built": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_built()),
    }


def pick_device(name):
    import torch

    if name:
        return torch.device(name)
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_items(folder, only):
    """The spike's inputs as pictures: [{"name", "person", "garment", "category", "outline"}]."""
    import tryon_engine as engine

    shots = engine.shots_in(folder, say)
    if only:
        wanted = {n.strip() for n in only.split(",") if n.strip()}
        shots = [s for s in shots if s["name"] in wanted]
    items = []
    for shot in shots:
        got = engine.parse_request({k: v for k, v in shot["request"].items() if v is not None})
        items.append({"name": shot["name"], "person": got["person"], "garment": got["garment"],
                      "category": got["category"], "outline": got["pictures"].get("outline")})
    return items


def one_run(pipe, item, seed, steps):
    """One try-on: the picture and its numbers (the whole call, the sampling alone, any CPU fallbacks)."""
    import tryon_engine as engine

    caught = []

    def shown(message, category, filename, lineno, file=None, line=None):
        # Said as it happens (a fallback to the CPU is the likeliest reason a run crawls), and kept.
        text = str(message).strip()
        caught.append(text)
        if text not in WARNED:
            WARNED.add(text)
            say(f"warning: {text.splitlines()[0][:220] if text else category.__name__}")

    began = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("always")
        warnings.showwarning = shown
        picture = engine.run_fashn(pipe, item["person"], item["garment"], item["category"], flat_lay=True, seed=seed, steps=steps)
    sample = pipe.last_sample or {}
    fallbacks = sorted({m.split(" is not")[0] for m in caught if "MPS" in m and "fall back" in m})
    return picture, {
        "wall_seconds": round(time.perf_counter() - began, 2),
        "sample_seconds": sample.get("seconds"),
        "finite": sample.get("finite", False),
        "memory_gb": sample.get("memory_gb"),
        "fallbacks": fallbacks,
    }


def make_runs(items, configs, baseline, device, args, out):
    """Every config on every item, one model load per precision (plan.run_order). Returns (runs, pictures,
    notes): runs as dicts, pictures {(item, config name): PIL}, and what happened to whole precisions."""
    import precision as prec

    runs, pictures, notes = [], {}, {}
    seed = args.seed
    for precision, step_list in plan.run_order(configs, baseline):
        problem = prec.probe(device, precision)
        if problem:
            say(f"{precision}: not on this {device.type} ({problem}); skipped")
            notes[precision] = f"unsupported: {problem}"
            for item in items:
                for steps in step_list:
                    runs.append({"item": item["name"], "config": plan.Config(precision, steps).name, "precision": precision,
                                 "steps": steps, "error": "unsupported here", "finite": False})
            continue
        say(f"loading FASHN at {precision}...")
        began = time.time()
        try:
            pipe = prec.spike_pipeline(os.path.join(args.weights, "fashn"), device, precision, seed=seed)
        except Exception as error:  # noqa: BLE001
            say(f"{precision}: didn't load ({type(error).__name__}: {error})")
            notes[precision] = f"load failed: {type(error).__name__}: {str(error)[:200]}"
            for item in items:
                for steps in step_list:
                    runs.append({"item": item["name"], "config": plan.Config(precision, steps).name, "precision": precision,
                                 "steps": steps, "error": "load failed", "finite": False})
            prec.free(device)
            continue
        notes[precision] = {"load_seconds": round(time.time() - began, 1)}
        say(f"{precision} loaded in {notes[precision]['load_seconds']} s")
        if not args.no_warmup:
            # The first pictures on a GPU pay for setting it up (Apple's compiles its kernels): untimed.
            try:
                _, warm = one_run(pipe, items[0], seed, 2)
                notes[precision]["warmup_seconds"] = warm["wall_seconds"]
                say(f"{precision} warmed up in {warm['wall_seconds']} s")
            except Exception as error:  # noqa: BLE001 - the runs below will say what's wrong, one by one
                notes[precision]["warmup_error"] = one_line(error)
                say(f"{precision} warm-up failed ({one_line(error)})")
        for item in items:
            for steps in step_list:
                config = plan.Config(precision, steps)
                run = {"item": item["name"], "config": config.name, "precision": precision, "steps": steps}
                say(f"{item['name']} {config.title}: running...")
                try:
                    picture, numbers = one_run(pipe, item, seed, steps)
                    run.update(numbers)
                    pictures[(item["name"], config.name)] = picture
                    picture.save(os.path.join(out, f"{item['name']}-{config.name}.png"))
                    extra = "" if numbers["finite"] else ", NaN: picture lost"
                    if numbers["fallbacks"]:
                        extra += f", {len(numbers['fallbacks'])} operations fell back to the CPU"
                    say(f"{item['name']} {config.title}: {numbers['sample_seconds']} s sampling, {numbers['wall_seconds']} s in all{extra}")
                except Exception as error:  # noqa: BLE001 - one failed run shouldn't end the spike
                    run.update(error=one_line(error), finite=False)
                    say(f"{item['name']} {config.title}: failed ({run['error']})")
                runs.append(run)
        del pipe
        prec.free(device)
    return runs, pictures, notes


def one_line(error):
    text = str(error).strip()
    return f"{type(error).__name__}: {text.splitlines()[0][:160]}" if text else type(error).__name__


def judge(items, runs, pictures, baseline, checker_device):
    """The validator's three gates on every picture (engine.check, as on Kaggle and Modal), and its likeness to
    the baseline's picture of the same item, over the figure: DINOv2 cosine of the crops and SSIM. In place."""
    import torch
    import tryon_engine as engine
    import validate

    checker = engine.load_checker(torch.device(checker_device))
    # The shop photo and the render are cut out once per item, not once per run.
    steady = {id(item[k]): item[k] for item in items for k in ("person", "garment")}
    cuts, cutout = {}, checker.cutout

    def cached_cutout(picture):
        key = id(picture)
        if key not in steady:
            return cutout(picture)
        if key not in cuts:
            cuts[key] = cutout(picture)
        return cuts[key]

    checker.cutout = cached_cutout
    by_item = {item["name"]: item for item in items}
    embeds = {}
    for run in runs:
        picture = pictures.get((run["item"], run["config"]))
        if picture is None or not run.get("finite"):
            continue
        item = by_item[run["item"]]
        began = time.time()
        try:
            run["checks"] = engine.check(checker, picture, item["person"], item["outline"], item["garment"], None,
                                         item["category"], None, True)
        except Exception as error:  # noqa: BLE001
            run["check_error"] = one_line(error)
        reference = pictures.get((run["item"], baseline.name))
        if reference is not None and run["config"] != baseline.name:
            mask = item["outline"] if item["outline"] is not None else checker.cutout(item["person"])
            box = plan.bbox(mask, reference.size)
            if run["item"] not in embeds:
                embeds[run["item"]] = checker.embed(reference.crop(box))
            run["vs_full"] = {
                "dino": round(validate.cosine(embeds[run["item"]], checker.embed(picture.resize(reference.size).crop(box))), 4),
                "ssim": plan.ssim_in(reference, picture, mask),
            }
        run["check_seconds"] = round(time.time() - began, 1)
        verdict = "-" if "checks" not in run else ("PASS" if run["checks"]["ok"] else "REFUSED")
        say(f"{run['item']} {run['config']}: {verdict}{'' if 'vs_full' not in run else ' · like full ' + str(run['vs_full']['dino'])}")


def main(argv=None):
    args = arguments(argv)
    try:
        configs = plan.parse_configs(plan.PRESETS["smoke"] if args.smoke else plan.PRESETS["quick"] if args.quick else args.configs or plan.PRESETS["full"])
    except ValueError as error:
        sys.exit(f"--configs: {error}")
    configs, baseline, note = plan.with_baseline(configs)
    if note:
        say(note)

    if not os.path.exists(os.path.join(args.weights, "fashn", "model.safetensors")):
        sys.exit(f"No FASHN weights in {args.weights}/fashn. Run script/spike/mac/setup.sh first.")
    items = load_items(args.inputs, args.items)
    if not items:
        sys.exit(f"No inputs in {args.inputs} (NAME-person.png with NAME-garment.jpg). Make them with script/spike/inputs.mjs.")
    if args.smoke or args.quick:
        items = items[:1]
    if args.smoke:
        args.no_warmup = True  # its runs are as short as a warm-up

    import precision as prec

    device = pick_device(args.device)
    info = machine()
    say(f"{info['chip']}, {info['memory_gb']} GB, macOS {info['macos']} | torch {info['torch']} on {device}")
    if device.type == "cpu" and not args.device:
        # On the CPU fp16 is emulated: a 2-step smoke picture takes a quarter of an hour, and no time means much.
        hint = ("PyTorch 2.9 and later use Apple's GPU only on macOS 14 or newer: run script/spike/mac/setup.sh again "
                "(on macOS 13 it installs PyTorch 2.8) or update macOS"
                if info["mps_built"] and info["macos"].split(".")[0].isdigit() and int(info["macos"].split(".")[0]) < 14
                else "this PyTorch can't see Apple's GPU")
        say(f"stopped: no Apple GPU (torch {info['torch']}, macOS {info['macos']}): {hint}. --device cpu runs anyway.")
        sys.exit(1)
    if prec.patch_rope(device):
        say("positional embedding computed on the CPU (Apple's GPU has no float64)")
    say(f"{len(items)} item(s) x {len(configs)} run(s): {', '.join(c.name for c in configs)}; reference {baseline.name}")

    out = args.out or os.path.join(ROOT, "tmp", "spike", "mac", datetime.datetime.now().strftime("%Y%m%d-%H%M"))
    os.makedirs(out, exist_ok=True)
    go_live(out)
    say(f"writing to {out} (log.txt as it goes; stacks.txt if it goes quiet for {QUIET_SECONDS} s)")
    runs, pictures, notes = make_runs(items, configs, baseline, device, args, out)
    if not args.no_checks:
        say("checking the pictures (off the clock)...")
        judge(items, runs, pictures, baseline, args.checker_device)

    rows = plan.summarize(runs, configs, baseline)
    pick = plan.recommend(rows, baseline)
    summary = plan.table(rows, baseline)
    captions = {(r["item"], r["config"]): plan.caption(r, baseline) for r in runs}
    sheet_items = [{"name": i["name"], "shop": i["garment"], "render": i["person"]} for i in items]
    plan.sheet(sheet_items, configs, pictures, captions).save(os.path.join(out, "sheet.png"))
    max_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    results = {
        "machine": info,
        "settings": {"seed": args.seed, "device": str(device), "checker_device": args.checker_device,
                     "configs": [c.name for c in configs], "reference": baseline.name, "items": [i["name"] for i in items]},
        "precisions": notes,
        # Operations Apple's GPU lacked, run on the CPU instead (torch warns once per operation per process).
        "cpu_fallbacks": sorted({f for r in runs for f in r.get("fallbacks", [])}),
        "runs": runs,
        "summary": rows,
        "recommendation": pick,
        "max_rss_gb": round(max_rss / (1e9 if sys.platform == "darwin" else 1e6), 2),
    }
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    heading = f"# FASHN VTON 1.5 on {info['chip']} ({info['memory_gb']} GB)\n\n"
    with open(os.path.join(out, "summary.md"), "w") as f:
        f.write(heading + summary + f"\n\n**Pick:** {pick['pick'] or 'none'}: {pick['why']}\n")
    say("\n" + summary)
    say(f"pick: {pick['pick'] or 'none'}: {pick['why']}")
    if args.smoke:
        say("smoke run: 2 steps make a rough picture, so REFUSED is expected; what matters is that every precision "
            "made one (no 'failed', no NaN). Next: --quick")
    say(f"wrote {out}/sheet.png, summary.md and results.json")
    faulthandler.cancel_dump_traceback_later()
    LIVE["log"].close()


if __name__ == "__main__":
    main()
