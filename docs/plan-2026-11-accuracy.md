# Plan, November 2026: from 35% fail to under 8%, on a droplet

_7 November 2026. The measured state of the app against 354 Kith products, what the misses have in common,
and the work that fixes them: eight workstreams, about thirteen working days, each gated by re-running the
same sample. The baseline, the tooling and the grades are in `script/validation/kith_20261107/`._

## 0. What this app is for, and what it runs on

Fitroom shows a shopper how clothes from a link look on a body shaped like theirs, in 3D, in the browser.
The bar is a product shot: the garment the shop sells, on a figure, under studio light, with the cloth
hanging as that cloth hangs. Four things have to be true at once, and every item below serves one of them:

- **Accurate.** The 3D view is the garment in the photo: its shape, parts, print, colour and material.
- **Real.** Light, cloth and materials behave as they do in a photograph, not a game.
- **Fast.** Dressed in a couple of seconds on a laptop, under eight on a phone; nothing waits on a server.
- **Beautiful.** A lookbook frame, a quiet studio, materials that read at arm's length and in close-up.

The constraint that shapes every choice: the app runs on **one plain DigitalOcean droplet, no GPU, no job
queue**. The droplet serves files, imports listings and does the fit maths. Everything per visitor (reading
photos, draping cloth, carving shoes, lighting, the still) runs in the visitor's browser, on their GPU
through WebGL and, where there is one, WebGPU. The neural tools the page uses (SlimSAM for cut-outs and part
masks, DINOv2 for likeness and photo roles, Depth Anything V2 for relief) are small ONNX models the droplet
serves as static files and the browser runs through Transformers.js. Nothing in this plan changes that;
every step is measured against the budgets in section 6.

That constraint is also where the app can be different. Nobody else drapes a real cloth simulation, reads
the shop's photo into a sewn pattern and lights it with a path tracer, all in the tab, with nothing uploaded
and no server in the loop. The work below makes the photo the source of truth for the garment's parts,
length, print and material (section 3), so that the rendering stack already built (XPBD cloth, metered
light, folds from strain, a path-traced still) is drawing the right garment.

## 1. Where the app stands: 354 Kith products, graded

On 7 November, 359 products were drawn at random from 25 Kith collections (15 per apparel collection, 12 per
footwear collection, seed 20261107) plus eight links the owner sent, and run through the page on a
development Mac exactly as a shopper runs them: import, photo reading, drape, re-drape, then front, side and
back renders. 354 finished and were graded by eye against the shop photo (`ok` reads as the product; `minor`
right with a visible flaw; `fail` a different-looking garment or a glaring artefact).

| Category | Graded | OK | Minor | Fail | Fail share |
| --- | --- | --- | --- | --- | --- |
| Outerwear (coats, jackets, parkas) | 51 | 1 | 19 | 31 | **61%** |
| Dresses | 15 | 2 | 6 | 7 | 47% |
| Tops (tees, hoodies, sweats, shirts, knits) | 110 | 11 | 52 | 47 | 43% |
| Footwear | 92 | 22 | 42 | 28 | 30% |
| Bottoms (pants, denim, shorts, skirts) | 86 | 38 | 38 | 10 | 12% |
| **All** | **354** | **74** | **157** | **123** | **35%** |

An 80% improvement, the target the owner set, means a fail share of **7%**. Bottoms are nearly there.
Outerwear is the furthest and the most visible.

Footwear was 30% here after the carved-shoe work pushed on 6 November (commits cbb85b0, c038255), which
took the 60-shoe silhouette set from 0.898 to 0.947 mean IoU. What remains on shoes is openings, parts and
the rigid foot, below.

## 2. What goes wrong, ranked

Ten causes cover almost every fail. Most share one root: the page reads each photo as an outline plus a
colour, then guesses the garment's parts, length and kind from words and a per-style pattern. Counts are
pieces showing the problem (a piece can show several); the second number is how many of those failed.

