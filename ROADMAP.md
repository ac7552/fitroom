# Roadmap

Fitroom is single-user and stores nothing about the person using it. Every item below keeps it that way:
no accounts, no uploads, no photos, nothing saved about the user on the server or in the browser.

## Now

Build an outfit (a jacket, a coat over it, trousers) from links, pasted charts or photos with measurements,
and see it on a white display mannequin in your shape, in any sizes and a few poses, with a fit map and a
tailor's verdict for each item. The web page and a future mobile app share one JSON API.

## Next

**A mobile app.** A separate client on the same `/api/v1` endpoints (see `docs/api.md`), using the same
model file and solver (`lib/body_fit.js` has no browser dependencies). Like the web page, it keeps
measurements in memory only.

**More body types.** There's now a woman's mannequin (a slender display form) beside the man's, with dresses
and women's sizes. Next: builds (slim, athletic, broad, curvy) that set MakeHuman's macro sliders before
measurements fine-tune them.

**Rompers and jumpsuits.** One piece with legs: a pattern that joins a bodice to shorts or trousers.

**The details of complicated clothes.** Belts, ties and sashes, scarves, cut-outs, sheer panels, ruffles and
uneven hems are named on the item card but not drawn yet.

**Trousers and skirts draped like the tops,** and women's blazers and coats (today they're the men's cut).

**A test set of real listings.** Shirts, pants, dresses and things Fitroom doesn't fit yet (belts, shoes),
each with what it should come out as, run against every change.

**A garment library.** Jackets are drawn as a suit blazer, or as a casual jacket built from the body in
zip-up, bomber and denim/button-up styles. More shapes would help: hooded jackets, puffers with
quilting, an overcoat with its own collar, overshirts, and double-breasted tailoring. MakeHuman's CC0
suits pack adds double-breasted and dinner jackets. Anything else needs models licensed for a public
repository (CC0 or CC-BY, or commissioned), or more styles of the casual jacket. Reading the style from
the shop's photo would also help when a listing says only "Jacket".

**Better studio photos.** They're draped by real cloth simulation now, but on MakeHuman's simple suit: give
them real garment models (a proper overcoat, finer shoulders and hems), authored poses from MakeHuman's CC0
pose pack, and a render farm or GPU so they take seconds, not half a minute.

**More shops.** Adapters for common store platforms that load size charts in pop-ups, and an optional AI
extractor for messy pages (it reads the shop's page, never anything about the person).

**Compare two sizes side by side**, on two copies of the mannequin.

## Later

**Shirts and knits.** These need stretch-aware ease, because knits fit with negative ease.

**A how-to-measure guide.** An animated tape on the mannequin shows where each measurement goes.

**Fit notes for real alterations.** Costs and limits for common jobs, like hemming sleeves through a
working cuff versus a plain one.

**An offline install.** A PWA that works with no connection, since nothing needs the server after the page
loads.
