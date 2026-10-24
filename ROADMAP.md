# Roadmap

Planned work, roughly in the order I want to build it. None of it is built yet.

Every feature keeps Fitroom's one rule: nothing about the person is stored, on the server or in the
browser, and nothing about them is sent to an AI. AI reads the shop's side only (pages, size charts,
garment photos, labels). Every answer is one plain sentence a shopper can act on (which size to buy, and
what a tailor would change), in the shopper's own units, and says so when it rests on an estimate rather
than the shop's own measurements.

## Groundwork

Four pieces are shared between features, so they get built once.

**Draping from where the cloth is.** Today the drape's key in `lib/stage.js` includes the body's shape
(`fitted.scale` and `fitted.influences`), so every slider step throws the cloth away and sews it again
from flat, while the old cloth hangs on a body that has already changed. Changing your numbers (1), the
steadier fitting room (2) and movement (9) all need the opposite: carry the settled cloth onto the new
body and let it settle again from there, which takes a fraction of the time.

**Screenshot tests for the 3D view.** Draping changes are easy to break by eye and hard to catch in unit
tests. Render each garment style in two sizes on the example bodies, in each pose, with headless Chrome
(CI already runs system tests in it), and compare against saved images. Clipping and missing pieces
show up as a failed test, not a bug report.

**An AI reader for the shop's side.** Reading listings (3), outfit ideas (5) and vintage labels (7) use
Claude through one small client: server-side, switched on by a key in `.env.example` like FASHN's, cached
per link, and given shop pages and garment photos only. What it returns goes through the same checks as
any size chart (`ChartReader`, and the fit API's "doesn't look right" errors) before it's used, and
Fitroom works as it does today without a key.

**A test set of real listings.** Save 30 to 50 product pages (Shopify shops, Kith, size-guide pages,
pages whose chart is an image, resale and vintage listings, watches and bags), each with the garment
type, sizes and best size it should come out with, and run them in CI next to `garment_import_test.rb`.
It's also how the AI reader (3) is held to the same standard as the rules it backs up.

Features 4, 6, 8 and 10 don't need any of the groundwork, so they can go ahead while it's built.

## 1. Change your numbers with the clothes on

The moment you see the fit is the moment you notice a number is wrong: the sleeves look short, so you
check your arm. Today moving a slider restarts every drape. With the groundwork, the clothes stay on and
follow the body as it changes, the fit card updates as you drag, and the size chips show which size
becomes best and when: "at a 41 in chest, M is still best; past 42 in, L." A small "what changed" line
says which parts moved from fits to tight, so a mis-measured arm is obvious.

## 2. A steadier fitting room

The 3D view should never be the reason someone doesn't trust the answer. Fix what makes it feel glitchy:

- **No popping between sizes.** Drape the sizes either side of the one shown in the background, so
  tapping a size swaps instantly instead of waiting for a new drape.
- **No clipping.** Fix where the body shows through the cloth (armpits, the seat, the waistband under a
  tucked top) and where a top hangs above pants it should lie on.
- **No stalls.** Move the cloth simulation in `lib/garments/cloth.js` into a Web Worker, so turning the
  mannequin stays smooth on a phone while cloth settles.
- **Coats as long as they are.** Coats are drawn from the suit's jacket, so long coats look short (the
  page says so today). Sew and drape suit jackets and coats like the casual jackets, so they hang at
  their real length and over what's under them.

## 3. Read any listing

