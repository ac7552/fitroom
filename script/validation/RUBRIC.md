# Grading the validation renders

Each contact sheet shows up to 5 outfits (older sheets: 10, smaller). One outfit per block: its key (top left), then each garment's
store photo (grey tile) with a caption `<category>: <style the app drew it as>` (`ERR` in red = the garment
couldn't be added), then the outfit drawn on the mannequin from the front, the wearer's left side, and behind.

The data for each outfit is in `runs/<key>.json` (one outfit each, as `VAL.export(…, { pics: false })` gives it) (items[]: handle, cat, kind, style, fabric, name, cut, checks,
photo reading). Use the handle and name from there.

For EVERY garment in the outfit, decide what a shopper comparing the store photo with the 3D picture would say:

- `ok`: it reads as that garment. Small differences are fine: lighting, slightly different shade, fabric sheen,
  drape, a small logo a little off, a hood worn down at the back instead of up as in the flat photo.
- `minor`: a shopper would notice something off but still recognise it (a contrast collar drawn in the body
  colour, a small graphic a bit wrong, a pocket missing, a slightly too dark shade).
- `fail`: a shopper would say it isn't the thing in the photo, or it's clearly broken.

For `minor` and `fail`, name ONE cause (the main one):

| cause | what it covers |
| --- | --- |
| `type` | the wrong kind of garment (a shirt drawn as a tee, a skirt as shorts, a jacket as a blazer, a dress as a top) |
| `sleeves` | sleeves the wrong length (short drawn long, long drawn short, sleeveless drawn with sleeves) |
| `colour` | the main colour clearly wrong (brown drawn grey, grey drawn navy) |
| `print` | a graphic, logo, lettering, pattern or wash missing, misplaced, or a mess (a small logo drawn as a big patch) |
| `parts` | two-tone or contrast parts missing: sleeves, collar, panels, colour blocks, trims |
| `shape` | length, width or silhouette clearly wrong (a cropped top drawn long, wide legs drawn slim, an A-line drawn as a tube, a mini drawn to the knee) |
| `feature` | a construction feature missing or invented: hood, collar, lapels, zip, buttons, pockets, ruffles, ties, straps, cuffs |
| `clip` | the body showing through the cloth, holes, tears, crumpled or exploded cloth, a garment floating off the body |
| `missing` | the garment isn't on the mannequin at all, or `ERR` |

Look at the store photo carefully at the start of each outfit. A garment hidden under another one (a top
under a jacket) is graded from what shows; if nothing of it shows, grade it `ok` unless something visible is
wrong.

Kith files a few garments in the wrong collection (a hoodie or a trench coat under bottoms, a jacket under tops), so
the caption's category can be wrong. Grade each garment as what its photo shows; the app drawing a hoodie filed
under bottoms as a hoodie is right. An outfit with no bottoms because its "bottom" was a jacket shows bare legs:
that's not a fault of any garment.

Calibration (already graded):

- m-tb-025 varsity jacket, navy body with WHITE sleeves, drawn all navy: `fail parts`.
- m-tb-028 short-sleeve black shirt drawn with long sleeves: `fail sleeves`.
- m-tb-008 white tee with a small green chest word, drawn with a red patch at the neck: `fail print`.
- m-tb-023 brown overshirt drawn grey: `fail colour`.
- m-tb-019 puffer jacket with a hood, drawn with no hood at all: `fail feature`.
- m-tb-001 orange jacket with a brown corduroy collar, drawn with an orange collar: `minor parts`.
- m-tb-022 washed charcoal tee drawn black: `minor colour`.
- m-tb-016 light grey sweatpants drawn navy from the front (grey from behind): `fail colour`.
- m-tb-040 tactical vest (webbing, rings, pockets) drawn as a plain black tank: `fail feature`.
- m-tb-055 light-wash denim jacket drawn as a royal blue shirt: `fail colour`.
- m-tb-058 houndstooth/plaid track jacket drawn plain olive: `fail print`.
- m-tb-052 charcoal (anthracite) knit drawn black: `minor colour`.
- m-tb-061 long-sleeve crewneck drawn with wide bell sleeves, its graphic spilling onto them: `minor shape`.
- m-tb-043 cargo pant drawn without its cargo pocket: `minor feature`.
- m-tb-061 jogger with a clear script logo on the thigh drawn plain: `minor print`.
- m-tb-046 top shown `ERR`: `fail missing`.
- w-od-001 a dress under a jacket, collapsed in a heap at the feet (bare legs): `fail clip`.
- w-d-004 a sequin mini dress drawn to the floor: `fail shape`.
- w-otb-000 a solid green dress drawn pale and see-through: `fail colour`.
- w-otb-000 a fluffy hooded shearling jacket drawn smooth, without its hood: `fail feature`.
- w-otb-002 a teddy-fleece jacket drawn as smooth cloth (shape and colour right): `minor print`.
- w-d-003 a crystal-mesh maxi drawn as plain satin: `minor print`.

Seen often (grade them the same way):

- Pants laid with their photo showing a white or light stripe down a side seam or a dark smear at the hem (the
  photo's background or hanger carried onto the cloth): `minor print`.
- A dress whose photo shows sleeves (short or long) or a collar, drawn sleeveless or as a halter: `fail sleeves`.
- A sweatshirt or fleece with a quarter-zip or a funnel collar drawn as a plain crewneck: `minor feature`.
- A big chest graphic or logo missing altogether: `fail print`; a small one drawn in the wrong colour: `minor print`.

Outfits marked "(not settled)" on the sheet (the drape didn't finish in time, so the mannequin can be bare):
don't grade them at all; they're run again. A garment whose data says `replaced by <handle>` (the outfit
holds one garment of each kind, and a later one took its place): grade it `na`. A garment that shows `ERR`
with the message "Fitroom can't try this on yet" is the app's failure: `fail missing`.

Before grading a sheet, print its outfits' data (what the app read, the item names):

    python3 show.py <key> <key> ...

Write grades with one command per outfit (run it from this folder):

    python3 grade.py <key> <handle>=<ok|minor|fail|na>[:<cause>[:<short-note-with-dashes>]] ...

Every garment of every outfit on your sheets gets a grade. Don't regrade outfits already in grades.json.
