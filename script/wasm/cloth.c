// The cloth solver's inner loops (lib/garments/drape.js), as WebAssembly: the same arithmetic in the same
// order as the JavaScript (doubles while working, the cloth's points kept as floats), so a drape comes out
// the same either way, about twice as fast. Freestanding C, no library: built by script/wasm/build.sh into
// lib/garments/cloth_wasm.js. Each function works on arrays the page has laid out in the module's memory
// (lib/garments/cloth_kernel.js); pointers are byte offsets into it.
typedef unsigned char u8;
typedef signed char i8;
#define EXPORT(name) __attribute__((export_name(#name)))
static inline double sq(double v) { return __builtin_sqrt(v); }
static inline double fl(double v) { return __builtin_floor(v); }

// Each point moves on by its speed, gravity added (Drape#step's first loop).
EXPORT(predict) void predict(const float *x, float *v, float *p, int n, double h, double fall) {
  for (int i = 0; i < n; i++) {
    if (fall != 0.0) v[3 * i + 1] = (float)(v[3 * i + 1] + fall);
    p[3 * i] = (float)(x[3 * i] + (double)v[3 * i] * h);
    p[3 * i + 1] = (float)(x[3 * i + 1] + (double)v[3 * i + 1] * h);
    p[3 * i + 2] = (float)(x[3 * i + 2] + (double)v[3 * i + 2] * h);
  }
}

// One pass over distance constraints (drape.js's solveDistances).
EXPORT(solve) void solve(float *p, const float *w, const int *pairs, const float *rest, int count, double compliance, double ribCompliance, const u8 *rib, double squeeze) {
  for (int e = 0; e < count; e++) {
    const int ia = pairs[2 * e], ib = pairs[2 * e + 1];
    const int a = 3 * ia, b = 3 * ib;
    const double dx = (double)p[a] - p[b], dy = (double)p[a + 1] - p[b + 1], dz = (double)p[a + 2] - p[b + 2];
    const double d = sq(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) continue;
    const double wa = w[ia], wb = w[ib];
    const double r = rest[e];
    const double alpha = ((rib && rib[e]) ? ribCompliance : compliance) * (d < r ? squeeze : 1.0);
    const double lambda = -(d - r) / (wa + wb + alpha);
    const double sx = (dx / d) * lambda, sy = (dy / d) * lambda, sz = (dz / d) * lambda;
    p[a] = (float)(p[a] + sx * wa); p[a + 1] = (float)(p[a + 1] + sy * wa); p[a + 2] = (float)(p[a + 2] + sz * wa);
    p[b] = (float)(p[b] - sx * wb); p[b + 1] = (float)(p[b + 1] - sy * wb); p[b + 2] = (float)(p[b + 2] - sz * wb);
  }
}

// The speeds from how far each point moved, and the points moved (Drape#step's last loop).
EXPORT(finish) void finish(float *x, float *v, const float *p, int n3, double h, double drag, int still) {
  for (int i = 0; i < n3; i++) {
    v[i] = still ? 0.0f : (float)((((double)p[i] - x[i]) / h) * drag);
    x[i] = p[i];
  }
}

// Cloth through itself (Drape#selfCollide): a hashed grid of `size` buckets (a power of two) finds the points
// within `radius`; those not within two steps along the cloth (neighbourStart, neighbours) push apart.
// (Multiplied as unsigned, wrapping as JavaScript's ^ does: the same buckets, so the same pairs in the same order.)
static inline int hashKey(int ix, int iy, int iz, int mask) { return (int)((((unsigned)ix * 73856093u) ^ ((unsigned)iy * 19349663u) ^ ((unsigned)iz * 83492791u)) & (unsigned)mask); }
EXPORT(self_collide) void self_collide(float *p, int n, double radius, int *head, int size, int *next, const int *start, const int *nb) {
  const double cell = radius;
  const int mask = size - 1;
  for (int k = 0; k < size; k++) head[k] = -1;
  for (int i = 0; i < n; i++) {
    const int k = hashKey((int)fl(p[3 * i] / cell), (int)fl(p[3 * i + 1] / cell), (int)fl(p[3 * i + 2] / cell), mask);
    next[i] = head[k];
    head[k] = i;
  }
  const double r2 = radius * radius;
  for (int i = 0; i < n; i++) {
    const int ix = (int)fl(p[3 * i] / cell), iy = (int)fl(p[3 * i + 1] / cell), iz = (int)fl(p[3 * i + 2] / cell);
    for (int ox = -1; ox <= 1; ox++) for (int oy = -1; oy <= 1; oy++) for (int oz = -1; oz <= 1; oz++) {
      for (int j = head[hashKey(ix + ox, iy + oy, iz + oz, mask)]; j >= 0; j = next[j]) {
        if (j <= i) continue;
        const double dx = (double)p[3 * j] - p[3 * i], dy = (double)p[3 * j + 1] - p[3 * i + 1], dz = (double)p[3 * j + 2] - p[3 * i + 2];
        const double d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2 || d2 < 1e-14) continue;
        int adjacent = 0;
        for (int k = start[i]; k < start[i + 1]; k++) if (nb[k] == j) { adjacent = 1; break; }
        if (adjacent) continue;
        const double d = sq(d2), push = ((radius - d) / d) * 0.5;
        p[3 * i] = (float)(p[3 * i] - dx * push); p[3 * i + 1] = (float)(p[3 * i + 1] - dy * push); p[3 * i + 2] = (float)(p[3 * i + 2] - dz * push);
        p[3 * j] = (float)(p[3 * j] + dx * push); p[3 * j + 1] = (float)(p[3 * j + 1] + dy * push); p[3 * j + 2] = (float)(p[3 * j + 2] + dz * push);
      }
    }
  }
}

