# Validation set

Seven hundred garments from kith.com, 100 in each group (men's tops, outerwear and bottoms; women's tops,
outerwear, dresses and bottoms), worn in 600 outfits and run through the page as a shopper would, so a change
can be measured by how many of them still look like their store photo. Development only: nothing here ships.

| file | what it is |
| --- | --- |
| `sample.js` | picks the set from Kith's collections (paste into a kith.com tab's console) |
| `sample.json` | the set picked on 2026-10-30, seed 20261030: each group's collections, product types and items |
| `build_runs.py` | the outfits: `python3 script/validation/build_runs.py script/validation/sample.json > script/validation/runs.json` |
| `runs.json` | the 600 outfits (`key`, `body`, `items: [{ handle, cat }]`, `phase`) |
| `runner.js` | runs outfits in the page and keeps what each garment came out as, with pictures |
| `sheet.js` | contact sheets of finished outfits (store photos beside the front, side and back renders), to grade |
| `RUBRIC.md` | how an outfit is graded, with the calibration examples |
| `show.py`, `grade.py`, `aggregate.py` | print an outfit's garments for grading; record grades; sum them per group and cause |

## Running it

The runner and sheets are served by the dev server from `public/validation/` (ignored by git):

    mkdir -p public/validation && cp script/validation/{runner.js,sheet.js,runs.json} public/validation/

Then in a tab at http://localhost:3000 (it can be hidden; the runner keeps its timers going), from the console:

    const VAL = (await import("/validation/runner.js")).default
    const runs = await (await fetch("/validation/runs.json")).json()
    VAL.load(runs.filter(r => r.phase === 1)); VAL.start()
    await VAL.wait()                      // { left, done, log }
    VAL.export(0, 20, { pics: false })    // what each garment came out as (JSON)

Each outfit takes one to three minutes (a bottom's photo reading and the drape are most of it). Several tabs
share the work: give each its own slice of the runs. A tab's results stay in that tab (`window.__val.results`).

For each garment the runner keeps the kind and style it was drawn as, its fabric and colour, its size verdict,
what was read from its photo (print, stripes, back print, sleeve prints, the bottoms' photo map), the page's
own photo check (tops), and the automatic checks:

- `kind`: what it was sorted as, against the collection Kith files it under (a few of Kith's are misfiled);
- `sleeves`: long or short as drawn, against the sleeves its photo shows;
- `look`: the page's photo check passed (tops);
- `photoRead`: a bottom's photo was read and laid on.

The page's photo check runs once (`VAL.firstLook`, on by default): the page tries a failed check again up to
three times, a new reading and drape each, which takes minutes in a hidden tab. The first check's result is
kept with the garment (`look.ok`, `look.failed`). With `VAL.noLook` the check doesn't run at all (a quarter
of a run in a busy tab; the grade looks at the photo anyway).

An outfit waits for its drape to settle and for every garment's photo to be read (`VAL.settleMs`, 6 minutes
at most; `VAL.readMs`, 2½ minutes for the photos), so the pictures show what a shopper would see once it's all
loaded; `settled: false` marks one that ran out of time, to run again. `VAL.photoChecks = false` skips the
runner's own reading of each photo (the `sleeves` check), which is slow in a busy tab.

## Grading

    const sheet = (await import("/validation/sheet.js")).default
    await sheet(["m-tb-000", "m-tb-001"], { big: true })   // a JPEG data URL, five outfits a sheet

Every garment of an outfit gets `ok`, `minor` or `fail` and, when it isn't ok, one cause (RUBRIC.md):

    python3 script/validation/show.py m-tb-025     # its garments, from runs/m-tb-025.json (VAL.export, no pictures)
    python3 script/validation/grade.py m-tb-025 khm030245-001=fail:parts:white-sleeves-drawn-navy ...
    python3 script/validation/aggregate.py

A garment counts once, at its worst grade over the outfits it's in (`na`: another garment of the same kind took
its place in that outfit, so it's graded in its other one). `runs/` and `sheets/` aren't kept in git.