The rules in `garment_import.rb` read Shopify, Kith, Kiwi Sizing and pages with a size table. Many shops
put the size chart in an image, a pop-up, or a sentence ("model is 6'1" wearing M; chest 22 in flat").
When the rules find no chart, the AI reader reads the page and the chart image, and returns a chart in
the same shape, marked "read by AI" on the item card. The test set measures how often it matches the
right answer before it's switched on for everyone.

## 4. Fit from clothes you already own

Most people don't know their chest measurement, but they know which tee fits them. Paste the link to
something you own, say which size you bought and how it fits ("perfect", "tight in the shoulders",
"sleeves a bit long"), and Fitroom works backward from that chart to your body with the same solver as
`lib/body_fit.js`. How it fits also says how much room you like, so someone who wears things slim and
someone who wears them loose get different sizes of the same shirt. Every new item is then compared with
it: "same chest as your Uniqlo M, an inch longer in the body." The owned piece shows as a ghost outline
over the new one on the mannequin.

## 5. What goes with it?

Add a jacket and ask for the rest of the fit. The AI reader sees the items in the outfit (what they are,
their colour, fabric and cut, from the listings) and suggests what would complete it, with a reason:
"dark straight-leg denim and a white heavyweight tee; the jacket is cropped, so keep the tee short or
tuck it." Fitroom, not the AI, adds the numbers: for each suggestion, the garment measurements that would
fit you ("look for a 32 in waist, 30 in inseam, a straight leg about 8 in at the hem"), with a search
link for each shop already in the outfit. Paste one in and it's tried on with the rest. The AI never sees
your measurements.

## 6. The fit's price

The outfit list knows every piece; it should also know what the whole fit costs. The importer reads each
listing's price (Shopify's product JSON already has it), and `fit.rb` already says whether each size fits
as it comes, needs a tailor, or can't be fixed. Add typical alteration prices, labeled as estimates, and
show one total: "the fit is $410: jacket $220, jeans $120, tee $40, plus about $30 to hem the jeans." When
a cheaper size or a pasted alternative fits as well, say so: "the L tee at $35 fits the same." A
printable ticket lists each alteration, by how much, to hand the tailor.

## 7. Vintage and secondhand

Resale listings with their own measurements already work. Vintage needs more:

- **Flat measurements with no chart.** Grailed, eBay, Depop and Vinted give "pit to pit 22 in" (doubled
  for the round), "shoulder to hem", "waist laid flat". Read them all, and judge the one size there is.
- **The label.** A photo of the tag goes to the AI reader for the brand, the size, the country and,
  roughly, the decade. Old sizes ran smaller than today's, so a 1980s "L" isn't read as a modern L, and
  the card says when the size on the tag shouldn't be trusted.
- **The tailor leads.** Vintage is usually bought to be altered: "sleeves can come down 1.5 in from the
  cuff; the shoulders can't change, and they fit."

## 8. Watches, bags and earrings

Imports turn these away today. Each gets its own simple rule and a true-size model on the mannequin:

- **Watches** fit by the wrist (one new, optional measurement): the case should sit within the top of the
  wrist, lug to lug. "A 44 mm case is 51 mm lug to lug, wider than your wrist; 38 to 40 mm would sit
  right." The strap length is checked against the wrist too.
- **Backpacks** fit by torso length, estimated from height and the mannequin: where the straps sit, where
  the bottom lands, and whether it's a daypack or will hang below the hips.
- **Earrings and necklaces** are drawn at true size against the head and shoulders, with the drop length
  in words: "this 3 in drop reaches just above the collarbone."

## 9. Will it pull when you move?

The fit map is worked out from chart numbers, and the poses in `public/models/poses.json` are standing,
relaxed, walking and arms out. Add sitting and reaching forward, read how far the cloth stretches in
each, and paint where it pulls: across the back when you reach, at the seat when you sit. The card says it
in words: "pulls across the back when you reach; size up or choose a stretch fabric." A jacket that
passes on the chart but is tight across the back gets flagged.

## 10. Keep it or send it back?

The parcel has arrived and the return window is open. Lay the piece flat, enter four or five
measurements, and Fitroom compares it with the chart it was bought from and with your body. The answer is
keep, alter or exchange, and for which size: "the chest is 1.5 in smaller than the chart says. It fits,
but the L would fit as the chart promised; exchange if you want room."
