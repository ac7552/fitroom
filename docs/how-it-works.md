# How Fitroom works

The details behind the [README](../README.md): how clothes are read from a link, how the mannequin is built, how tops and dresses are sewn and draped, and how the fit is worked out.

## What it stores, and what it doesn't

- **Your measurements are never stored.** They go to the fit API with each request, are used for that one
  response, and are dropped. There's no table to save them in, `measurements` is filtered from the server log,
  and responses are sent with `Cache-Control: no-store`. On the web page, the inputs have no `name`, so
  they're never submitted, and `autocomplete="off"` keeps the browser from remembering them. Nothing goes in
  cookies or browser storage. Refresh the page and they're gone.
- **There are no accounts or logins, and photos never leave the device.** A photo of a jacket is read in the
  browser only, for a preview and its colour; it's never uploaded. Photos of you (the "Or use two photos" way to
  measure yourself) are read on your device only: MediaPipe's pose model runs in the tab, the photos are decoded,
  read once and closed, never drawn into anything that stays around, and never uploaded; only the model itself is
  downloaded (`app/javascript/lib/measure_photo.js`). A pasted product link is fetched once, read for its
  size chart, and cached for an hour by link; nothing records who pasted it.
- **The only data in the repo is about garments:** size charts in `config/size_charts/`. The one there now
  is made-up sample data, not any real brand's.

## Web and mobile

The web page and the mobile app are separate clients of one JSON API under `/api/v1`. The fit math lives
only on the server (`app/models/fit.rb`), so both clients always agree. See [api.md](api.md).

## Reading a jacket from a link

