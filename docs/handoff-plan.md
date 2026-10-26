# Fitroom: handoff plan

You're picking up work on **Fitroom**, a Rails 8 app where someone pastes a link to clothes, enters their measurements, and sees the clothes in every size on a 3D mannequin shaped like them. The goal is renders that look and fit like CLO3D: real sewn patterns draped by cloth simulation, not stretched meshes.

Repo: `~/projects/fitroom` on the owner's Mac (remote `github.com/ac7552/fitroom`, branch `main`).

_Updated 23 Oct 2026: section 3 checks, Phase 2 leftovers and Phase 4 are done (see section 3). Phases 3, 5 and 6 are still open._

---

## 1. Ground rules

- **Plain words.** Every bit of text a user sees is written for a 4th–6th grade reading level: short sentences, everyday words, no jargon.
- **Match the look.** The page style is graphite and near-black, with small mono capitals (`--mono`, JetBrains Mono), hairline borders and lit selected states. Keep new UI in that language (the step 3 switches are `.segmented.segmented--dark`).
- **Kith is the test playground.** Most real-world checks use kith.com listings (a Shopify shop).
- **Commits.** Author `ac7552 <aaron.campbell2590@gmail.com>` (the email the history already uses; the owner chose it). Never commit secrets (`config/master.key` and `.env*` are already in `.gitignore`). Keep a real commit history. The README follows the style of `github.com/ac7552/localpilot`, with a GIF demo in `docs/images/demo.gif`.
- **Tests must pass:**
  - `bin/rails test` (Ruby: models, import and fit). Needs Ruby 3.4 (the code uses `it`).
  - `node --test test/javascript/*.test.mjs` (JS: patterns, prints, body fit, photo measuring; 54 pass)

---

## 2. How it works (where to look)

| Area | File(s) | What it does |
|---|---|---|
| Import a link | `app/models/garment_import.rb`, `garment_import/page.rb`, `chart_reader.rb`, `dress_cut.rb`, `fetcher.rb` | Works out what the item is (top, jacket, coat, trousers, dress; plus style) and its size chart. Shopify shops are read as JSON, mostly by the user's browser (`shop_data`) because Kith throttles servers. Kiwi Sizing charts come from Kiwi's API. With no chart, it uses the sizes the page lists (`Page#size_names`) plus usual measurements, marked as guessed. Bump `FORMAT` when the shape of an import changes. |
| Fit verdicts | `app/models/fit.rb`, `app/controllers/api/v1/fits_controller.rb` | Compares body and garment measurements per part and size. Joggers' elastic waist stretches (`ELASTIC_WAIST_EASE`) and can't be let out. |
| Page | `app/views/pages/home.html.erb`, `app/javascript/controllers/fitting_room_controller.js`, `app/assets/stylesheets/application.css` | Step 1 pick clothes, 2 measure yourself, 3 see it on (3D view, switches, size rows). The "Not tucked / Tucked in" switch shows when `stage.canTuck()`. |
| Measure from photos | `app/javascript/lib/measure_photo.js` | Step 2's "Or use two photos": a front and a side photo plus the typed height become the other six numbers, in the tab. MediaPipe Pose Landmarker (`@mediapipe/tasks-vision@1.1.1`, loaded from jsDelivr by a dynamic `import()` only on click, GPU then CPU) gives 33 points and a person mask per photo; `landmarksToMeasurements()` is pure maths (scale from nose-to-heel vs height, ellipse girths from front width × side depth) with tests on synthetic bodies. Photos are never uploaded. |
| 3D stage | `app/javascript/lib/stage.js` | Three.js scene, mannequin, poses, skin tones. Draped **layers** and what each is sewn over: normally pants → top → casual jacket (`OVER`); tucked, the top and the pants each on the body, the jacket over both (`TUCKED_OVER`). Suit jackets and coats are still drawn from the model's meshes and hide the top (`hiddenTop`). |
| Patterns | `lib/garments/pattern.js` (tops, dresses), `lib/garments/pants.js` (pants, jeans, joggers, leggings, shorts, skirts) | Flat pattern pieces in cm from one size's chart. A jogger's chart inseam includes its cuff. |
| Cloth | `cloth.js`, `place.js`, `drape.js` (XPBD), `dress.js` (`DrapedTop`, `waistband`, `TUCKABLE`), `body.js` (frame, foot outlines with `lowest()`), `fabric.js` (looks; `matte` for nylon pants), `print.js` | |

Draping order: sew in a rest pose with the thighs slightly apart, then skin the cloth into the pose shown and settle it again.

---

## 3. Status

