# Kith sample of 7 November 2026: 359 products, graded

The baseline for `docs/plan-2026-11-accuracy.md`. 359 Kith products picked at random, run through the page
one at a time on a development machine, and each graded by eye against its shop photo. **354 graded: 74 ok,
157 minor, 123 fail (35% fail).** By category: outerwear 61% fail, dresses 47%, tops 43%, footwear 30%,
bottoms 12%.

| file | what it is |
| --- | --- |
| `sample.json` | the products, by group: title, brand, type, tags, description, photo links. `sample.js` with the groups below, seed 20261107 |
| `runs_apparel.json`, `runs_shoes.json` | the run lists the runner takes (259 apparel, 91 shoes), from `build_runs.py` |
| `grades.csv` | one row per run: `key`, `grade`, `tags`, `note` |
| `grades_step1.csv`, `grades_step2.csv` | the same after each step of the plan (`regrade_step1.py`, `regrade_step2.py`): the runs rendered again regraded, the rest as they stood |
| `tally.py` | the counts by category and cause, and the projected fail share as the plan's steps land |
| `build_runs.py` | rebuilds the run lists from `sample.json` |
| `photo_roles.json` | the role of each listing's first eight photos (1,228 photos of 346 listings), labelled by eye: what `photo_roles.js` is held to, and what its examples are built from |

## The groups

Fifteen products from each apparel collection and twelve from each footwear collection, by product type and
round the brands (`sample.js`), plus the eight links the person sent (`user`):

    m_tee mens-apparel-tees · m_hoodie mens-apparel-hoodies · m_sweat mens-apparel-sweatshirts + crewnecks
    m_shirt mens-apparel-button-ups · m_knit mens-apparel-sweaters · m_jacket mens-apparel-outerwear-jackets
    m_coat mens-apparel-outerwear-coats · m_pants mens-apparel-pants · m_denim mens-apparel-denim
    m_shorts mens-apparel-shorts · w_tee womens-apparel-tees · w_hoodie womens-apparel-hoodies
    w_dress womens-apparel-dresses · w_outer womens-apparel-outerwear · w_pants womens-apparel-pants
    w_skirt womens-apparel-skirts · w_shorts womens-apparel-shorts
    fm_sneaker fm_boot fm_sandal · fw_sneaker fw_boot fw_heel fw_sandal fw_flat (+ loafers, derbys)

## Running it again

The same set, the same way, is how each step of the plan is measured. It needs the dev server
(`bin/rails s`) and a browser; nothing runs on the droplet.

1. Serve the runner: `mkdir -p public/validation && cp script/validation/{runner.js,export.js} script/validation/kith_20261107/runs_*.json public/validation/`
2. In a tab at `http://localhost:3000` (several tabs share the work; each takes a slice):

       const VAL = (await import("/validation/runner.js")).default; window.VAL = VAL
       VAL.picSize = [480, 720]; VAL.photoThumb = 480          // renders big enough to grade
       const runs = await (await fetch("/validation/runs_apparel.json")).json()
       VAL.load(runs.filter((_, i) => i % 4 === 0)); VAL.start()   // tab 1 of 4

   For shoes: `VAL.feet = true; VAL.picSize = [640, 480]` and `runs_shoes.json`. The feet close-up frames
   the camera on the ankles from a little in front, the side and behind.
3. Every few minutes, in each tab: `await (await import("/validation/export.js")).default(VAL, "t1")` saves a
   zip of the finished runs' contact sheets and records to the browser's downloads.
4. `script/validation/collect.sh` unpacks the zips into `tmp/kith/review/raw/` (sheets as `<group>__<handle>.jpg`).
5. Grade the sheets into `grades.csv`, then `python3 script/validation/kith_20261107/tally.py`.

About 1.5 minutes a garment and 30 seconds a shoe per tab on a 2024 MacBook Pro; five tabs did the set in
an hour and a half.

## Grades and tags

`ok` reads as the product · `minor` right, with a visible flaw · `fail` a different-looking garment or a
glaring artefact. Tags name causes (a piece can carry several):

