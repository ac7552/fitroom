# Fitroom

See how clothes fit before you buy them. Paste a product link (or a size chart, or just a photo), enter a few
of your own measurements, and Fitroom puts the clothes on a 3D display mannequin shaped like you, man's or
woman's, in every size: your best size, part by part, what a tailor could change, and what they couldn't.
Tops, dresses and casual jackets are sewn from a real pattern and draped with a cloth simulation in the
browser; suit jackets, coats and trousers are fitted from a tailored 3D model.

**Who it's for:** anyone buying clothes online who's tired of guessing sizes and sending things back. The page
is written for a 4th to 6th grade reading level: plain words, sliders for every measurement, and example
numbers to start from. It's a personal tool I'm building for myself first.

**Built with:** Ruby on Rails 8 (the fit math, the link importer and a JSON API), Hotwire Stimulus and
Three.js on the page (the mannequin, the cloth simulation and the fabrics), and Blender with MakeHuman's CC0
assets for the 3D model. No accounts, and nothing about the person using it is kept.

**Run it:**

```bash
bundle install
bin/rails db:prepare
bin/dev            # http://localhost:3000
```

Optional settings are environment variables, listed in `.env.example`; Fitroom runs without any of them.

## What works today

- **Clothes from a link:** Shopify shops (read through the shop's product data and its Kiwi Sizing chart),
  pages with a size chart table, resale listings with an item's own measurements, and size-only listings.
  Shops that turn apps away (The RealReal) say so straight away, with the other ways to add clothes.
- **Or a pasted chart, typed-in sizes, or just a photo:** the photo's outline tells a T-shirt from a
  long-sleeve top, sweatshirt, hoodie, zip-up jacket, dress or pants, which then come in their usual sizes.
- **Tops and dresses drawn as they're cut:** T-shirts, long sleeves, sweatshirts, hoodies, shirts, zip-ups and
  bombers; dresses sleeveless, on wide or thin straps, strapless or over one shoulder, from mini to maxi, fitted
  to flared, in stretch, jersey, cotton, leather or silk, read from the listing's description.
- **Fit for men's and women's sizes:** letter sizes, US dress sizes (00 to 16), suit sizes and waist sizes;
  stretch dresses that are made smaller than the body; clothes made big on purpose (oversized, dropped
  shoulders) judged as they're meant to be worn.
- **The 3D view:** four poses, a fit map, the clothes alone, six mannequin shades, the store photo's colour and
  print on the cloth, and a photo button.

## To do

The plans are in [ROADMAP.md](ROADMAP.md). The next ones: rompers and jumpsuits; the details of complicated
dresses (belts, ties, scarves, cut-outs); trousers and skirts draped like the tops; women's blazers and coats;
and a wider test set of real listings (shirts, pants, dresses) checked on every change.

## What it stores, and what it doesn't

- **Your measurements are never stored.** They go to the fit API with each request, are used for that one
  response, and are dropped. There's no table to save them in, `measurements` is filtered from the server log,
  and responses are sent with `Cache-Control: no-store`. On the web page, the inputs have no `name`, so
  they're never submitted, and `autocomplete="off"` keeps the browser from remembering them. Nothing goes in
  cookies or browser storage. Refresh the page and they're gone.
- **There are no accounts or logins, and photos never leave the device.** A photo of a jacket is read in the
  browser only, for a preview and its colour; it's never uploaded. A pasted product link is fetched once, read for its
  size chart, and cached for an hour by link; nothing records who pasted it.
- **The only data in the repo is about garments:** size charts in `config/size_charts/`. The one there now
  is made-up sample data, not any real brand's.

## Web and mobile

The web page and the mobile app are separate clients of one JSON API under `/api/v1`. The fit math lives
only on the server (`app/models/fit.rb`), so both clients always agree. See [docs/api.md](docs/api.md).

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
  heavier and stiffer, as turned-up hems are. It runs a few milliseconds per frame, so you see it settle.
- `dress.js` turns it into the garment on screen, follows the poses by skinning it to the mannequin and
  settling it again, shades its folds, and paints its fit map by part.
- `fabric.js` draws the cloth: knit, rib, fleece, twill or nylon at real scale, with seams, hem stitching,
  zips, buttons and a hoodie's pocket.
- `print.js` reads the shop's photo for the garment's colour and any print on its front, which is laid on
  the cloth. Only the front: sleeves and backs stay plain.

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
CC0 studio HDRI. Credits: [public/models/CREDITS.md](public/models/CREDITS.md).

To rebuild it you need Blender 5.2+, the MPFB extension and MakeHuman's CC0 system asset pack:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --python script/mannequin/build.py -- public/models
```

## Studio photos

With a top or casual jacket on, **Take a photo** draws what's on screen at about 2000 pixels, with finer
shadows, right in the page, to save. Nothing is sent anywhere.

For the suit's jacket, coats and trousers, the real-time view imitates cloth and the studio does it properly. The page sends what's on screen (the
mannequin's shape keys and height, each item's size adjustments and colour, and the pose) to
`POST /api/v1/studio_photos`, and the server runs Blender in the background (`script/render/studio.py`):
it shapes the mannequin and refits the suit to it, sizes each garment, poses the rig, drapes the clothes by
cloth simulation (each layer colliding with the ones under it), and path-traces the result with Cycles.
It takes about 30 seconds on an Apple M2.

With **Exact item (AI)** ticked and a `FASHN_API_KEY` on the server, a second image follows: the shops' own
photos of the garments (or your photos) painted onto that measured drape by [FASHN](https://fashn.ai)'s
virtual try-on (`app/models/try_on.rb`), so it shows the exact item, collar, pockets and wash. The fit stays
the measured one. Images go to FASHN inline and come back inline: FASHN deletes inline inputs when the
request finishes, expires inline outputs after an hour, and doesn't train on them. Without a key, or with
the box unticked, nothing leaves the server.

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

## Stack

Rails 8 · SQLite · Hotwire (Turbo + Stimulus) · importmap · Three.js r170 (vendored in
`vendor/javascript`, so the page loads nothing from a CDN) · Nokogiri · Blender + MPFB for the 3D model.
Ruby 3.4.3.

The home page opens on a blazer drawn as a technical sketch that turns into cloth as you scroll, with its
measurements beside it (`app/javascript/controllers/hero_controller.js`). It stays still for people who
prefer reduced motion.

## Run it

Ruby 3.4.3 and Node 22 (for the JavaScript tests only).

```bash
bundle install
bin/rails db:prepare
bin/dev            # http://localhost:3000
```

Optional: `FASHN_API_KEY` turns on the studio photo's "Use store photos (AI)" try-on, and `FITROOM_BLENDER`
points at Blender for the path-traced studio photos (see `.env.example`).

## Tests

```bash
bin/rails test                            # fit math, link importer, the API and the page
node --test test/javascript/*.test.mjs    # body solver, photo reading, display formatting (Node 22+, no packages)
```

## Plans

See [ROADMAP.md](ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE). The 3D model's assets are CC0; see
[public/models/CREDITS.md](public/models/CREDITS.md).