### Done (23 Oct)
- **Verified:** the three links import in the running app with the right sizes: Banana Republic Factory (server-read, waists 28–42), Kith letter-size joggers (XXS–4XL), Kith waist-size sweatpants (28–44). Node tests pass (33).
- **Not verified:** `bin/rails test`. This workspace couldn't install gems, so the Ruby tests haven't been run: the three chart-less import tests and a new joggers fit test in `test/models/fit_test.rb`. Run them first.
- **Pant hems:** long hems (pants, skirts, dresses) keep a smooth edge without a stiffened strip (`hemStrip`). The stiff strip rolled out like a turned-up cuff on wide legs and flicked up at a dress's side seams.
- **Jogger cuffs:** were torn and flapping. Causes fixed: the leg pieces ran a full inseam with the cuff added below (7 cm too long); cuffs were skinned to the arms (`garmentWeights` matched `cuff_L` as a sleeve cuff); a snug cuff got dragged down over the foot. Now a cuff or leggings hem can't slip below where the foot is rounder than it can stretch (`snug`, `foot.lowest`).
- **Matte nylon** for nylon pants and joggers (`matte` cloth, a plain weave).
- **Joggers' verdict:** an elastic waist a little smaller than the body "stretches to fit" instead of asking a tailor to let it out.
- **Tucked tops:** see section 2. A tee, long-sleeve tee, polo, tank or shirt over pants or a skirt can be tucked. Checked on pants, shorts, a pencil skirt (women's), with a zip jacket over it, and walking.
- **Photo textures for pants and skirts:** the shop photo itself is laid on the cloth (`readBottomPhoto` in `print.js`, `bottomsPhotoUV` in `photo_map.js`, the `aPhoto` attribute and `uPhoto*` uniforms in `fabric.js`). The front gets the photo; the back gets a softened copy. Jeans now show their wash and marks, and Gramicci shows its belt and seams. Checked on the vowels Painter Pant and Gramicci Voyager Pant.
- **Prints:** photo prints are joined into whole areas (`printAreas`), so they aren't specks.
- **Top falling through loose pants:** a tee over size-L pants fell to the floor. The pants had bunched at the hip into a fold that faced both ways, and the tee got caught in it. The cloth under a layer now always faces away from the body in that layer's collision field (`faceAway` in `stage.js`).
- **Layer checks:** a hoodie and a sweatshirt under a zip jacket, and a dress under zip, shirt and bomber jackets on the women's mannequin, all drape. Dresses no longer ride high (the sample dress's hem lands within 1 cm of its length).

### Known rough edges
- Wide-leg pants still crumple a little below the knee (the lower leg ends up ~10% short vertically and folds; it forms while sewing, not from the feet, friction or the body). Straight legs and jeans look clean.
- A bomber on the women's mannequin: its rib waistband is smaller than the hips, rides up to the waist and flips, showing the dark lining at the back.
- The dress and flared skirt hems are wavy.

---

## 4. Remaining work

### Phase 2 leftover
- [ ] Re-run real Kith pants and skirt links in the app (the representative set was checked headless with chart-like sizes, not live listings).

### Phase 3 leftover
- [ ] **White patches in prints read from shop photos** (`print.js`, `findPrint`): parts of the photo's background are taken for print. Needs the shop link that shows it; ask the owner, then add a test in `test/javascript/print.test.mjs`.