// The skin's distance field at a point (body.js's SkinField#grid): trilinear in the grid, the normal blended
// the same way; `band` off it. The normal goes into hit[0..2].
// (The normal kept as floats, as SkinField#hit is a Float32Array: the same rounding as the page's.)
static double gridAt(double x, double y, double z, const float *D, const i8 *M, const int *dims, const double *frame, float *hit) {
  const double minx = frame[0], miny = frame[1], minz = frame[2], cell = frame[3], band = frame[4];
  const double fx = (x - minx) / cell, fy = (y - miny) / cell, fz = (z - minz) / cell;
  const double flx = fl(fx), fly = fl(fy), flz = fl(fz);
  const int nx = dims[0], ny = dims[1], nz = dims[2];
  if (flx < 0 || fly < 0 || flz < 0 || flx >= nx - 1 || fly >= ny - 1 || flz >= nz - 1) return band;
  const int ix = (int)flx, iy = (int)fly, iz = (int)flz;
  const double u = fx - ix, v = fy - iy, w = fz - iz;
  const int g = (iz * ny + iy) * nx + ix, row = nx, layer = nx * ny;
  double d = 0, mx = 0, my = 0, mz = 0;
  for (int k = 0; k < 8; k++) {
    const int ox = k & 1, oy = (k >> 1) & 1, oz = k >> 2;
    const double weight = (ox ? u : 1 - u) * (oy ? v : 1 - v) * (oz ? w : 1 - w);
    const int j = g + ox + oy * row + oz * layer;
    d += D[j] * weight;
    mx += M[3 * j] * weight; my += M[3 * j + 1] * weight; mz += M[3 * j + 2] * weight;
  }
  const double l = sq(mx * mx + my * my + mz * mz);
  if (l < 1e-3) return band;
  hit[0] = (float)(mx / l); hit[1] = (float)(my / l); hit[2] = (float)(mz / l);
  return d;
}

// And the ellipsoids added to the field (SkinField#at): each [centre x, y, z, radii x, y, z]; the nearest of
// them and the grid answers.
static double fieldAt(double x, double y, double z, const float *D, const i8 *M, const int *dims, const double *frame, const double *ell, int ells, float *hit) {
  double best = gridAt(x, y, z, D, M, dims, frame, hit);
  for (int k = 0; k < ells; k++) {
    const double *e = ell + 6 * k;
    const double px = (x - e[0]) / e[3], py = (y - e[1]) / e[4], pz = (z - e[2]) / e[5];
    const double k0 = sq(px * px + py * py + pz * pz);
    const double gx = px / e[3], gy = py / e[4], gz = pz / e[5];
    const double k1 = sq(gx * gx + gy * gy + gz * gz);
    if (k1 < 1e-9) continue;
    const double distance = (k0 * (k0 - 1)) / k1;
    if (distance < best) {
      best = distance;
      hit[0] = (float)(gx / k1); hit[1] = (float)(gy / k1); hit[2] = (float)(gz / k1);
    }
  }
  return best;
}

// Points inside the skin, or nearer than the cloth's thickness, out along its normal, with friction
// (Drape#collide's first loop, for cloth not tucked in). clear: how far each point may move before it's
// looked up again. frame: [min x, y, z, cell, band].
EXPORT(collide_skin) void collide_skin(float *p, const float *x, float *clear, int n, double thick, double keep, double margin, const float *D, const i8 *M, const int *dims, const double *frame, const double *ell, int ells) {
  float hit[3] = { 0, 1, 0 };
  for (int i = 0; i < n; i++) {
    const double px = p[3 * i], py = p[3 * i + 1], pz = p[3 * i + 2];
    const double mx0 = px - x[3 * i], my0 = py - x[3 * i + 1], mz0 = pz - x[3 * i + 2];
    const double moved = sq(mx0 * mx0 + my0 * my0 + mz0 * mz0);
    if (clear[i] > moved) { clear[i] = (float)(clear[i] - moved); continue; }
    const double d = fieldAt(px, py, pz, D, M, dims, frame, ell, ells, hit);
    clear[i] = (float)(d > thick ? (d - thick) * margin : 0.0);
    if (d >= thick) continue;
    const double nx = hit[0], ny = hit[1], nz = hit[2];
    const double push = thick - d;
    double qx = px + nx * push, qy = py + ny * push, qz = pz + nz * push;
    const double mx = qx - x[3 * i], my = qy - x[3 * i + 1], mz = qz - x[3 * i + 2];
    const double normal = mx * nx + my * ny + mz * nz;
    const double tx = mx - normal * nx, ty = my - normal * ny, tz = mz - normal * nz;
    qx -= tx * (1 - keep); qy -= ty * (1 - keep); qz -= tz * (1 - keep);
    p[3 * i] = (float)qx; p[3 * i + 1] = (float)qy; p[3 * i + 2] = (float)qz;
  }
}

// Where the page's arrays may start (past the module's own data).
extern unsigned char __heap_base;
EXPORT(heap_base) int heap_base(void) { return (int)(unsigned long)&__heap_base; }