`POST /api/v1/garment_imports` fetches the page (public addresses only, size and time limited, see
`app/models/garment_import/fetcher.rb`), reads the product's name, brand and colour from its schema.org data,
and finds its size chart among the page's tables (`app/models/garment_import/chart_reader.rb`). It copes with
sizes as rows or columns, inches or cm, fractions and ranges, "pit to pit" half widths, and charts that list
body measurements instead of the garment's (it adds regular-cut ease to estimate the jacket). Many shops
load their chart in a pop-up the server never sees, and big ones turn away any reader that isn't a person's
browser (Fitroom doesn't pretend to be one). For those, paste the chart, or use a photo of the jacket and
type its measurements (flat measurements across the chest and waist are doubled for you).

Resale listings (one item, measured) often give "Chest 50.5"" pairs instead of a table; those are read
too, with the item's size, and a sleeve longer than 30" is taken as measured from the back of the neck.
Coats are fitted with 7 cm more room in the chest and waist (they go over a jacket), and their length is
described ("ends at the knee") rather than judged. Trousers are checked at the waist, the seat (against
your hips) and the hem (against your inseam, breaking about 3 cm above the floor); hips and inseam are
optional and only needed for trousers.

Measurements far outside the usual adult range come back with a warning that says how to measure again
(25 in shoulders usually means measuring around the arms), and the mannequin says when it can't stretch
that far.

Two made-up product pages in `public/samples/` exercise both kinds of chart.

## The home page

The opening scene is the jacket as a line drawing in cold mist; scrolling sweeps a glowing line down from
the collar that turns it into frosted cloth, then its measurements appear across it like chalk lines
(`app/javascript/controllers/hero_controller.js`). It loads `public/models/jacket.glb`, a 1 MB static copy
of the jacket the build exports for this.

## The 3D model

The fitting room is styled as a product shot rather than a person: a white display mannequin in your
shape with a plain egg head, wearing the outfit in the sizes you pick, in soft studio light on a pale
backdrop. It can stand, relax, walk or hold its arms out; the clothes are rigged to the same skeleton, so
they follow. The mannequin is hidden just where a worn garment covers it, so nothing pokes through.
**Ghost** hides the form to show the jacket alone; **Fit map** colours the jacket by the tailor's verdict.

The model is built in Blender by `script/mannequin/build.py` into `public/models/mannequin.glb`, from
[MakeHuman](http://www.makehumancommunity.org)'s CC0 body and suit. The build splits the suit into a jacket and
trousers, marks which parts of the body each covers, smooths both meshes with one level of subdivision, bakes the shading in the jacket's folds, and adds
two sets of shape keys:

- MakeHuman's measurement targets (chest, waist, shoulders, upper and lower arm, hips, upper and lower leg),
  with the clothes refitted to each. The page solves for the weights that match your measurements (`app/javascript/lib/body_fit.js`)
  and scales the model to your height.
- Fitroom's "ease" keys, each making the jacket 1 cm bigger in one place (chest, waist, shoulders) or 1 cm
  longer (sleeves, body), and the trousers 1 cm bigger at the waist, seat, thigh or leg opening or 1 cm
  longer in the leg. The page sets them from the difference between a size's chart measurements and
  the modelled jacket, so every size looks as big or small as it really is.

### Tops and casual jackets: sewn and draped on the page

T-shirts, long sleeves, sweatshirts, hoodies, button-up shirts and casual jackets (zip-up, bomber, shirt
jacket) aren't shaped from the model. They're made the way garment tools like CLO make them, in the
browser, in `app/javascript/lib/garments/`:

- `pattern.js` drafts the sewing pattern for one size from its chart (front, back, sleeves, and the
  collar, cuffs, waistband or hood the style has), filling in what the chart doesn't give from your body.
- `cloth.js` cuts each piece into a triangle mesh about 1.6 cm across and lists which edges are sewn
  together.
- `body.js` reads the mannequin as it's shaped (joints, how far it reaches out at each height, a distance
  field of its skin for collisions); `place.js` lays the pieces round it, sleeves round the arms.
- `drape.js` sews and settles the cloth with position-based dynamics: seams pull together with gravity
  off (bands held on their edges until the body is sewn), then it hangs for a couple of seconds. Hems are
  heavier and stiffer, as turned-up hems are. The cloth hardly stretches but gives way when it's pushed
  together, and folds, as cloth does: pushed back as hard as it's pulled, cloth left a little short
  anywhere would shake itself into a crumple where it hangs free (a long skirt or dress below the knees).
  A skirt is laid round the body with its sides already together, so it's closed as it's placed and only
  eases and hangs; it sits where the body is as round as its waist, each row spread round the body by
  distance, so it starts at its own size. It runs a few milliseconds per frame, so you see it settle.
- `dress.js` turns it into the garment on screen, follows the poses by skinning it to the mannequin and
  settling it again, shades its folds, and paints its fit map by part.
- `fabric.js` draws the cloth: knit, rib, fleece, twill or nylon at real scale, with seams, hem stitching,
  zips, buttons and a hoodie's pocket.
- `print.js` reads the shop's photo for the garment's colour and any print on its front, which is laid on
  the cloth. Only the front: sleeves and backs stay plain. (Pants take the whole photo; their back takes a
  softened copy with the front's print painted out.)

A hoodie's hood is worn down, lying on the back and shoulders, as a shop photo shows it. A hoodie whose
listing says it zips up (`zip: true` on the import) is drawn with the zip and its pull.

A top under the suit's jacket or a coat isn't drawn (the model's jacket has its own shirt).

The model also has a **casual jacket**, no longer drawn (casual jackets are draped, above):
(`script/mannequin/casual_jacket.py`). It's cut from the mannequin's own body, from the neckline to the
hips and down the arms, so it has the body's rig and measurement keys and follows any shape. It's stood off
the body and smoothed, and it hangs straight from the chest. It has a stand collar and a point collar, and
it's built long so each size is cut to its own length. One mesh is drawn as four styles, each with its
own details painted in metres on its texture (`textures/casual_*.png`) and coloured for the fabric:

- **Blazer or suit jacket** (the suit's jacket)
- **Zip-up jacket**: zip, stand collar, slanted pockets
- **Bomber**: zip, rib-knit collar, cuffs and hem
- **Denim or button-up jacket**: point collar, buttoned placket, yokes, flap pockets, pleat seams,
  waistband, with copper stitching and buttons on denim

Imports pick the style and fabric from the listing: its name, description and "Fabric" field, and its
shop section. Each item card has **Looks like** and **Fabric** pickers to change them.

`public/models/mannequin.json` records what each key does in centimetres, measured off the mesh the way a
tape would. The jacket's cloth is dyed the shop's colour, with a fine wool grain on top. Lighting comes from a
CC0 studio HDRI. Credits: [CREDITS.md](../public/models/CREDITS.md).

To rebuild it you need Blender 5.2+, the MPFB extension and MakeHuman's CC0 system asset pack:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --python script/mannequin/build.py -- public/models
```

### Faster draping: coarse first, in WebAssembly, in a worker

- **Coarse first** (`lib/garments/coarse.js`): a garment is sewn and settled as a cloth half as fine (3.2 cm
  between points, a quarter as many), then cut at full resolution where it ended up and settled a moment
  more. The fine cloth's points follow the coarse one meanwhile, so the page shows it settling as before.
  `?coarse=off` drapes the full cloth all the way.
- **WebAssembly** (`script/wasm/cloth.c`, built by `script/wasm/build.sh` into `lib/garments/cloth_wasm.js`):
  the solver's inner loops (moving the points, the threads and bends, cloth off itself and off the skin)
  run as WebAssembly on the drape's own arrays (`lib/garments/cloth_kernel.js`), the same arithmetic in the
  same order, so a drape comes out the same to the bit (a test holds it to that). `?wasm=off`.
- **A worker**: the drape runs in a Web Worker unless the address says `?drape=page`.

Headless, a tee and jeans from scratch: 12.5 s of solving before, 4.6 s with all three.

## The drape bank

A drape depends on the pattern's style, the garment's measurements and the body, not on the shop link. So
garments draped once are kept (`public/drapes/`, `lib/garments/drape_bank.js`): a new garment whose style
and panels match an entry, with measurements within 20% of it, starts from that entry's drape instead of
being sewn and let fall from scratch. Each stored point knows its place on its pattern panel and where it
ended up in the body's bind space (through the bones it follows, as reposing does), so the new garment's
points take the positions of the nearest stored points on the same panel, settle a moment where they were
put, and are posed in one step. Measured on a 2024 MacBook Pro with the bank built from `script/bank/sources.json` (100 entries, 48
garments): a first-time crewneck and jeans are on in 8 seconds instead of 17 (28 before the drape stopped
when still and flat photos skipped cleaning); a first-time slip dress in 3 seconds instead of 12; the look
check passes as before. A style with no entry near it (a ruffled dress, a wide trouser 25% off every entry)
drapes as it did.

`script/bank/atlas.mjs` fills it with no links at all: every draped style but the dress at three sizes a
quarter apart, on both example bodies, headless (the drape atlas, 63 entries). `script/bank/build.js` builds
the bank from a list of links (`script/bank/sources.json`): run it in the
browser's console on the page opened with `?bank=off`, then commit `public/drapes/`. One entry a style and
body type covers most sizes; the builder also saves the smallest and largest size of each.

## Photo re-draping

Once a garment is draped and posed, the shop's photographs are laid onto its cloth point for point
(`lib/garments/redrape.js`, `FittingStage#advanceRedrape`), so what the cloth shows is the photograph
itself — its plaid, a print on a sleeve, an embroidered logo, a pocket's stitching, a pair of jeans' patches
and back-pocket label — at the visitor's proportions, rather than a colour and a cut-out print. Shops
photograph a garment hanging or laid flat, so the same garment (the same cloth, in the same size) is
simulated hanging the same way: held at its shoulder seams and neck (trousers at the waist), no body under
it, let fall until still (about a second). That gives, for every point of the cloth, where it lies in such a
photo. The hanging silhouette is then registered to the photo's, group by group (each sleeve or leg, the
body) and row by row: each point's share of the way across its group's run of cloth is carried to the same
share across the photo's run on that row, the rows at one scale for the whole garment. Where a sleeve lies
against the body in the photo with no gap, the body's edges seen on rows where it hangs apart are carried
up into the merged rows to split them; where it never hangs apart (a sleeve laid along the body), the row is
shared out by the hanging groups' widths. Row edges are smoothed down the photo and the silhouette so a
weave's edge or a fold doesn't put a ripple in one row.

The photo's cloth mask (`clothMask`) leaves out the backdrop's soft shadow at the garment's edges and a
hanger (its hook, then the rows below that are mostly the hook's colour), and on a dark garment the neck
opening is painted over with the cloth beside it (the backdrop seen through it and the label inside the back
of the neck would otherwise land on the chest). The front panels and the sleeves take the photo of the
front; the back panels the photo of the back, mirrored, when the listing has one, and the front photo
otherwise. A shirt's folded collar (drawn over the drape) is textured with the photo's collar rows, and a
cut-out the listing names that the photo shows covered (a drape over it) isn't cut. Until the photos are
on, the garment shows as before (its colour, its cut-out print); `?redrape=off` keeps it that way.

### Hung or laid out

A garment hung up keeps its roundness, about 0.6 times as wide for its height as the same garment
photographed laid flat. So a top is also laid out on a table with its sleeves at three angles (`hanger.js`'s
`flat`), each outline is scored against the front photo's cloth mask as the validation's silhouette check
scores it (`lib/garments/silhouette.js`), and the best is the one its photos are laid on by. On 14 Kith
photos the outlines matched 0.811 on average instead of 0.788. `?hangtrial=off` hangs it the one way.

## Fitting the pattern to the photo

A garment laid flat or hung for its shop photo is a scale drawing of the pattern we draft, so a top's
pattern is fitted to it (`lib/garments/photo_fit.js`) rather than drafted from the listing's words alone.
The photo's cloth mask is measured (`measureOutline`): the shoulder points (the garment's top corners), the
underarm where the sleeves hang apart from the body, the hem, the waist and hem widths, the neck opening,
each sleeve's length (down its own run, or to the garment's outer corner when it hangs along the body),
bands plainly absent, and the collar's shape from the top edge between the shoulders (a shirt's points, a
band, a stand, an open neckline, a hood; a hanger's cut hides it, and then the listing's word stands).
`fitChart` moves the chart's length, shoulders, sleeve and hem round to the photo's, by the sample size's
share so the grading is kept, within a quarter of the chart's own figure; the yardstick is the sample's chest
where the sleeves hang apart (the body's width under the arms is half the chest), else the chart's length.
The pattern's own proportions (neck width and depth, armhole depth, sleeve width and opening) ride along on
each size as `size.photo`, and the make as `cut.photo`, which `pattern.js` follows: the folded shirt collar is
drawn only when the photo shows one. Photos on a model or close-ups give no outline and change nothing;
`?photofit=off` keeps the old reading, `?photofit=debug` logs what was read.

The re-draped photo goes on the cloth as a material rather than a picture (`redrape.js`'s `flatField`): a
wide blur of its brightness over the cloth is the shop's light and is divided out, gently, so the folds the
garment hung in stay as photographed; what's brighter or darker than its near surroundings is the fabric's
relief (weave, ribbing, stitching, quilting, small creases), kept in the alpha channel as a height the cloth
shader tilts the surface by, so the page's light plays over the real surface. The modelled gloss comes down
under a photo so the fabric isn't lit twice.

## How the cloth looks

- **Its surface, yarn by yarn** (`script/fabrics/build.mjs`, into `public/models/fabrics/`): each fabric's
  structure as its threads make it, a plain, twill, satin or ripstop weave with every yarn over and under its
  neighbours, jersey's loops, rib, brushed fleece, felted wool, leather's grain, with the yarns' twist and
  stray fibres. Each gives a normal map and a detail map (cavity between yarns, roughness, which yarn is on
  top). Denim shows its undyed weft and its slubs, its warp dyed a little deeper so the leg averages to the
  listing's colour. `?yarns=off` keeps the drawn surfaces.
- **Wrinkles** where the drape is squeezed, across the way it's squeezed (`aFold`), as deep as its fabric
  buckles. `?wrinkles=off`.
- **Fuzz** on fleece and felted wool (`lib/garments/fuzz.js`): thin layers of the garment just off it, each
  showing the fibres that reach it, at its edges mostly. `?fuzz=off`.
- **Light through thin cloth**: a jersey, a shirt or silk glows a little against the light. `?glow=off`.
- **Depth at its edges**: hems, cuffs and necklines are a strip as deep as the turned-up cloth. `?rim=off`.
- **Shine along the threads** on silk, twill and nylon shells (anisotropy on the pattern's coordinates).
  `?aniso=off`.
- **Graphics on pants' legs** (leg_prints.js): lettering down a side seam or a logo on a thigh is found in
  the photos, painted out of the photo the legs take, and laid on as one piece each, by measurement: as far
  down the leg as it is below the waistband in the photo, as far in from the side seam as it is in from the
  leg's outer edge, at one scale both ways, so the photo's row-by-row fit can't tear it. Lettering the back
  photo shows again at the same seam is laid once. `script/headless/lettering_check.py` reads the word back
  by OCR (Kith's Essentials sweatpant: 0.17 before, 0.90 after; its shop photo 0.64). The cloth's shader takes
  16 vertex attributes at most, a Mac's limit (`texture_units.mjs` checks both).
- **The path-traced still** (trace.js, bake.js, atlas.js): once nothing moves and the clothes are on, laid
  on and metered, the figure is drawn again by a path tracer (three-gpu-pathtracer, vendored with
  three-mesh-bvh, MIT) on the visitor's GPU: light bouncing between sleeve and body, a jacket's colour on
  the shirt under it, soft shadows from the studio's lights as discs, the same studio map. A few averaged
  frames show first; the traced picture takes over at 4 samples (denoised hard, easing off as samples come
  in, done at 128) and goes at any movement. Each garment goes in as plain maps baked by its own cloth
  shader: every panel packed into a 1024² atlas (`aAtlas`), the shader drawn into it with `uBake` set (1:
  the colour with photo, prints, stitches and metering; 2: the shaded normal and roughness), empty texels
  dilated, hidden cloth at near-zero coverage so `alphaTest` cuts it. One tracer mesh per material: the
  tracer gives each mesh one material, and a two-material mesh shifts every mesh after it onto the wrong
  one. The mannequin goes in posed and shaped, in a plain matte finish. Needs WebGL2 float targets; a GPU
  that takes over 1.5 s on its first sample turns it off for the session, and the averaged still stands in.
  `?trace=off`; `script/headless/trace_still.mjs` renders it headless (slowly: a software GPU).
- **A finer mesh, and folds** (fine.js, wrinkles.js): what's drawn is the drape's cloth subdivided once or
  twice (butterfly subdivision, interpolating: the drape's points stay put, panel edges take their midpoints
  so seams meet), about 0.5 to 0.8 cm between points, refined again each frame from the drape's positions.
  The drape itself lets squeezed cloth shorten rather than buckle (drape.js's SQUEEZE; stiffer, it stands
  off the body and folds no better at its spacing), so the folds are laid on from where it's squeezed: the
  squeeze tensor gives each point a direction, a least-squares integral of that field over the cloth gives
  a phase running at 2π a wavelength, and the amplitude follows the buckling law A = (λ/π)√e, capped at a
  quarter wavelength, faded out within 4 cm of any panel edge, none on hoods and bands. The wavelength is
  the fabric's: 3.5 cm for jersey, longer as thickness^(3/4) and stiffer bending (fleece 5.4, denim 8.6,
  silk 2.2). Each fine point moves along its normal by A times a ridge profile (narrow ridge, broad
  valley, mostly outward). `?fine=off`, `?folds=off`, `?foldgain=3` (to see where they lie),
  `?squeeze=N` (the drape's compression softness, for experiments). Cost: 4 to 9 ms a frame per garment
  for the refinement, 10 to 20 ms every 400 ms for the fold field.
- **Metered to the photo** (stage.js#meter): a camera meters on its subject, and the stage's light is fixed,
  so cloth given its photo's colour came out darker and warmer than the photo (Kith's Armani crewneck: a
  third of a stop under, oatmeal drawn khaki). Once a garment is draped and shown, the scene is drawn as on
  screen from the front, the garment's own pixels found with a second pass, and the garment's material
  given the exposure (and a white balance of at most 8% about it) that brings their middle colour to the
  photo's cloth colour, over three passes. `stage.meterReport(slot)` gives the remaining ΔE (CIE76; the
  Armani: 0, the camo hoodie 4.5, its tile a little redder than the photo's commonest colour). `?meter=off`.
- **The light**: colours go through Khronos PBR Neutral, which keeps the shops' colours. The cloth's shader
  reads at most 15 textures: a Mac or phone GPU allows 16, and one over that draws nothing
  (`script/headless/texture_units.mjs` checks it; the headless browser allows 32, so it can't see this).
- **The still picture** (`lib/still.js`): once nothing moves, frames a fraction of a pixel and the key
  light's place apart are averaged, for smooth edges and soft shadows, with a lens's corners and a fine
  grain. A photo is 16 such frames. `?still=off`, `?finish=off`.

## Studio photos

With a top or casual jacket on, **Take a photo** draws what's on screen at about 2000 pixels, with finer
shadows, right in the page, to save. Nothing is sent anywhere.

For the suit's jacket, coats and trousers, the real-time view imitates cloth and the studio does it properly. The page sends what's on screen (the
mannequin's shape keys and height, each item's size adjustments and colour, and the pose) to
`POST /api/v1/studio_photos`, and the server runs Blender in the background (`script/render/studio.py`):
it shapes the mannequin and refits the suit to it, sizes each garment, poses the rig, drapes the clothes by
cloth simulation (each layer colliding with the ones under it), and path-traces the result with Cycles.
It takes about 30 seconds on an Apple M2.

With **Exact item (AI)** ticked and a try-on service set up, a second image follows: the shops' own photos
of the garments (or your photos) painted onto that measured drape by virtual try-on (`app/models/try_on.rb`),
so it shows the exact item, collar, pockets and wash. The fit stays the measured one. Two services can do it:

- **Fitroom's own**, when `FITROOM_TRYON_URL`, `_KEY` and `_SECRET` are set: open-source try-on models
  (FASHN VTON 1.5, Apache-2.0; Leffa, MIT) on Fitroom's GPU service on Modal (`script/modal/tryon_spike.py`).
  Before anything comes back, three checks run on the service (`script/modal/validate.py`): the figure's
  outline is the render's (**shape**, IoU ≥ 0.85), the garment looks like the shop's (**identity**: DINOv2
  likeness ≥ 0.80 and colour difference ΔE ≤ 12) and its print survived (**print**, SSIM ≥ 0.45 over the
  print region). A picture that fails isn't returned; the page keeps its own render and shows which check
  said no. Only the mannequin's render and the shop's photo go, in memory, and nothing is written or logged.
  `docs/ai-spike.md` has the setup and the comparison of the two models.
- **FASHN's hosted API**, when only `FASHN_API_KEY` is set: images go to FASHN inline and come back inline.
  FASHN deletes inline inputs when the request finishes, expires inline outputs after an hour, and doesn't
  train on them. It runs no checks.

Without either, or with the box unticked, nothing leaves the server. In the photo overlay, **Compare** shows
the store photo, our fit and the AI's finish side by side, with the checks in plain words under the AI's,
and two buttons: **Looks right** keeps it, **Not quite** drops it on the page and goes back to our fit. That
answer stays on the device; nothing is sent or saved.

Renders run one at a time, in memory: the job file is deleted when Blender finishes, the image when it's
fetched (`GET /api/v1/studio_photos/:id/image` works once), and anything unfetched after 10 minutes. The
body shape and height are filtered from the logs. The server needs Blender with MPFB and the MakeHuman asset
pack (as for the model build); set `FITROOM_BLENDER` to its path if it isn't in `/Applications`. Without it,
the button says studio photos aren't available.

## How the fit works

Ease is the garment's measurement minus yours. A jacket needs some ease to move in, and each cut wants a
different amount (slim, regular, classic). For each size Fitroom checks five things:

| Part | Target | Can a tailor fix it? |
|---|---|---|
| Shoulders | Seam on the shoulder bone: ¾ cm inside to 1.5 cm past | No |
| Chest | 6–17 cm of ease, depending on the cut | No |
| Waist | 6–20 cm of ease, depending on the cut | Take in up to 5 cm, let out up to 2.5 cm |
| Sleeves | Ending about 1.5 cm above the wrist bone | Shorten up to 5 cm, lengthen up to 3 cm |
| Length | About 43% of your height | No |

Sizes are ranked by how far off they are, and parts a tailor can't fix count much more.