### Phase 4 leftovers (optional)
- [ ] Suit jackets and coats still hide the top (`hiddenTop`). Leave that unless asked.
- [ ] Remember the tuck choice per outfit if the owner wants it (today it's one switch for the page).

### Phase 5: shoes, socks, belts
These are turned away on import (`NOT_FITTED` / `UNSUPPORTED` in `garment_import.rb`).
- [ ] **Import:** shoes, sneakers, boots, heels and flats; socks; belts. Read the shoe size (US, UK or EU, men's or women's) and belt sizes (waist inches, or S/M/L).
- [ ] **Shoes:** not cloth. A simple shell round the foot outline (`frame.feet`), shaped per type: sneaker, boot (taller shaft), heel (lifts the heel), flat. Colour it from the listing. Fit is a length check (foot length against the size's insole length), so add a foot-length measurement to step 2. Pant hems should then rest on the shoe: add it to the collision field and the foot outlines (`stayOffFeet`, `lowest`).
- [ ] **Socks:** a tight tube from the foot up the calf (crew or ankle), under the pants and shoes.
- [ ] **Belts:** a band at the pants' waistband (`waistband()` in `dress.js` gives its height) with a buckle. Fit: belt length against the waist.
- [ ] Size rows and verdicts for each, in plain words.

### Phase 5b: AI finishing step (local, free)
- [x] **Studio look** (`lib/local_studio.js`). When ComfyUI is running on this computer (`127.0.0.1:8188`, started with `--enable-cors-header`), a draped studio photo is also sent there. ComfyUI runs SDXL base plus xinsir's ControlNet union promax in "tile" mode, changing about 35% of the photo, then the result is blended back: broad light and fine texture from SDXL, colours and prints from the render. A "Studio look" choice appears beside "Our fit". It takes about 95 s at 1 MP on a 16 GB Mac (macOS 13, PyTorch 2.8, MPS). Nothing leaves the device.
- Findings: changing more than ~40% of the photo redraws prints and jeans' marks into something else, and canny control without an edge map does little. The render's own resolution matters most: render at 1280 px or more.
- [ ] Bigger wins than SDXL: closer cloth stiffness for twill and canvas pants (the Gramicci hangs too soft and tapered against its photo), and a try-on model that uses the shop photo directly (CatVTON, IDM-VTON). Check those licences: most are non-commercial.
- [ ] **Try-on spike** (`docs/ai-spike.md`): FASHN VTON 1.5 (Apache-2.0) and Leffa (MIT) on Modal, behind a three-gate validator (`script/modal/validate.py`) and a Compare panel with a "Looks right / Not quite" tap. Run `modal run script/modal/tryon_spike.py::spike --sheet tmp/spike` on ten outfits and pick by the decision rule there. Needs a per-garment mask pass in `stage.js` to do its best.
- [ ] Optional: Gemma (via LM Studio) reads listings and photos, and checks results. It outputs text only and can't make images.
- Mac setup notes: macOS 13 needs PyTorch 2.8 (2.9+ dropped MPS on macOS 13), and `av` 15.1 with ComfyUI's two `av.video.reformatter` imports wrapped in try/except.

### Phase 6: the 37 outfits
- [ ] A real Kith link for each piece of the owner's 37 outfit scenarios (Man and Woman each), rendered on both mannequins, on a contact sheet beside the shop photos. Fix what looks wrong.
- [ ] Re-record `docs/images/demo.gif` if the look has changed a lot.

---

## 5. Testing without the app (headless)

Headless Chromium is fast enough when the drape is stepped directly instead of through `requestAnimationFrame`: one garment takes 10–20 s, three layers about 50 s, on 2 CPUs with SwiftShader.

- Serve the repo so that `/lib/*` → `app/javascript/lib/*`, `/vendor/*` → `vendor/javascript/*`, `/models/*` → `public/models/*`. A page with an import map for `three`, `three/addons/...` and each `lib/...` module builds `new FittingStage(canvas)`, awaits `stage.ready`, and calls `setBody(...)`.
- Drape: `stage.setBodyType(...)`, `stage.setBody(...)`, `stage.setOutfit(items)`, set `stage.drapeBudget = 1000`, then loop `stage.advanceDrape(); stage.fitTuck()` with a `setTimeout(0)` between until `stage.settled`. Items look like `{ kind: "trousers", style: "jeans", size: { waist, seat, thigh, inseam, leg_opening }, color, fabric }`; set `stage.tucked = true` for a tucked top.
- Photograph with `await stage.photo({ width, height })` (a PNG Blob), after moving `stage.camera` / `stage.controls.target`.
- Useful probes: hem height by side (front, back, inner, outer) from `cloth.edges["front_L/hem"]` etc.; row spacing and convex-hull girth by pattern row up a leg; `drape.strain()`; a slot's rest drape is `slot.restX`.
- The running app's own page works the same way in the desktop app's browser pane (`Stimulus.getControllerForElementAndIdentifier(el, "fitting-room").stage`), but the pane only advances the drape while the page is busy, and long scripts time out: start work and poll.
- Don't use `pkill -f <pattern>` in a shell whose own command line contains the pattern: it kills itself.

---

## 6. Gotchas learned
- Placement gaps add girth. A 2.2 cm gap round a fitted waist stretches the cloth about 20%, and it rides up when it springs back. Waists and hips are placed on the slice's convex outline, `frame.torso.envelope`, with the gap capped by the garment's own girth. The same goes for a jacket over a tucked top: use the usual gap, not the 3 cm used over a loose top.
- Never lay cloth round the feet: the foot's length counts as the leg's reach there.
- A flat trapezoid laid in level rings is a few per cent too long down the sides. Flared pieces go on a cone.
- Skirts and dresses need their envelope (stay outside both legs) kept on when moved into the pose shown.
- Kith rate-limits servers; the user's browser reads Shopify JSON and Kiwi Sizing instead.
- A stiff, heavy strip hinged on softer cloth rolls over. Keep hems smooth with the edge-run bends only.
- Name clashes in pattern pieces matter: `cuff_L` is a sleeve cuff on a top and an ankle cuff on pants.
- The collision field is a 1 cm grid of nearest-surface distances. Three surfaces within a few millimetres (skin, a tucked top, pants) or two open edges at the same place (a top's cut edge and the pants' waistband top) snag cloth draped over them. Leave such layers out of the field for the layer above, and hide what's covered instead of trying to keep it from showing through.
- Cloth folded on itself has normals facing both ways; in a layer's field it traps the layer above. Orient under-cloth normals with the nearest skin.
- Discarding by a per-vertex flag cuts jagged lines through triangles; pass a signed distance and discard above 0 for a clean line.
