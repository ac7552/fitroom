# Studio photos on the droplet

With `FITROOM_STUDIO=1` in `deploy/.env`, the Docker image is built with Blender (Linux, CPU only), so
**Take a photo** for the suit's jacket, coats and trousers renders on the droplet with Cycles on its CPU.
Blender can't fetch MakeHuman's add-on and assets itself during the build, so put them here first, the same
two files the Mac's build uses:

- `mpfb.zip`: the MPFB extension (extensions.blender.org, "MPFB"), for the Blender version in the
  Dockerfile's `BLENDER_VERSION`.
- `makehuman_system_assets.zip`: MakeHuman's CC0 system asset pack (static.makehumancommunity.org).

Then `docker compose up -d --build`. A render on a droplet's CPU takes longer than on a Mac (about 30 s on an
M2); `FITROOM_STUDIO_TIMEOUT` (seconds, default 240) is how long one may take before it's given up. A
CPU-Optimized droplet with 8 vCPUs is the right size for it.

Not yet tried on a droplet: the Blender download URL and the MPFB install step are written from Blender's
and MPFB's documented layout, and need one real build to confirm.
