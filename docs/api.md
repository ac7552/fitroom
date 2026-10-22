# Fitroom API (v1)

JSON over HTTP, used by the web page and the mobile app. It's stateless: no accounts, sessions or
cookies. Lengths in responses are always centimetres; clients format them for display.

## GET /api/v1/fit_guide

What to ask for and which cuts to offer.

```json
{
  "units": "cm",
  "measurements": [
    { "key": "chest", "label": "Chest", "help": "Around the fullest part, under the arms.", "min_cm": 60, "max_cm": 200 }
  ],
  "cuts": [
    { "key": "regular", "label": "Regular", "chest_ease_cm": { "min": 9, "max": 13 }, "waist_ease_cm": { "min": 10, "max": 15 } }
  ]
}
```

## GET /api/v1/size_charts

Every chart, without its sizes: `{ "size_charts": [{ "key", "name", "garment", "source" }] }`

## GET /api/v1/size_charts/:key

One chart with its finished garment measurements per size (`chest`, `waist`, `shoulders`, `sleeve`,
`length`, in cm).

## POST /api/v1/garment_imports

Reads a jacket, coat or trousers from a product link or a pasted size chart. Send `{ "url": "https://..." }`
or `{ "text": "Size\tChest\t...", "garment": "jacket" }` (`garment` says what a pasted chart is for). The
response's `garment.garment` says which it is.

```json
{
  "garment": {
    "name": "Navy Wool Suit Jacket", "brand": "Sample Tailoring Co.", "color_name": "Navy", "color": "#1f2a4a",
    "fabric": "wool", "style": "tailored", "photo": "data:image/jpeg;base64,...",
    "source_url": "https://...", "garment": "jacket",
    "chart": {
      "unit": "in", "kind": "garment", "missing": [],
      "sizes": [{ "name": "40R", "chest": 113.03, "waist": 100.33, "shoulders": 45.72, "sleeve": 63.5, "length": 76.2 }]
    }
  }
}
```

Sizes are always in cm. `unit` is what the chart was written in. `kind` is `garment` when the chart gives the
jacket's own measurements, or `body` when it gives the body it's meant for (Fitroom then estimates the
jacket by adding regular-cut ease). `missing` lists measurements the chart doesn't give; those are `null`.

`fabric` is `wool`, `cotton`, `denim`, `leather` or `nylon`, from the listing's words (wool when it says
nothing). Jackets also have a `style`, for drawing the right one: `tailored` (blazers, suit and sport
jackets), `shirt` (button-front denim, trucker and work jackets), `bomber` or `zip`. `photo`, when the
shop has one, is its main product photo, fetched by the server.

Errors (`422`): `fetch_failed` (couldn't load the page, or it points to a private address), `no_size_chart`,
`not_supported` (not a jacket or blazer), `invalid`.

## POST /api/v1/fits

Like the chart fits below, but with the sizes in the request, such as an imported garment's
`chart.sizes`: `{ "unit": "in", "cut": "regular", "garment": "jacket", "measurements": {...}, "sizes": [...] }`.

- `garment` is `jacket` (default), `coat` or `trousers`. Jacket and coat sizes have `chest`, `waist`,
  `shoulders`, `sleeve`, `length`; trousers sizes have `waist`, `seat`, `thigh`, `inseam`, `leg_opening`.
  The first of those is required; the rest may be `null`, and their checks come back `unknown`.
- `measurements` needs `chest`, `waist`, `shoulders`, `arm` and `height`; `hips` and `inseam` are optional
  and used for trousers (without them, the seat and length checks say what to add).
- The response adds `warnings`: measurements outside the usual adult range, each with how to measure it again.
- Checks may carry a `note` instead of a fix, for things with no right answer: where a coat's hem falls,
  or what cut of leg a pair of trousers has.

## Studio photos

`POST /api/v1/studio_photos` with a snapshot of the stage:

```json
{
  "scale": 1.02,
  "body": { "measure-bust-circ-incr": 0.13, "measure-waist-circ-incr": 0.55 },
  "pose": "standing",
  "items": [{ "kind": "jacket", "style": "zip", "color": "#1f2a4a", "fabric": "leather", "ease": { "ease-chest": 2, "ease-length": 14 } }]
}
```

Add `"exact": true` and an item `photo` (a PNG, JPEG or WebP `data:` URL under 3 MB) to also get the exact
items painted on by AI try-on, when the server has a `FASHN_API_KEY`; the response says whether it will
(`exact`) and gives `exact_image_url`. Status then also reports `"exact": "pending" | "done" | "failed"`,
and `"styling"` while the try-on runs (the draped image can already be fetched then).

`body` keys are shape keys from `public/models/mannequin.json` (`targets`), weights 0–2; `ease` keys are
from its `ease_check`, in cm (−30 to 30); a jacket's `style` is one of the import's styles (default
`tailored`); `pose` is a key of `public/models/poses.json`. Responds `202` with
`{ id, status_url, image_url }`, `422` for anything unknown or out of range, or `503` if the server has no
Blender.

`GET /api/v1/studio_photos/:id` → `{ "status": "queued" | "rendering" | "done" | "failed", "ahead": 1 }`.

`GET /api/v1/studio_photos/:id/image` → the PNG (transparent background), once. After that, and for
renders nobody fetched within 10 minutes, it's gone.

## POST /api/v1/size_charts/:key/fits

Ranks the chart's sizes against a body. The measurements are used for this response only: nothing
stores them, they're filtered from the server log, and the response is sent with `Cache-Control: no-store`.

Request:

```json
{
  "unit": "in",
  "cut": "regular",
  "measurements": { "chest": 40, "waist": 34, "shoulders": 18, "arm": 25.75, "height": 70 }
}
```

`unit` is `cm` (default) or `in`. `cut` is a key from the fit guide (default `regular`).

Response (`200`), sizes best first:

```json
{
  "size_chart": { "key": "sample_suit_jacket", "name": "Sample suit jacket", "garment": "jacket", "source": "Made-up sample data" },
  "cut": "regular",
  "units": "cm",
  "best": "40R",
  "sizes": [
    {
      "size": "40R",
      "verdict": "alter",
      "penalty": 1.5,
      "checks": [
        { "part": "sleeve", "label": "Sleeves", "ease_cm": -3.0, "status": "short", "fixable": true,
          "fix": { "action": "lengthen_sleeves", "text": "Lengthen the sleeves", "amount_cm": 3.0 } }
      ]
    }
  ]
}
```

- `verdict`: `fits` (as it comes), `alter` (fits once a tailor makes the listed fixes) or `compromise`
  (something can't be fixed).
- `status`: `good`, `tight` or `loose` for shoulders, chest and waist; `good`, `short` or `long` for
  sleeves and length; `unknown` when the chart doesn't give that measurement.
- `ease_cm`: the garment minus the body. For sleeves and length, it's the difference from the ideal.
- `fix`: `null` when nothing needs changing, or when it can't be changed (`fixable` is false then).

Errors:

- `422` `{ "error": "invalid", "errors": { "height": "is required", "shoulders": "must be between 30 and 70 cm" } }`
- `404` `{ "error": "not_found", "message": "no size chart named ..." }`