| tag | meaning |
| --- | --- |
| `WORN` `CLOSEUP` `S-wrongphoto` `B-backphoto` `BACKWARP` `MULTI` | the wrong photo was used: on-model, a close-up crop, a sole or angled shot, another photo on the back, a multi-pack |
| `COLLAR` `NECK` `HOOD` `SLEEVE` | the collar, neckline, hood or sleeves are missing or the wrong kind |
| `LEN` `KIND` `B-len` `B-shape` | length, garment type or closure misread; a bottom's length or leg shape |
| `P-stretch` `P-hood` `P-lost` `CORD` | a print stretched or moved, the hood's inside read as print, a print missing, drawcords read as print |
| `SWIRL` `SHADE` `STRIPE` `KNIT` | swirls, streaks or smears on the cloth; stripes bent; a knit's structure lost |
| `COLOR` | the colour wrong, or a contrast part in the body's colour |
| `HEM` `HANGER` `SEAM` | hem slits left open; the hanger drawn; seam lines |
| `FUR` `SHEER` `TAILOR` | fur drawn flat; sheer cloth opaque; the old suit model used for a blazer |
| `IMPORT` | the import failed (a server regexp broke on a title with ™ or û; fixed) |
| `S-front` `S-back` `S-streak` `S-washout` | a shoe's front or back smeared from the side photo; stripes; a light shoe ghostly |
| `S-open` `S-nofoot` `S-tear` `S-hole` | openings filled; the foot hidden; ragged vamp; see-through holes |
| `S-heel` `S-toe` `S-blob` `S-tilt` `S-tabi` `S-parts` | heel or toe wrong; lumpy shape; an angled photo read as a heel; a split toe or a part lost |

## Photo roles (step 1 of the plan)

Every listing photo gets a role before it's read (`app/javascript/lib/garments/photo_roles.js`). The labels in
`photo_roles.json` are the truth it's held to, letter by photo: `F` flat_front (a shoe: its side), `B`
flat_back, `M` on_model, `C` closeup, `S` sole, `A` angled, `P` pair, `V` view (a shoe square on from above,
behind or in front), `T` tag, `O` other; `foreign` lists photos of another garment in a listing (a liner),
which must never be its back. In the page at `http://localhost:3000`, with `script/validation/photo_roles_*.js`
copied to `public/validation/` and the labels beside them as `photo_roles_truth.json` (and `sample.json` as
`sample_20261107.json`):

    const C = await import("/validation/photo_roles_crawl.js"); await C.crawl(); await C.save()  // ~30 min, once
    const E = await import("/validation/photo_roles_eval.js"); await E.colours()
    E.evaluate({ centroids: 4 })   // each listing held out, its photos read against the others' examples
    E.before()                     // the photo choice before photo_roles.js, on the same labels
    E.pack({ centroids: 4 })       // the examples photo_role_examples.js ships
    const K = await import("/validation/photo_roles_check.js"); await K.check(); K.report()   // step 1's gate

`check()` reads every listing as the import does (the controller's `readShop`) and `report()` lists any front
(or shoe side) that isn't the garment on its own, any back that isn't its back, any close-up that isn't one,
with the time the roles took. Kith turns a browser away for a while after a few hundred quick requests; `check`
pauses between listings and takes up where it stopped.

A remote session that can't reach the browser's downloads saves its runs with `script/validation/export_log.js`
in place of `export.js` (each run's sheet and record are posted to the dev server, which writes them into
`log/development.log`), then `python3 script/validation/collect_log.py <tag>` takes them out into
`tmp/kith/<tag>/raw`.

## Parts (step 2 of the plan)

Rendered again the same way, a few runs at a time, with `script/validation/probe.js` copied to
`public/validation/` (it runs keys through the runner and sends pictures out without the browser's downloads):

    const { runKeys, snapRuns } = await import("/validation/probe.js")
    await runKeys(["user:rhufw26ho03012-8611", "m_knit:dai2610166-blk"], { pic: [480, 720] })   // poll window.batch.done
    await snapRuns("look1", ["user:rhufw26ho03012-8611"])   // a grid: photo, front, side, back

`script/validation/snap.sh` takes the grids out of `log/development.log` into `tmp/kith/snaps/raw/`. The
finished runs go out with `export_log.js` as before (`await exportLog(VAL, "step2")`, then
`collect_log.py step2`), and `python3 script/validation/compare.py step2` lays each run's baseline sheet over its new one.
As for step 1, `regrade_step2.py` writes `grades_step2.csv` from `grades_step1.csv` and the 48 runs graded again
(`runs_step2.json`); `tally.py grades_step2.csv` counts them.

The photo reading's time on its own, against the budget: `script/validation/bench_read.js` in a quiet tab (the
runner's `times.read` are taken while the cloth drapes and other tabs run, and overstate it).
