# Fitroom on a droplet

One small server runs the whole demo: Rails serves the page and the JSON API, the visitor's browser does the
3D work, and HTTPS comes from Caddy. Nothing about a visitor is stored. A 2 vCPU / 4 GB droplet (Ubuntu
24.04, Docker image from the DigitalOcean marketplace) is plenty.

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

3. The AI try-on button appears once the three `FITROOM_TRYON_*` values are in `.env` (see the repo's
   `.env.example`); `docker compose up -d` again after changing `.env`.

## Garment details from the photo (optional)

The vision service can also say what a photo shows (a hood, sleeve length, a collar, the length, a zip or
buttons) with a vision-language model, for the importer to check its reading of the listing against. It's
off unless the service starts with `DETAILS_MODEL=Xenova/siglip-base-patch16-224` (about 400 MB more to
fetch); `script/server/eval_details.mjs` scores its answers against a sample before trusting them. The
importer doesn't use the answers yet: measure first.

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
| Store photos' AI models (SlimSAM, DINOv2) | the droplet (`vision` service) | `script/server/vision.mjs`; the page falls back to its own copies if it's down |
| AI try-on | Modal (GPU), from the droplet | optional; `FITROOM_TRYON_*` |
| Studio photos (Blender) | not on the droplet | the button says they aren't available |
