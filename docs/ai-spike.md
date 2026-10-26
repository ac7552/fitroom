# AI try-on spike: our own models in place of the paid API

Fitroom's "Exact item (AI)" photo has paid FASHN's hosted API to paint the shop's photo onto the mannequin
render. This spike runs two open-source try-on models on Fitroom's own GPU service instead, puts a validator
in front of anything the page shows, and adds a compare panel so a person has the last word.

The rule that doesn't move: the only picture that leaves the device is the mannequin's render (and the shop's
own photo, which is public). No photo of a person, no measurements. Nothing is stored or logged, on the server
or on the service.

Files:

| File | What it is |
|---|---|
| `script/modal/tryon_engine.py` | The engine, no Modal in it: loads and runs FASHN VTON 1.5 and Leffa, the validator, the sheet (`run_sheet`). Picks cuda+bf16, cuda+fp16 (T4) or fp32 by the hardware. `python3 -m unittest script/modal/test_tryon_engine.py` for its pure parts. |
| `script/modal/tryon_spike.py` | The Modal app round the engine: the image, the container, the `tryon` endpoint for the server, `modal run`. |
| `script/colab/fitroom_tryon_spike.ipynb` | The same engine in a Google Colab notebook on a free T4, see "Running on Google Colab". |
| `script/spike/inputs.mjs` | On the Mac, against the running app: store links in, `tmp/spike/spike.zip` of the sheet's inputs out, see "Making the inputs". Its pure parts (`script/spike/lib.mjs`): `node --test test/javascript/spike_inputs.test.mjs`. |
| `script/modal/validate.py` | The three gates (shape, identity, print). Runs on a CPU; `python3 -m unittest script/modal/test_validate.py`. |
| `script/modal/tryon_prep.py` | Pose conversion, letterboxing, the sheet. `python3 -m unittest script/modal/test_tryon_prep.py`. |
| `app/models/try_on.rb` | Talks to the service (or, as a fallback, FASHN's API). `test/models/try_on_test.rb`. |
| `app/models/studio_photo.rb` | Carries the checks (`exact_checks`) with the job; keeps the draped picture when a garment is refused. |
| `fitting_room_controller.js` (`showCompare`, `acceptAi`, `rejectAi`) | The Compare view and the human gate. |

## Running the spike

### Running on Google Colab (free)

Modal will not start a GPU function until the account has a payment method on file, even inside the free
credit. Without a card, run the spike on Google Colab's free T4 instead; it is the same engine
(`tryon_engine.py`) with fp16 in place of bf16.

1. Open the notebook: `https://colab.research.google.com/github/ac7552/fitroom/blob/main/script/colab/fitroom_tryon_spike.ipynb`
   (once this branch is on GitHub `main`; until then, in Colab, File → Upload notebook and pick
   `script/colab/fitroom_tryon_spike.ipynb` from the checkout).
2. Runtime → Change runtime type → **T4 GPU** → Save.
3. Runtime → Run all. The install takes about 10 minutes (the weights, around 10 GB, download into the
   session). The notebook stops once to ask for your files: pick the one `tmp/spike/spike.zip` that
   `node script/spike/inputs.mjs` made on the Mac ("Making the inputs", below). Loose files work too
   (every `NAME-person.png`, `NAME-garment.jpg`, `NAME-category.txt` and the optional ones, in one go).
   Running it all again later in the same session is safe: the upload cell empties its folder first (and
   takes Colab's ` (1)` off a re-uploaded name), and the run cell pulls the latest engine from GitHub
   before it runs.
4. Step 4's form picks the models (`both`, `fashn`, `leffa`) and whether FASHN's research-only parser is on
   (off by default; the garment photos are then read as flat-lay product shots). 30 to 90 seconds per picture
   per model.
5. The sheet shows inline; the last cell downloads a zip of the folder (`sheet.png`, `results.json`,
   `NAME-fashn.png`, `NAME-leffa.png`, your inputs).

What to know about a free Colab session: it ends after about 90 minutes idle and 12 hours at most, and the
disk goes with it, so the weights download again each new session (the zip is how the results survive). The
T4 has 15 GB, so the notebook loads one model at a time, runs every picture through it, frees it, and loads
the next. Colab's own `torch` is used as shipped; the other libraries are pinned as the Modal image pins them.

### Running on Modal

Once, with a Modal account (`pip install modal && modal setup`) **and a payment method on the account**
(Settings → Billing; Modal refuses GPU functions without one, free credit or not). Then, from the repo's root
on the Mac:

```sh
# A folder of inputs (see below) -> NAME-fashn.png, NAME-leffa.png, sheet.png, results.json next to them
modal run script/modal/tryon_spike.py::spike --sheet tmp/spike

# One pair
modal run script/modal/tryon_spike.py::spike --person tmp/render.png --garment tmp/shop.jpg --category tops --out tmp/out

# Useful flags
#   --model fashn|leffa|both   --seed 7   --steps 30   --flat-lay (the shop photo is a product shot, not on a model)
#   --mask tmp/mask.png        the garment's outline in the render (white on black), for Leffa and the validator
#   --outline tmp/outline.png  the figure's outline, for the shape gate (else the render's own cut-out is used)
#   --print-mask tmp/print.png the print region, for the print gate (else skipped)
#   --pose-json tmp/pose.json  keypoints for FASHN (else DWPose looks for a person in the render)
```

The first run builds the image (both repos at pinned commits, every weight downloaded at build; expect 20 to
40 minutes and a large image). After that a cold start is about a minute, and each picture takes seconds to
tens of seconds on an L4; `results.json` has the exact timings (`seconds` for the model, `check_seconds` for
the gates, `wall_seconds` end to end).

To run FASHN without its human parser (see the licence table): `FASHN_PARSER=off modal run ...` at build time.
This bakes into the image; rebuild to change it.

### The sheet folder

For each NAME:

| File | Needed | What |
|---|---|---|
| `NAME-person.png` | yes | The mannequin render (the page's photo, see below). |
| `NAME-garment.jpg` (or .png/.webp) | yes | The shop's photo of the item. |
| `NAME-category.txt` | no | `tops` or `bottoms` (default tops). |
| `NAME-outline.png` | no | The figure's outline, white on black, from the same camera. |
| `NAME-mask.png` | no | The garment's outline in the render. Lets Leffa skip its own parser and OpenPose; gives the validator the garment's region. |
| `NAME-print.png` | no | The print region: either the shop photo's size (white where the print is), or the page's `print.image` (the garment's front, collar to hem). |
| `NAME-pose.json` | no | FASHN's pose, see "Pose JSON". |

`sheet.png` has a row per NAME: store photo | our render | FASHN | Leffa, with each gate's score, the time and
PASS/REFUSED under the AI columns. `results.json` has the same as numbers.

### What the first run showed (26 Oct, free T4)

The Kith Adley striped hoodie, FASHN VTON 1.5, 66 s: shape 0.95 (pass), colour dE 6.5 (pass), look 0.43. The
picture was good (continuous knit in the shop's stripe order, a real collar and cuffs, no skin or hair on
the mannequin), but two lessons:

- **Photograph from the front.** The page's reveal turn was mid-way, so the render was a side view, and
  the model invented a placket where the zip was hidden and lost the hood. `photoPasses({ front: true })`
  now turns the camera to the front for the picture and back after.
- **The identity gate is relative now.** A flat shop photo and a garment worn on a body never embed alike
  (0.4-0.6 is usual), so a fixed 0.80 refused a good picture. With the render given, the bar is the
  render's own likeness to the shop photo less 0.05, never under 0.35 (`validate.py`: RELATIVE_SLACK,
  IDENTITY_FLOOR). The sheet prints the baseline next to the score.

### Making the inputs from the running app

One command on the Mac, with the app running (`bin/dev`, http://localhost:3000) and Playwright installed
once (`npm i -g playwright`; it drives the Chrome already on the Mac, no browser download):

```sh
node script/spike/inputs.mjs https://kith.com/products/... https://zara.com/... [--base http://localhost:3000] [--out tmp/spike] [--body men|women]
```

For each link it opens the page in a headless Chrome, pastes the link into "Paste a link from a store",
clicks Add, waits for the fit and for the cloth to settle (up to 4 minutes a link), then saves
`NAME-person.png` and `NAME-outline.png` (`photoPasses`, from the front), `NAME-garment.jpg` (the shop's
photo as the page holds it), `NAME-print.png` when the page read a print, and `NAME-category.txt` (`tops`
for a top, jacket or coat; `bottoms` for pants). NAME is the garment's name as a slug (else the link's last
part). Shoes, socks and belts are skipped with a note. It ends with `tmp/spike/spike.zip`, the one file the
Colab notebook asks for, and prints the folder. If the app isn't running it says so and stops.

The same by hand, as a fallback: open the page with an outfit on, wait for the cloth to settle, and in the
browser console:

```js
const c = Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller=fitting-room]'), 'fitting-room')
const save = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click() }

// The render and, from the same camera, the figure's outline (and a depth picture we don't need here).
// This is the pass the cloud studio look already uses (cloudStudioLook -> stage.photoPasses with guides).
const passes = await c.stage.photoPasses({ width: 1024, height: 1536, guides: true, front: true })  // front: the zip, print and hood face the camera
save(passes.image, 'hoodie-person.png')
save(passes.mask, 'hoodie-outline.png')

// The shop photo of an item, as the page holds it (a data: URL), and its print's front if it has one.
const item = c.items().find(i => i.kind === 'top')     // or 'trousers', 'jacket', 'coat'
save(await (await fetch(item.garment.photo)).blob(), 'hoodie-garment.jpg')
if (item.garment.print) item.garment.print.image.convertToBlob
  ? save(await item.garment.print.image.convertToBlob(), 'hoodie-print.png')
  : item.garment.print.image.toBlob(b => save(b, 'hoodie-print.png'))
```

`photoPasses` gives the whole figure's outline (every mesh drawn white), not one garment's. There is no
per-garment mask pass in `stage.js` yet; until the stream that owns `stage.js` adds one (draw only that
garment's layer with the white override material, same camera), run without `NAME-mask.png`: Leffa then uses
its own parser and OpenPose, and the validator takes the garment's region as a band of the figure by height
(`validate.band_mask`: tops 17–56% of the figure's height, bottoms 50–96%). The print mask follows the same
route: without `NAME-mask.png` the garment's box is the band's box.

### Pose JSON

For FASHN, `--pose-json` replaces DWPose's answer with the page's own keypoints (the mannequin has no face, so
DWPose may not find a person; see risks). The shape:

```json
{ "width": 1024, "height": 1536,
  "keypoints": [[x, y, c], ... 18 of them] }
```

Pixel coordinates in the person picture, OpenPose BODY_18 order: nose, neck, right shoulder, right elbow,
right wrist, left shoulder, left elbow, left wrist, right hip, right knee, right ankle, left hip, left knee,
left ankle, right eye, left eye, right ear, left ear ("right" is the mannequin's right). `c` is 1 when the
joint is there and 0 when it isn't (eyes and ears: 0). `tryon_prep.dwpose_from_openpose` turns this into
the dict FASHN's `DWposeDetector.__call__` returns (`src/fashn_vton/dwpose/dwpose.py`): `bodies.candidate`
as fractions of width and height, `bodies.subset` with each seen joint's index.

FASHN's pipeline has no way to pass a pose in, so `tryon_engine.GivenPose` stands in for `pipeline.pose_model`
for one call: `TryOnPipeline.__call__` (`src/fashn_vton/pipeline.py`) asks for the person's pose first and
the garment's second, so the first call gets the given keypoints and the rest go to DWPose.

A console sketch to export the pose from the skeleton (bone names are the model's; check
`c.stage.model.getObjectByName(name)` for any that come back null and adjust the table):

```js
const THREE = await import('three')
const cam = c.stage.camera, fov = cam.fov, aspect = cam.aspect
const W = 1024, H = 1536
cam.fov = fov * 0.85; cam.aspect = W / H; cam.updateProjectionMatrix()   // as photoPasses frames it
const at = name => { const b = c.stage.model.getObjectByName(name); if (!b) return null
  const p = b.getWorldPosition(new THREE.Vector3()).project(cam); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H] }
const joints = { r_shoulder: 'upperarm_r', r_elbow: 'lowerarm_r', r_wrist: 'hand_r', l_shoulder: 'upperarm_l', l_elbow: 'lowerarm_l', l_wrist: 'hand_l',
  r_hip: 'thigh_r', r_knee: 'calf_r', r_ankle: 'foot_r', l_hip: 'thigh_l', l_knee: 'calf_l', l_ankle: 'foot_l', nose: 'head' }
const p = Object.fromEntries(Object.entries(joints).map(([j, bone]) => [j, at(bone)]))
cam.fov = fov; cam.aspect = aspect; cam.updateProjectionMatrix()
const neck = p.r_shoulder && p.l_shoulder ? [(p.r_shoulder[0] + p.l_shoulder[0]) / 2, (p.r_shoulder[1] + p.l_shoulder[1]) / 2] : null
if (p.nose) p.nose = [p.nose[0], p.nose[1] - 0.06 * H]   // the head bone sits at the neck; the nose is above it
const order = ['nose', 'neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'r_eye', 'l_eye', 'r_ear', 'l_ear']
const pose = { width: W, height: H, keypoints: order.map(j => (j === 'neck' ? neck : p[j]) ? [...(j === 'neck' ? neck : p[j]), 1] : [0, 0, 0]) }
save(new Blob([JSON.stringify(pose)], { type: 'application/json' }), 'hoodie-pose.json')
```

## What to look for on the sheet

1. **Shape.** Did the hem, the sleeves and the leg width stay where our drape put them? The shape score is
   the overlap of the figure's outline before and after (IoU; 1.0 is identical). The gate wants 0.85. FASHN
   runs "segmentation free", which its own docs say lets a garment grow past the old outline: expect it to
   fail this gate more often than Leffa, which paints only inside the mask it's given.
2. **Identity.** Is it the same garment: the collar, the pockets, the wash, the colour? "look" is the DINOv2
   cosine between the two garment crops (gate 0.80); "colour" is the CIEDE2000 distance between their main
   colours (gate 12; under 2 is invisible, 10 is a clearly different shade).
3. **Print.** Is the print still the print? SSIM over the print region (gate 0.45). Both models redraw prints
   at their own resolution (FASHN works at 576x864, Leffa at 768x1024); lettering suffers first.
4. **The mannequin.** Did the model repaint the mannequin's hands, head or finish as skin, hair or a face?
   The gates don't look at that; the compare panel's "Not quite" is for it.
5. **Time.** `seconds` per picture against the hosted API's (10 to 20 s, after a queue).

The thresholds in `validate.THRESHOLDS` are starting points; move them once the sheet shows where good and
bad pictures land.

## The service

`modal deploy script/modal/tryon_spike.py` publishes the `tryon` endpoint. In Modal's dashboard, Settings >
Proxy Auth Tokens, make a token and put the endpoint's URL and the token's key and secret in `.env` as
`FITROOM_TRYON_URL`, `FITROOM_TRYON_KEY`, `FITROOM_TRYON_SECRET`. Requests without the token are turned away
before any GPU starts. `TRYON_MODELS=fashn` (an env on the app) loads one model instead of both.

`POST` `{ person, garment: base64 PNG/JPEG, category: "tops"|"bottoms", mask?, outline?, print?: base64 PNG,
pose?: the JSON above, model?: "fashn"|"leffa", seed? }` → `{ ok, image?: base64 PNG, checks: { shape,
identity, print, ok }, seconds }`. With `ok` false there is no image; the checks say why. The service keeps
nothing: pictures are decoded in memory and the reply is the only output. It prints nothing about a request.

The server (`TryOn.call`) sends `{ person, garment, category, mask? }`, and a refused picture leaves the
draped render in place; the checks travel with the job's status as `exact_checks` (see `docs/api.md`).

## Licences

| Piece | Licence | Note |
|---|---|---|
| FASHN VTON 1.5 (code and weights) | Apache-2.0 | Commercial use fine. |
| DWPose, YOLOX (FASHN's pose) | Apache-2.0 | |
| fashn-human-parser (FASHN's parser) | NVIDIA Source Code License for SegFormer | **Research only.** `FASHN_PARSER=off` runs without it: `segmentation_free=True` and flat-lay garments never read the parse (`preprocessing/agnostic.py`). The cost is the "model photo" garment mode, which needs the parser to cut the garment out of a photo on a model. |
| Leffa (code) | MIT | |
| Leffa `virtual_tryon.pth` | MIT, trained on VITON-HD | VITON-HD is released for academic research; the DressCode variant likewise. A commercial deployment should take this up with the authors or retrain. |
| SD 1.5 inpainting (Leffa's base) | CreativeML OpenRAIL-M | Use restrictions, commercial use allowed. |
| DensePose weights (Leffa's pose) | Apache-2.0 (detectron2), DensePose-COCO data | |
| Leffa's OpenPose `body_pose_model.pth` | CMU OpenPose: non-commercial | Only in Leffa's own mask path. A page-made `--mask` skips it (and SCHP). |
| DINOv2 | Apache-2.0 | |
| BiRefNet | MIT | |

## Free compute

- **Modal**: a monthly free credit on the starter plan (about $30 at the time of writing; check the current
  figure). An L4 is roughly $0.80 an hour, and the containers scale to zero after 3 minutes idle, so a few
  hundred pictures a month fit in the credit.
- **Hugging Face ZeroGPU**: free accounts get a few GPU minutes a day (about 5); PRO more. Enough for a demo
  Space, not for the server to call.
- **Local ComfyUI** with the `ComfyUI-FASHN-VTON` node: $0, and nothing leaves the device, which also makes
  the mask and pose questions moot (the page can hand it everything). On the owner's 16 GB Mac SDXL took 95 s
  at 1 MP; FASHN's model is smaller (576x864) and should be faster. The same `localStudioReady` pattern in
  `lib/local_studio.js` would find it.

## Picking a model

Run the sheet on ten outfits (plain tops, a printed hoodie, jeans, chinos, a coat) and count:

1. If one model passes the shape gate on most pictures and the other doesn't, take the one that does: a fit
   that moves is the one thing Fitroom can't show.
2. Among pictures that pass shape, prefer the higher identity and print scores (the one that keeps the
   wash and the lettering).
3. Prefer the licence that lets Fitroom be used by anyone: FASHN (Apache-2.0, parser off) over Leffa
   (research-trained weights) unless Leffa is clearly better on 1 and 2.
4. Prefer the one that needs less from the page: FASHN needs a pose (which the skeleton can give); Leffa
   needs a mask (not yet in `stage.js`) and DensePose to see a person.
5. If neither passes the gates on most pictures, keep the studio look (SDXL light and texture on our own
   render) and the hosted API as the paid option; the gates and the compare panel still apply to both.

## Risks found reading the two repositories

- **FASHN's parser licence.** `fashn-human-parser` inherits NVIDIA's SegFormer licence (research only).
  `FASHN_PARSER=off` avoids loading it (`TryOnPipeline._setup_hp_model` is replaced) at the price of flat-lay
  garments only. Garments photographed on a model then go in whole, and the model may copy the model's arms
  and body: cutting the garment out first (BiRefNet plus the category band, or the page's own garment mask)
  is the next step.
- **DWPose on the mannequin.** YOLOX looks for a person. With no detection, `onnxpose.preprocess` uses the
  whole picture as the box (`if len(out_bbox) == 0`), and joints under 0.3 confidence become -1 and are left
  out of the pose drawing. Hence `--pose-json`.
- **FASHN works at 576x864** (`TryOnModel.input_shape = (864, 576)`, `tryon_mmdit.py`); the result is upscaled
  to the render's size, so fine prints lose detail before the print gate sees them.
- **FASHN segmentation-free mode lets garments grow** (its own docstring: "allows garments to expand beyond
  the original outfit's boundaries"). The shape gate will catch it; expect refusals on loose items.
- **Leffa's DensePose must see a person.** `DensePosePredictor.predict_seg` returns a black picture when
  detectron2 finds no instance (`densepose/vis/densepose_results.py: if densepose_result is None: return
  image_bgr`); the spike raises `densepose_saw_no_person` then. `predict_iuv` would crash instead
  (`outputs[0][0]`), but the VITON-HD path doesn't use it.
- **Leffa's own mask path** needs SCHP's ATR/LIP parsers and CMU OpenPose weights (non-commercial). A
  page-made mask skips both, but the page can't make one yet (no per-garment pass in `stage.js`).
- **Leffa's mask padding.** Its `resize_and_center` pads with white; for a mask that would mean "repaint the
  borders". `tryon_prep.letterbox` pads masks with black.
- **Leffa's dependencies are unpinned** (`requirements.txt`), and detectron2 and densepose are vendored
  copies. They don't need detectron2's compiled `_C` for the R50-FPN model (`layers/roi_align.py` and
  `layers/nms.py` go through torchvision), but the fvcore/iopath/omegaconf/hydra/yacs pins in the image are
  my choice and untested here, as is diffusers 0.31.0 against Leffa's custom UNets
  (`leffa/diffusion_model/`). The first build will tell.
- **`leffa_utils/densepose_predictor.py` imports cv2 only under `__main__`**: passing a path to `predict`
  would NameError. The spike passes arrays.
- **onnxruntime-gpu 1.19** wants CUDA 12 and cuDNN 9 libraries; torch 2.5.1's wheels ship them, so torch
  is imported first (`load_fashn`). If the CUDA provider still fails to load, pose detection falls to the CPU
  or the session refuses to start; the error will name `CUDAExecutionProvider`.
- **Weight downloads are unpinned by revision** (`fashn-ai/fashn-vton-1.5`, `franciszzj/Leffa`); pin
  `revision=` after the first build. Of `stable-diffusion-inpainting/` only the `*.json` configs are fetched
  (`tryon_engine.LEFFA_PATTERNS`): `leffa/model.py` builds the VAE and UNets `from_config` and loads every
  weight from `virtual_tryon.pth`, so the base model's own weights would be dead download. Untested against
  the live listing; if a load complains of a missing file, widen the pattern.
- **Colab's T4 runs fp16, not bf16.** FASHN's pipeline would pick bf16 by itself there
  (`torch.cuda.is_bf16_supported()` is true by emulation on a T4, which is very slow), so the engine sets the
  dtype before the weights are cast. Its MMDiT keeps RMSNorm, RoPE and the timestep embedding in fp32 and the
  rest in the chosen dtype; fp16 is a plausible fit (Flux-style blocks run in fp16 elsewhere) but was never
  run by FASHN. Leffa is fp16 by its own `app.py`. If either comes back black or speckled, that is an
  fp16 overflow: try fewer steps, or an Ampere runtime (Colab Pro's A100/L4 get bf16 automatically).
- **Colab's 12 GB of RAM against `virtual_tryon.pth`.** It holds the fp32 VAE and both UNets (some GB);
  `LeffaModel` would build fp32 modules and `torch.load` the whole file beside them. The engine builds the
  model, halves it, then memory-maps the checkpoint (`torch.load(mmap=True)`) and copies in, which halves
  the peak. If the runtime still dies while "loading leffa", run `fashn` alone first.
- **Both models were trained on people.** A white matte faceless mannequin is out of distribution for both;
  expect skin and hair painted onto hands and head on some seeds. The gates don't check that; the compare
  panel's "Not quite" does.
- **Without a per-garment mask the validator's garment region is a height band**, so identity and print
  scores are noisy until the page can render one.
