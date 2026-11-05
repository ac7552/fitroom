# Fitroom on a droplet

One server runs all of it, with no GPU anywhere: Rails serves the page and the JSON API, the visitor's browser
does the 3D work (the cloth solver in WebAssembly, lib/garments/cloth_kernel.js), the photo tools and models
come from the server itself, and HTTPS comes from Caddy. Nothing about a visitor is stored. A 2 vCPU / 4 GB
droplet (Ubuntu 24.04, Docker image from the DigitalOcean marketplace) is plenty for the page; studio photos
want a CPU-Optimized droplet with 8 vCPUs.

## First time

1. Make the droplet (Docker on Ubuntu). Point a domain's A record at it if you want HTTPS (`fit.example.com`).
2. On the droplet:

   ```sh
   git clone https://github.com/<you>/fitroom.git && cd fitroom/deploy
   cp .env.example .env
   sed -i "s/^SECRET_KEY_BASE=.*/SECRET_KEY_BASE=$(openssl rand -hex 64)/" .env
   sed -i "s/^FITROOM_HOST=.*/FITROOM_HOST=fit.example.com/" .env   # or leave empty for plain HTTP
   docker compose up -d --build
   ```

   The first build takes a few minutes (gems, assets). Then open `https://fit.example.com` (or
   `http://<droplet ip>`).

3. Leave the AI try-on off: it needs a GPU (`FITROOM_TRYON_*` and `FASHN_API_KEY` unset, so its button
   doesn't show). The photo re-drape lays the shop's own photos on the cloth without it.

The build also fetches the page's photo tools (transformers.js and ONNX Runtime's WebAssembly, MediaPipe, the
pose model and the two photo models, about 100 MB) into `public/vendor/` (the Dockerfile's vendor stage,
`script/vendor/fetch.mjs`), so a visitor's browser loads them from the droplet rather than CDNs
(`lib/hosted.js`); what the build couldn't fetch, the page takes from the CDN as before.

## Studio photos (optional, CPU)

`FITROOM_STUDIO=1` in `.env` builds Blender into the web image and renders **Take a photo** for the suit's
jacket, coats and trousers with Cycles on the droplet's CPU. Put MPFB and MakeHuman's asset pack in
`deploy/studio/` first (its README says which files), then `docker compose up -d --build`. Not yet tried on
a real droplet: the first build is the test.

## The drape atlas

The drape bank (`public/drapes/`) starts a garment from a drape of its style near its size instead of
from scratch. `script/bank/atlas.mjs` fills it with no shop links: every draped style on both example
bodies at three sizes a quarter apart, headless. Run it after a change to the drape, then rebuild:

```sh
cd fitroom/deploy
docker compose --profile tools run --rm tools sh -c \
  "python3 script/headless/serve.py 8787 & sleep 2; node script/bank/atlas.mjs --force"
docker compose up -d --build
```

## Checking accuracy every night

`script/validation/nightly.mjs` runs the accuracy set (the 34 labelled listings) in headless Chromium against
the web container and holds it to `script/validation/baseline.json`, writing `tmp/validation/<date>.json`.
From the droplet's crontab (`crontab -e`), at 3:17 every night:

```cron
17 3 * * * bash -c 'cd /root/fitroom && mkdir -p public/validation && cp script/validation/{runner.js,sheet.js,runs.json,accuracy.js,accuracy.json,baseline.json} public/validation/ && cd deploy && docker compose --profile tools run --rm tools node script/validation/nightly.mjs --base http://web:3000' >> /var/log/fitroom-accuracy.log 2>&1
```

(`public/validation/` must be served, which only the development server does; for the nightly run, start the
web container with `RAILS_ENV=development` or run it on a laptop's `bin/dev`.)

## Garment details from the photo (optional)

The vision service can also say what a photo shows (a hood, sleeve length, a collar, the length, a zip or
buttons) with a vision-language model, for the importer to check its reading of the listing against. It's
off unless the service starts with `DETAILS_MODEL=Xenova/siglip-base-patch16-224` (about 400 MB more to
fetch); `script/server/eval_details.mjs` scores its answers against a sample before trusting them. The
importer doesn't use the answers yet: measure first.

## Keeping skin and backdrop off the cloth (optional)

With `FITROOM_PARSE_MODEL=Xenova/segformer_b2_clothes` in `.env`, the vision service also runs a
clothes-parsing model (`POST /parse`), and the page takes what it reads as skin, hair, face or backdrop off
a shop photo's cloth mask before the photo is laid on the cloth: the accuracy set's "foreign" check, which
half its listings fail. It only ever takes pixels off, and not when it would take more than a third (a model
trained on people can misread a garment laid flat). Not yet measured: run the accuracy set with it on and
off before keeping it (the model's license is the model card's, check it for your use).

## Updating

```sh
cd fitroom && git pull && cd deploy && docker compose up -d --build
```

## Checking

- `docker compose ps` shows `web` healthy (it answers `/up`).
- `docker compose logs -f web` for the Rails log; measurements and body shapes are filtered out of it.
- `docker compose logs -f vision` says when its models are loaded (the first start downloads about 40 MB
  from the Hugging Face hub into the `models` volume; later starts read them from there).
- The demo browser needs WebGL 2 (any current Chrome, Safari or Firefox). The store photos' AI models load
  from a public CDN into the visitor's browser the first time (about 40 MB, cached after).

## What runs where

| Part | Where | Notes |
| --- | --- | --- |
| Page, fit maths, link import, size charts | the droplet (Rails) | `Dockerfile`, `deploy/docker-compose.yml` |
| Cloth drape, store-photo reading, look check | the visitor's browser | nothing of theirs leaves it |
| Store photos' AI models (SlimSAM, DINOv2) | the droplet (`vision` service, CPU) | `script/server/vision.mjs`; the page falls back to its own copies (from the droplet's `/vendor`) if it's down |
| The page's photo tools and models | the droplet (`public/vendor`) | fetched at build; `lib/hosted.js` |
| Drape atlas, nightly accuracy run | the droplet (`tools`, by hand or cron) | `script/bank/atlas.mjs`, `script/validation/nightly.mjs` |
| Studio photos (Blender, Cycles on the CPU) | the droplet, with `FITROOM_STUDIO=1` | `deploy/studio/README.md` |
| AI try-on | off (it needs a GPU) | |