| # | Problem | Pieces / fails | Seen as | Cause in the code |
| --- | --- | --- | --- | --- |
| 1 | Neckline, collar or hood wrong or missing | 95 / 44 | crewnecks as mock necks; shirt, polo, camp collars gone; peacoat lapels gone; hoods dropped behind or absent | one neck per style in `pattern.js`; the collar leaf is a band; the re-drape leaves the hood plain (`redrape.js` `trustPieces`) and never puts a front-photo hood on the head |
| 2 | Length or garment type misread | 68 / 42 | short parkas and bombers knee length; women's regular tees cropped; shorts full length; a vest with sleeves | coats default long; the photo's proportion only shortens tops (`look_check.js` `croppedLengths`) and misfires on women's tees; kind from words |
| 3 | Swirls and streaks on plain cloth | 61 / 29 | marbled swirls on nylon, rib knit, pinstripes; grey streaks on white denim; wavy plaid | the re-drape maps the flat photo point for point onto cloth that hangs differently and stretches it; synthesised folds on padded cloth |
| 4 | Shoe front and back smeared | 57 / 14 | AJ1 and AJ4 ghostly from the front; heel cups striped | one side photo wrapped round the whole shoe (`accessories.js` `wrapShoePhoto`) |
| 5 | Hem slits, hanger, drawcords | 43 / 11 | white side slits; hanger hook at the neck or bar at the waist; cords as loops across the chest | side vents left open in `pattern.js`; the hanger mask too tight; cords read as print |
| 6 | Shoe openings filled; foot hidden or poking out | 35 / 16 | Ale and Jeli sandals solid; fisherman cut-outs filled; mule vamps ragged; feet missing | `hull.js` fills the side outline; `stage.js` `coverFeet` hides skin under the topline, not under material |
| 7 | Wrong photo used | 32 / 27 | faces, hands, jeans and shirts on jackets; close-up crops blown up over a garment; a sole as the side; another photo on the back | the first listing photo is the front whatever it shows (`photo_roles.js` is used for colour, not for choosing) |
| 8 | Print moved, stretched or lost | 30 / 27 | hood lining and chest print stretched shoulder to shoulder (the owner's hoodies); letters over the shoulders; a graphic missing | the hood's inside in a flat photo is read as front print; the print box maps to the whole front panel |
| 9 | Shoe heel, toe and shape | 24 / 21 | stilettos as blocks; toes as spikes; lumpy boots | the rigid mannequin foot; no stem or insole parts |
| 10 | Colour off | 20 / 9 | white sleeves navy; a grey duster black; black tee navy | one colour per garment; contrast panels unread |

Smaller: fur drawn flat, sheer drawn opaque, the Kith Ivy and Keshi blazers drawn from the old suit model
with a shirt and tie under them (6 pieces, all fails); and four shirts that failed to import because a `™` or
`û` in the title broke a look-behind regexp in `garment_import.rb` (fixed in this commit).

By category: outerwear is #1, #2 and #7; tops #1, #3 and #8; footwear #4, #6 and #9; dresses neckline and
kind (a jumpsuit as a dress over trousers; a romper's plunge filled in); bottoms only shorts' and skirts'
length and flares drawn straight.

## 3. The work: eight workstreams

Each runs in the browser on models the page already loads, or on static files the droplet already serves.

### 3.1 Pick the right photo (fixes #7)

Every listing photo gets a role before anything is read: `flat_front`, `flat_back`, `on_model`, `closeup`,
`sole`, `angled`, `pair`, `tag`. The roles come from what is already measured (does the garment fill the
frame, is there skin or a face, is the backdrop plain, is the outline a garment's) plus a DINOv2 nearest-
example check against a few labelled photos per role, in the browser. Then:

- the front is the `flat_front`; with none, the `on_model` photo masked to the garment by SlimSAM gives
  colour and parts, and the pattern is drafted from the chart;
- a `closeup` gives texture (a tile) and nothing else; a `sole` or `angled` shot is never the shoe's side;
- the back is used only when its outline matches the front's within tolerance; otherwise the back is the
  front's cloth, mirrored, as it is today for most garments.

Files: `lib/garments/photo_roles.js` (roles and the examples), `controllers/fitting_room_controller.js`
(`readShoePhotos`, the import's photo choice), `lib/garments/segment.js` (the on-model mask).

### 3.2 Read the parts, not the outline (fixes #1, most of #8)

SlimSAM, prompted at the neck, cuffs, hem and chest of the flat photo, returns masks for the neckline,
collar, hood, placket, pockets, cuffs and hem band. From them:

- **neckline** (crew, mock, V, boat, scoop, halter, off-shoulder, cowl) sets the pattern's neck;
- **collar** kind and size (shirt, camp, polo, notch lapel, peacoat, shawl, stand, shearling) drafts a real
  collar piece, sewn and draped, in place of the leaf; lapels fold from the front edge;
- **hood** seen on a flat front is drafted and shown down (the common case) or up, as photographed; its
  inside and the drawcords are cut out of the print, which ends the hood lining on the chest;
- **print** is placed by the mask's own box over the chest panel, at the photo's scale, not stretched over
  the whole front; letters keep their aspect.

Files: `lib/garments/photo_fit.js` (reads), `lib/garments/pattern.js` (neck, collar and hood pieces),
`lib/garments/redrape.js` (`trustPieces`, `paintCords`, the print box), `lib/stage.js` (`wearCollars`).

### 3.3 Length and type from the photo, every garment (fixes #2)

The photo's body length over its chest width sets length for coats and jackets as it already can for tops,
in both directions; the cropped rule gets a floor (nothing above the natural waist unless the photo's
proportion is extreme and the words agree). Shorts and skirts take length from the photo's hem against the
waistband. Words decide only what the photo can't: vest, jumpsuit, romper, shrug, skort. Sleeve length from
the photo already works and extends to puff and cap sleeves.

Files: `lib/garments/look_check.js` (`croppedLengths`), `lib/garments/photo_fit.js`, `lib/garments/pants.js`,
`app/models/garment_import.rb` (kind rules).

### 3.4 Lay the photo without tearing it (fixes #3, the biggest aesthetic lift)

The re-drape keeps its point-for-point fit only where the hung cloth and the flat photo agree (a strain
limit per triangle); elsewhere the photo's cloth becomes a tile at its own scale, the way denim and camo
already look right. A plain or near-plain garment (most swirl cases) is drawn from its colour and a weave
tile with the photo's relief, never a stretched photo. Stripes and plaids keep straight lines by snapping the
warp to the pattern's grain. Padded and heavy cloth (puffers, parkas, quilting, shearling) get no
synthesised thin-cloth folds: the fabric table gains `padding` and `pile`, which raise bending stiffness and
zero the fold amplitude (`wrinkles.js`), with the depth model's loft as relief instead.

Files: `lib/garments/redrape.js`, `lib/garments/fabric.js`, `lib/garments/wrinkles.js`, `lib/garments/drape.js`.

### 3.5 Footwear: openings, parts, a bending foot (fixes #4, #6, #9)

Confirmed by the sample, this is the footwear proposal of 7 November:

- carve from the photo's **pixels** (shoe vs backdrop inside the outline), so straps, cut-outs and a mule's
  back stay open; the far side mirrors the near one;
- hide skin only where the carved shoe has material above it, so the foot shows through openings and the
  cut edge stays inside the shoe;
- a **toe bone** at the ball in `script/mannequin/build.py`, so a heel pitches at the ankle and the toes lie
  flat on the insole; the toe box then carves to the photo's point and the containment walls go;
- **parts**: insole and lining coloured from the photo where the carve opens; the stem a prism from the
  heel seat to the floor, its tip on the floor; sole band and upper with their own materials;
- the **front and back** built from the side photo's colours at their own scale (a colour field, not a
  stretched image), with the depth map's relief; front and top photos set the width where a listing has them.

Files: `lib/garments/hull.js`, `lib/garments/print.js` (`shoeSide` keeps the mask), `lib/stage.js`
(`coverFeet`, `dressFeet`), `lib/garments/accessories.js`, `script/mannequin/build.py`.

### 3.6 Colour by part (fixes #10)

Contrast sleeves, collars, cuffs, plackets and panels take their colour from their own part masks (3.2); the
garment colour is the median of the body panel only. A varsity's white sleeves and a duster's fur placket
stop taking the body's colour.

### 3.7 Finishing: hems, hangers, cords (fixes #5)

Side vents close unless the photo shows slits. The hanger mask grows to cover hook, bar and clips, then is
painted out from the cloth beside it. Drawcords are drawn as cords where the photo shows them hanging and
cut from the print, relief included (step 2 paints their colour out; their outline stays in the relief). A
polo's collar leaf is folded crisply and shaded as its own piece (step 2 left it reading as a crew neck).

### 3.8 Materials the sample showed missing

Faux fur and shearling get the fibre shell already in `fuzz.js`, driven by the words and the depth map's
pile. Sheer cloth gets transparency from the photo's see-through areas. Tailored blazers move onto the
drape path the casual jackets use (the real-time view then shows cloth; the suit model keeps only the
Blender studio render), as `handoff-plan.md` phase 5 set out.

## 4. Realism and the look

The sample's `minor` grades are mostly look: a hood dark where it should be the cloth's colour, a plain tee
with streaks, a shoe's side glossy where it should be suede. These ride on the same work, plus:

- **One material model** for shoes and clothes (`fabric.js`): gloss and clearcoat for patent and leather,
  sheen and anisotropy for satin and velvet, fuzz for fleece and fur, a matte weave for nylon, pile for
  shearling. Set from the words, refined by the photo's relief. Highlights then sit where that fabric puts
  them, and a croc pump and a canvas sneaker stop sharing one shine.
- **Relief from the photo everywhere.** What is lighter or darker than its surroundings in the photo is
  already a height the shader tilts the surface by; the depth model adds the coarse relief (baffles, pile, a
  stem, a cuff's folds). The page's light plays over a real surface instead of a flat picture of it.
- **Colour held to the photo.** Every garment's rendered colour is checked under the page's light (ΔE ≤ 6)
  as a gate, not just metered.
- **Contact and layering.** Contact shadow where a hem meets a shoe or a coat meets a hoodie; each layer
  collides with the one under it with a margin equal to its thickness, so a bomber's band stops flipping.
- **The still.** The path-traced still already in the page gets a 50 mm lens look, shallow depth of field
  and the floor's soft contact shadow: a product shot, not a screenshot.

## 5. Order, estimates, gates

About 13 working days. Each step pushes to `main` only when its gate passes and nothing that passed before
regresses, measured by re-running `script/validation/kith_20261107/` (section 7). The projection counts a
fail as fixed only when every cause tagged on it is addressed, then keeps a fifth of those as still failing.

| Step | Workstream | Days | Projected fail share after | Gate |
| --- | --- | --- | --- | --- |
| 1 | 3.1 Pick the right photo (+ the import fix, done) | 1.5 | 33% | no render uses an on-model, close-up, sole or mismatched-back photo as its front or side |
| 2 | 3.2 Read the parts | 3 | 30% | hoodies show their hood; shirts and polos their collar; no hood lining or cords in a print |
| 3 | 3.3 Length and type from the photo | 1 | 23% | coat, jacket, short and skirt lengths within 10% of the photo |
| 4 | 3.4 Lay the photo without tearing | 2.5 | 16% | no swirl or streak on any plain garment; stripes and plaids straight; puffers without waves |
| 5 | 3.5 Footwear | 3.5 | 10% | every sandal and mule shows its openings and the foot; heels 8 of 10 at side IoU 0.9; 60-shoe set ≥ 0.94 |
| 6 | 3.6 Colour by part | 0.5 | 8% | contrast sleeves and panels in their own colour |
| 7 | 3.7, 3.8 Finishing and materials | 1 | 7% | no hem slits or hanger marks; fur, sheer and blazers read as such |
| 8 | Section 4 look pass, re-measure | 1.5 | 7% | ΔE ≤ 6 on 95%; a 20-outfit before/after sheet |

Step 1 goes first because a wrong photo poisons everything after it. Step 2's part masks are what steps 3,
6 and 7 read from. Footwear (5) is independent and can run alongside 2–4. Steps 3 and 4 move the number
most per day.

### Step 1, done (7 November)

Every listing photo is given a role before it's read (`photo_roles.js`): from the shop's words for it (how it's
described, never a garment's parts: Kith's "Man wearing … zip front" had been taken for a front, and "front
view on a hanger" refused for its "on"), the measurements already taken, and DINOv2 held to 43 example
centres (22 KB, `photo_role_examples.js`, built from the sample's 1,228 photos labelled by eye in
`kith_20261107/photo_roles.json`). The first photo of it on its own is the front, else one of it worn
(`photoRole` "on_model": colour and parts, no outline fit); the back is the first back whose outline and
colour match the front's; a close-up is a texture only; a shoe's side is never its sole, a pair or an angled
shot. A three-pack's front is the garment in front, alone (`firstOfSeveral`). Shoes the client had sent down
the garment path (Kith's heels, flats, ballerinas and derbies, and untyped sneakers) are shoes by their tags;
an Oxford shirt isn't a shoe; a turtleneck imports.

- Labels, each listing held out from the examples: the old choice had the right front on 235 of 255 garments
  and tried a wrong back first on 10; the new has the right front on every listing that has one on its own, and
  no wrong back. Without the shop's words at all, 344 of 346.
- The live import on all 346 listings (`photo_roles_check.js`): no front, back or close-up that isn't one; 210
  backs and 85 close-ups used; two shoes go without a side rather than take an angled or cropped photo. The
  roles take 0.2 s at the median and 0.37 s at the 90th percentile on the Mac's GPU, inside the photo-reading
  budget; with no DINOv2 within 4 s (a first visit), the words and measurements decide.
- Rendered again (77 runs: every run tagged with a wrong photo or whose photos changed, and 12 controls;
  `regrade_step1.py`): **35% fail to 29%** (101 of 351), ahead of the 33% projected. Outerwear 61% to 47%,
  tops 43% to 36%, bottoms 12% to 7%, footwear 30% to 28%. No control changed.
- Moved on: a garment with only a front photo has its back drawn plain, pale or blurred (dresses, skirts,
  shorts) — how the cloth is laid, not which photo, so it's tagged for step 4; a jacket whose words say hood
  keeps one it hasn't (two Erin jackets) — step 2; a stiletto's heel view now laid on its back shows the red
  sole — step 5.

### Step 2, done (7 November)

The photo's parts are read and drawn as parts: a placed graphic is laid whole, a hood is kept off the body and
drawn in its own colour, a neckline the listing names is drafted, and a shirt's collar is open at the front.

- **Placed graphics.** A chest graphic, logo or block of lettering is cut out of the photo at full size
  (`print.js` `graphicPatch`): its marks, what lies between them and the thin rules beside it, never marks that
  run off the front's top or hem, a strip at a side or a band right across. It is painted out of the photo the
  re-drape lays on, filled from all four sides with the cloth's own colour (`cleanedPhoto`), and laid as one
  piece at the photo's scale both ways (`uPrintWide`), the photo's relief off under it. Zip hoodies and jackets
  too. A front read after the re-draping began is laid on again on the same hanging (`stage.js` `redrapeSwap`).
- **Hoods.** Found over sloping shoulders and on raglan hoodies (`garmentRows`); a print starts `HOOD_DROP` below
  the shoulders' high points; the re-drape finds a hooded photo's shoulders where the outline leaps out
  (`shoulderRow`); the hood's inside (a lining, a hanger in it, the middle of the front under it) is kept off the
  body (`hoodInside`); its inside drawn at 0.85 of its colour, standing 4.5 cm up the neck worn down. A hanger's
  hook is no longer a hood.
- **Necklines.** A knit's crew is a 2.8 cm rib; a crew, mock, turtle, V, scoop or boat neck named in the listing
  is drafted (`necklineOf`, `necked`); a dress's plunge comes straight to a point.
- **Collars.** A shirt's leaf is open at the front, its points out over the chest. The collar's colour, strip and
  band leave out a black hanger at a light garment's neck (`hangerLike`). The band is plain in its own colour,
  on an all-over print too (a plaid shirt's and a cable-knit polo's band had taken the hanger and the label at
  the back of the neck); where the photo there is mostly hanger it takes the collar's colour across the top
  of the photo. In the collar strip, the back of the neck (which a front photo shows from inside) keeps only
  what's near the collar's colour. A collar's or neckband's inside is drawn at a hood's 0.85, not 0.55: a
  light polo's had read as a black crew rib.
- **Cords.** `paintCords` finds cords either side of a zip as light as they are: the zip's column is taken out
  of a run that reaches the window's foot, and what's left is tried as cords.
- **Tools.** `probe.js` runs keys and posts picture grids to the dev log (`snap.sh` collects them);
  `compare.py` lays each run's earlier sheet over its new one; `bench_read.js` times the photo reading alone.
  Tests: `necklines.test.mjs`, `shoulderRow` and the light-zip cords in `redrape.test.mjs` (261 pass).

Measured on the 48 runs of `kith_20261107/runs_step2.json` (the P-stretch, P-hood and P-lost tops, the hood,
collar and neck runs, eight print tees that graded ok and eight controls of other kinds), regraded in
`regrade_step2.py`:

- **29% fail to 25%** (88 of 351), ahead of the 30% projected. Tops 36% to 24%, outerwear 47% to 45%; 16 runs
  graded better, none worse; 13 fewer fails.
- The gate:
  - *Hoodies show their hood:* 13 of the 14 hoodies in the set, from the side and behind, in their own colour.
    The women's raglan Tatum (khwa030159-001) shows its hood from behind only.
  - *Shirts and polos their collar:* the three shirts (a plaid, a shadow check, a camp-collar bowling shirt)
    show theirs, and the dark patch at the plaid's neck is gone. The two polos lost the hanger's black at the
    neck, but their leaf still doesn't read: they look crew-necked. Carried to step 7.
  - *No hood lining or cords in a print:* no lining, hood outline or hood shadow on any chest (the horse zip
    hoodie, Entire Studios, vowels, Tatum crest). The zip hoodies' white cord loops are gone, but where they
    were stays in the relief, as an outline (Awake) or a smudge (Acne). Carried to step 7, as section 3.7 has it.
  - *No control worse:* the 16 controls render as before; the Nahmias tee's front print is now laid in place.
- **Budget.** Timed alone in a quiet tab (`bench_read.js`, 12 of the set's tops on the Mac): the reading takes
  0.21–0.34 s, and the cut-out and paint-out before it 0.15–0.24 s, or 1.0–1.2 s on a first visit to a photo
  with a hanger or hands to paint out. 0.46 s in all at the median, 1.55 s at most (Rhude, first visit): inside
  the 1.5 s budget but for that one, by 0.05 s. The runner's own `times.read` (several tabs at once, the
  cloth draping beside it) are several times that and aren't the budget's number.
- The Erin denim jacket no longer has a hood drawn from its words. The Rainier jacket, whose hood packs into
  its collar, still has one drawn out: step 3 (type from the photo).
- Moved on: the polo collar's leaf, which needs a crisper fold and its own shading (step 7); cords' relief
  (step 7); the raglan hood from the front, a fuller roll for the worn-down hood (`place.js` `hoodDown`; step 7);
  colour blocks (the Knicks crewneck's cream yoke, Phantom's grey half) swirled or drawn in the body's colour
  (steps 4 and 6); the C.P. lens badge no longer drawn on its sleeve, its first run since step 1 brought in
  its back photo (step 6, colour by part, reads sleeve parts on their own); a white tee on a light backdrop
  unread (segmentation). Print scale stays by the chart: a big chest graphic reads a little larger on the
  worn front than in the flat photo, as it should.

## 6. Performance budgets (unchanged by this plan)

Everything per visitor stays in the browser; the droplet gains only static files (the depth model is
already vendored; the part-mask prompts and role examples are a few kilobytes).

| Stage | Laptop (2024 MacBook Pro) | Recent phone | How it holds |
| --- | --- | --- | --- |
| First frame | ≤ 1 s | ≤ 2 s | service worker caches models and page files after the first visit |
| Photo reading (roles, cut-out, parts, colour, print) | ≤ 1.5 s | ≤ 4 s | SlimSAM loaded once and kept; part prompts batched in one pass; readings cached per listing |
| Depth map | ≤ 2 s | ≤ 6 s | once per garment, in a worker, WebGPU where present |
| Dressed, drape-bank hit | ≤ 2 s | ≤ 5 s | the bank widened to cover 90% of Kith's styles, built offline, shipped static |
| Dressed, first-time drape | ≤ 4 s | ≤ 8 s | WebGPU compute solver where present; the worker solver otherwise |
| Pose change | < 0.5 s | < 1 s | as now |

The headless harness (`script/headless/`) records every stage's time on each run; a step that slows a stage
past its budget fails its gate. Nothing is added to the per-visitor path that can't run under 2 s on a
laptop; the part masks reuse the SlimSAM pass the cut-out already makes.

## 7. How it is measured

The baseline and the tooling are in the repo so every step is re-measured the same way:

- `script/validation/kith_20261107/sample.json`: the 359 products (seed 20261107) with photo links;
  `runs_apparel.json` and `runs_shoes.json` the run lists; `grades.csv` the 354 grades with cause tags;
  `tally.py` the counts and the projection; `README.md` the procedure and the tag vocabulary.
- `script/validation/runner.js` runs the lists in the page (large renders with `VAL.picSize`, feet close-ups
  with `VAL.feet`); `script/validation/export.js` saves a tab's finished runs as a zip of contact sheets;
  `script/validation/collect.sh` gathers the zips.
- The footwear silhouette set: `script/validation/shoes_baseline.json` and `shoes_latest.json`, run by
  `script/headless/shoe_set.mjs`.

A step is done when its gate holds on a re-run of the full sample, graded with the same tags, and the
automatic checks (`accuracy.js`, `baseline.json`) show no regression. Photos are fetched live from Kith at
run time; if a product is withdrawn, its row is dropped from both runs and the shares are recomputed over
what remains.

## 8. What stays approximate

A garment's far side when the listing has no usable back photo (the front's cloth, mirrored); a shoe's far
side; fabric the words mislabel and the photo can't correct; a garment photographed only on a model, which
gets its colour and parts but a chart-drafted shape. The grading is by eye against the store photo; a spot
check of 30 graded pieces by the owner before and after is the cheap insurance against drift.
