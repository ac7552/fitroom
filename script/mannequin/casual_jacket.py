# Fitroom's casual jacket: the zip-front jackets, bombers and button-front denim or work jackets that most
# outerwear is, which MakeHuman's wardrobe doesn't have. It's made from the mannequin's own body (its
# torso and arms), so it carries the same rig weights and measurement shape keys and follows any body:
#
#   1. Cut the torso from the neckline to the hips and the arms to the wrists out of the body.
#   2. Hang the hem straight down to jacket length and run the sleeves past the wrist.
#   3. Stand it off the body, smooth away muscle and bone, and let it hang straight below the chest and
#      fall in a soft tube along the arms, the way cloth does, then make sure nothing sits inside the body.
#   4. Add a collar: a band that every style has, a taller stand (zip jackets and bombers) and a turned-down
#      point collar (shirt-style jackets), as separate pieces so a style can show only its own.
#
# Its texture coordinates are laid out in metres (the front and back as seen head on, each sleeve unrolled),
# so details (zips, plackets, buttons, yokes, pockets, rib knit, stitching) can be painted by position.
# See paint_casual_details.
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from fitroom_model import (ARM_GROUPS, NAVEL, JacketGauge, delete_vertices, face_outward, group_weights,
                           hull_perimeter, local_coords, log, slab, to_world)

LENGTH = 0.80        # back length as built, from the collar seam; each size is cut to its own length
WAISTBAND = 0.045    # a trucker's waistband
SHORTEST = 0.5       # the shortest length the page cuts it to
GAP = 0.016          # how far the cloth stands off the body before it's smoothed
MIN_GAP = 0.014      # and the least it ends up off the body anywhere (clear of the studio's collisions)
PAST_WRIST = 0.017   # the sleeve covers the wrist bone, as the suit jacket's does
HIP_ROOM = 0.07      # below this height above the crotch, the hem hangs straight instead of following the legs
SLEEVE_TOP, SLEEVE_CUFF = 0.057, 0.044   # the sleeve's least radius at the shoulder and at the cuff
STAND, UPPER_STAND = 0.025, 0.03         # collar heights
UV_METRES = 1.5      # one texture width covers this many metres
UV_SLEEVE_RADIUS = 0.055
NECK_ARC = np.pi * 0.075   # half the way round the collar, in metres
PARTS = {"torso": 0, "left sleeve": 1, "right sleeve": 2, "band": 3, "stand": 4, "point collar": 5}
STYLES = ("zip", "bomber", "shirt")
# Which collar pieces each style wears (the band is always there).
COLLARS = {"zip": PARTS["stand"], "bomber": PARTS["stand"], "shirt": PARTS["point collar"]}


def edges_of(mesh):
    flat = np.empty(len(mesh.edges) * 2, dtype=np.int64)
    mesh.edges.foreach_get("vertices", flat)
    return flat.reshape(-1, 2)


def smooth(coords, edges, movable, iterations, lam=0.5, mu=-0.53):
    """Taubin smoothing: takes out bumps (muscles, bones) without shrinking the shape."""
    n = len(coords)
    degree = np.zeros(n)
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    degree = np.maximum(degree, 1)[:, None]
    movable = np.asarray(movable, dtype=float)[:, None]

    def step(x, factor):
        total = np.zeros_like(x)
        np.add.at(total, edges[:, 0], x[edges[:, 1]])
        np.add.at(total, edges[:, 1], x[edges[:, 0]])
        return x + factor * (total / degree - x) * movable

    for _ in range(iterations):
        coords = step(step(coords, lam), mu)
    return coords


def vertex_normals(coords, faces):
    normals = np.zeros_like(coords)
    for face in faces:
        a, b, c = coords[face[0]], coords[face[1]], coords[face[2]]
        n = np.cross(b - a, c - a)
        if len(face) == 4:
            n += np.cross(c - a, coords[face[3]] - a)
        normals[face] += n
    return normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


class CasualJacket:
    """Builds the casual jacket from `body` (which may carry measurement shape keys; the jacket gets them
    too). Its sleeves end PAST_WRIST beyond the wrist joint."""

    def __init__(self, body, gauge):
        self.body, self.gauge = body, gauge
        coords = to_world(body, local_coords(body))
        self.body_world = coords
        self.floor, self.height = gauge.levels(coords)
        neck = gauge.joint(coords, "joint-neck")
        self.neck = neck
        self.back_neck = neck[2] - 0.005
        self.hem = self.back_neck - LENGTH
        crotch = self.floor + gauge.measure(coords)["inseam"] / 100
        self.cut = max(self.hem, crotch + HIP_ROOM)
        self.chest_z = max(np.linspace(self.floor + 0.68 * self.height, self.floor + 0.76 * self.height, 17),
                           key=lambda h: hull_perimeter(slab(coords, gauge.torso, h)))
        self.waist_z = self.floor + NAVEL * self.height
        self.arms = {}
        for side, sign in (("l", 1), ("r", -1)):
            s, w = gauge.joint(coords, f"joint-{side}-shoulder"), gauge.joint(coords, f"joint-{side}-hand")
            self.arms[sign] = (s, (w - s) / np.linalg.norm(w - s), np.linalg.norm(w - s))
        # Along the arm from the shoulder joint (the sleeve, measured from the shoulder seam, is ACROMION more).
        self.sleeve_end = np.mean([reach for _, _, reach in self.arms.values()]) + PAST_WRIST

    def body_cover(self):
        """Body vertices the jacket surely covers, even cut shorter or with shorter sleeves, so the page
        can hide them (it's on the body's own vertices, before its helpers are deleted)."""
        coords = self.body_world
        sure = self.covers & (coords[:, 2] > self.back_neck - SHORTEST)
        arm = group_weights(self.body, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        side = np.sign(coords[:, 0])
        for sign in (1, -1):
            mine = arm & (side == sign)
            sure[mine] = self.covers[mine] & (self.along_arm(coords[mine], sign) < self.sleeve_end - 0.12)
        return sure

    def finish(self):
        """Swap the build's bookkeeping for what the page reads: _collar is 1 on the stand and 2 on the
        point collar, so each style can hide the other's."""
        mesh = self.obj.data
        piece = attribute(mesh, "_piece")
        collar = np.where(piece == PARTS["stand"], 1.0, np.where(piece == PARTS["point collar"], 2.0, 0.0))
        drop = self.drops()
        for name in ("_piece", "_step"):
            mesh.attributes.remove(mesh.attributes[name])
        for name, values in (("_collar", collar), ("_drop", drop)):
            layer = mesh.attributes.new(name=name, type="FLOAT", domain="POINT")
            layer.data.foreach_set("value", values.astype(np.float32))
        for poly in mesh.polygons:
            poly.use_smooth = True

    def drops(self):
        """How far below the collar seam at the back each vertex of the body of the jacket is (0 on the
        sleeves and collar), for cutting it to length."""
        coords = to_world(self.obj, local_coords(self.obj))
        arm = group_weights(self.obj, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        torso = (attribute(self.obj.data, "_piece") == PARTS["torso"]) & ~arm
        return np.where(torso, np.maximum(0.0, self.back_neck - coords[:, 2]), 0.0)

    def cut_to(self, length):
        """Cut the body of the jacket level at `length` (metres below the collar seam at the back). For a
        mesh without shape keys (the studio's); the page cuts in its shader instead."""
        torso = self.drops() > 0
        bm = bmesh.new()
        bm.from_mesh(self.obj.data)
        bm.verts.ensure_lookup_table()
        faces = [f for f in bm.faces if any(torso[v.index] for v in f.verts)]
        geom = list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, self.back_neck - length), plane_no=(0, 0, 1),
                               clear_inner=True)
        bm.to_mesh(self.obj.data)
        bm.free()
        self.obj.data.update()

    def front_neckline(self):
        """The collar seam's height across the front, as a function of x."""
        coords = to_world(self.obj, local_coords(self.obj))
        piece, step = attribute(self.obj.data, "_piece"), attribute(self.obj.data, "_step")
        seam = (piece == PARTS["band"]) & (step == 0) & (coords[:, 1] < self.layout.centre_y)
        x, z = coords[seam, 0], coords[seam, 2]
        order = np.argsort(x)
        return lambda at: float(np.interp(at, x[order], z[order]))

    def neckline(self, coords):
        """The collar seam: at the base of the neck behind, dipping about 5 cm at the front."""
        front = np.clip((self.neck[1] - coords[:, 1]) / 0.08, 0, 1)   # Blender's front is -Y
        return self.back_neck - 0.055 * front

    def along_arm(self, coords, sign):
        s, axis, _ = self.arms[sign]
        return (coords - s) @ axis

    def build(self, name="casual"):
        body, coords = self.body, self.body_world
        skin = self.gauge.skin
        arm = group_weights(body, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        hand = group_weights(body, lambda n: n.startswith(ARM_GROUPS[2:])) > 0.3
        legs = group_weights(body, lambda n: n.startswith(("thigh_", "calf_", "foot_", "ball_"))) > 0.5
        side = np.sign(coords[:, 0])
        wrist_cut = np.zeros(len(coords), dtype=bool)
        for sign, (_, _, reach) in self.arms.items():
            wrist_cut |= (side == sign) & (self.along_arm(coords, sign) > reach - 0.025)
        torso = skin & ~arm & ~legs & (coords[:, 2] < self.neckline(coords)) & (coords[:, 2] >= self.cut)
        sleeves = skin & arm & ~hand & ~wrist_cut
        keep = torso | sleeves
        # Remember which body vertices the jacket covers, for hiding the body under it.
        self.covers = keep.copy()

        obj = body.copy()
        obj.data = body.data.copy()
        obj.name = obj.data.name = name
        bpy.context.collection.objects.link(obj)
        for modifier in [m for m in obj.modifiers if m.type == "MASK"]:
            obj.modifiers.remove(modifier)
        for attribute in [a.name for a in obj.data.attributes if a.name.startswith("_")]:
            obj.data.attributes.remove(obj.data.attributes[attribute])
        obj.active_shape_key_index = 0
        delete_vertices(obj, ~keep)
        drop_islands(obj)
        self.obj = obj

        self.extend_hem_and_cuffs()
        self.stand_off()
        self.add_collars()
        self.layout = Layout(self)
        lay_out_texture(self)
        log("casual jacket", len(obj.data.vertices), "vertices")
        return obj

    # Building

    def boundary_loops(self, bm):
        """Open edges of the cut, grouped into loops: the neckline, the hem and two cuffs."""
        edges = [e for e in bm.edges if e.is_boundary]
        seen, loops = set(), []
        for start in edges:
            if start in seen:
                continue
            loop, stack = [], [start]
            while stack:
                e = stack.pop()
                if e in seen:
                    continue
                seen.add(e)
                loop.append(e)
                for v in e.verts:
                    stack.extend(x for x in v.link_edges if x.is_boundary and x not in seen)
            loops.append(loop)
        named = {}
        for loop in loops:
            pts = np.array([v.co for e in loop for v in e.verts])
            centre = pts.mean(axis=0)
            if len(loop) < 12:
                continue
            if abs(centre[0]) > 0.25:
                named["cuff", int(np.sign(centre[0]))] = loop
            elif centre[2] > self.chest_z:
                named["neck"] = loop
            else:
                named["hem"] = loop
        return named

    def extrude(self, bm, edges, place, steps):
        """Extrude open `edges` `steps` times; place(source, step, coord) gives each new vertex's position.
        Every shape key moves the new vertices by the same amount as the basis. Returns the last ring's
        open edges and the new vertices, ring by ring."""
        shapes = list(bm.verts.layers.shape.values())
        added = []
        for step in range(1, steps + 1):
            result = bmesh.ops.extrude_edge_only(bm, edges=edges)
            new_verts = {g for g in result["geom"] if isinstance(g, bmesh.types.BMVert)}
            for v in new_verts:
                source = next(e.other_vert(v) for e in v.link_edges if e.other_vert(v) not in new_verts)
                target = Vector(place(source, step, np.array(source.co)))
                offset = target - source.co
                v.co = target
                for layer in shapes:
                    v[layer] = source[layer] + offset
            edges = [g for g in result["geom"] if isinstance(g, bmesh.types.BMEdge) and all(v in new_verts for v in g.verts)]
            added.append(list(new_verts))
        return edges, added

    def extend_hem_and_cuffs(self):
        bm = bmesh.new()
        bm.from_mesh(self.obj.data)
        loops = self.boundary_loops(bm)
        log("cut loops", {k: len(v) for k, v in loops.items()})
        drop = self.cut - self.hem
        if drop > 0.005:
            rings = max(2, math.ceil(drop / 0.02))   # close enough together to cut anywhere
            self.extrude(bm, loops["hem"], lambda v, step, co: (co[0], co[1], self.cut - drop * step / rings), rings)
        for sign in (1, -1):
            s, axis, reach = self.arms[sign]

            def onward(v, step, co, s=s, axis=axis):
                past = self.sleeve_end - (co - s) @ axis
                return co + axis * past * (step / 2)
            self.extrude(bm, loops["cuff", sign], onward, 2)
        bm.to_mesh(self.obj.data)
        bm.free()
        self.obj.data.update()

    def stand_off(self):
        """Move the cut-out skin into cloth: off the body, smoothed, hanging straight from the chest down
        and in soft tubes along the arms. Every shape key moves by the same amount as the basis."""
        mesh = self.obj.data
        coords = local_coords(self.obj)
        faces = [list(p.vertices) for p in mesh.polygons]
        edges = edges_of(mesh)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        rim = np.array([v.is_boundary for v in bm.verts])
        rim_edges = np.array([[e.verts[0].index, e.verts[1].index] for e in bm.edges if e.is_boundary])
        bm.free()
        arm = group_weights(self.obj, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        sign = np.sign(coords[:, 0])

        shell = coords + vertex_normals(coords, faces) * GAP
        shell = smooth(shell, edges, ~rim, 40)
        shell = smooth(shell, rim_edges, rim, 15)

        # Cloth bridges hollows (the spine, the breastbone, the navel) rather than following them in.
        shell = bridge_hollows(shell, ~arm & ~rim)
        shell = smooth(shell, edges, ~rim, 10)

        # Below the chest, the cloth hangs straight down from it instead of following the waist in.
        torso = ~arm
        ring = torso & (np.abs(shell[:, 2] - self.chest_z) < 0.012)
        cy = shell[ring, 1].mean()
        theta = np.arctan2(shell[:, 0], -(shell[:, 1] - cy))
        radius = np.hypot(shell[:, 0], shell[:, 1] - cy)
        order = np.argsort(theta[ring])
        chest_radius = np.interp(theta, theta[ring][order], radius[ring][order], period=2 * np.pi)
        blend = smoothstep((self.chest_z - shell[:, 2]) / 0.12) * torso
        grown = radius + np.maximum(0, chest_radius * 0.985 - radius) * blend
        shell[:, 0] = np.sin(theta) * grown
        shell[:, 1] = cy - np.cos(theta) * grown

        # Sleeves fall in a soft tube, narrowing to the cuff.
        for s_sign, (s, axis, _) in self.arms.items():
            mine = arm & (sign == s_sign)
            along = (shell[mine] - s) @ axis
            t = np.clip(along / self.sleeve_end, 0, 1)
            centre = s + np.outer(along, axis)
            out = shell[mine] - centre
            r = np.linalg.norm(out, axis=1)
            least = SLEEVE_TOP + (SLEEVE_CUFF - SLEEVE_TOP) * t
            ramp = smoothstep((along - 0.03) / 0.1)
            r_new = r + np.maximum(0, least - r) * ramp
            shell[mine] = centre + out / np.maximum(r, 1e-6)[:, None] * r_new[:, None]

        shell = bridge_hollows(shell, ~arm & ~rim)
        # Sleeves lose their muscles more slowly than the torso its shape, so they get longer.
        shell = smooth(shell, edges, ~rim, 20)
        shell = smooth(shell, edges, arm & ~rim, 40)
        shell = self.clear_of_body(shell, MIN_GAP)
        shell = self.square_ends(shell, rim, arm, sign)
        self.move(shell - coords)

    def clear_of_body(self, shell, gap, only=None):
        skin = self.gauge.skin
        polys = [list(p.vertices) for p in self.body.data.polygons if all(skin[i] for i in p.vertices)]
        tree = BVHTree.FromPolygons([Vector(c) for c in self.body_world], polys)
        moved = 0
        for i, point in enumerate(shell):
            if only is not None and not only[i]:
                continue
            found = tree.find_nearest(Vector(point))
            if found[0] is None:
                continue
            location, normal = np.array(found[0]), np.array(found[1])
            if (point - location) @ normal < gap:
                shell[i] = location + normal * gap
                moved += 1
        log("pushed clear of the body", moved)
        return shell

    def square_ends(self, shell, rim, arm, sign):
        """A level hem and cuffs square to the arm."""
        hem = rim & ~arm & (shell[:, 2] < self.chest_z)
        shell[hem, 2] = self.hem
        for s_sign, (s, axis, _) in self.arms.items():
            cuff = rim & arm & (sign == s_sign)
            along = (shell[cuff] - s) @ axis
            shell[cuff] += np.outer(self.sleeve_end - along, axis)
        return shell

    def move(self, displacement):
        """Move the basis and every shape key by `displacement` (world metres)."""
        mesh = self.obj.data
        to_local = np.array(self.obj.matrix_world.inverted())[:3, :3]
        local = displacement @ to_local.T
        for block in mesh.shape_keys.key_blocks if mesh.shape_keys else ():
            flat = np.empty(len(block.data) * 3)
            block.data.foreach_get("co", flat)
            block.data.foreach_set("co", (flat.reshape(-1, 3) + local).astype(np.float32).ravel())
        flat = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", flat)
        mesh.vertices.foreach_set("co", (flat.reshape(-1, 3) + local).astype(np.float32).ravel())
        mesh.update()

    def add_collars(self):
        bm = bmesh.new()
        bm.from_mesh(self.obj.data)
        loops = self.boundary_loops(bm)
        neck_axis = np.array([0.0, self.neck[1]])

        def inward(co, amount):
            flat = co[:2] - neck_axis
            return -flat / max(np.linalg.norm(flat), 1e-6) * amount

        piece = bm.verts.layers.int.new("_piece")
        step_of = bm.verts.layers.int.new("_step")   # rings out from the collar seam, for texture coordinates

        band_top, band = self.extrude(bm, loops["neck"], lambda v, step, co: co + np.r_[inward(co, 0.003), STAND / 2], 2)
        for step, ring in enumerate(band, 1):
            for v in ring:
                v[piece], v[step_of] = PARTS["band"], step
        for e in loops["neck"]:
            for v in e.verts:
                v[piece] = PARTS["band"]

        # The stand and the point collar start from copies of the band's top edge, as pieces of their own.
        stand_edges, stand_start = self.copy_edges(bm, band_top)
        _, stand = self.extrude(bm, stand_edges, lambda v, step, co: co + np.r_[inward(co, 0.002), UPPER_STAND / 2], 2)
        for step, ring in enumerate([stand_start, *stand]):
            for v in ring:
                v[piece], v[step_of] = PARTS["stand"], 2 + step

        fall_edges, fall_start = self.copy_edges(bm, band_top)

        def fall(v, step, co):
            flat = co[:2] - neck_axis
            out = flat / max(np.linalg.norm(flat), 1e-6)
            if step == 1:   # over the fold
                return co + np.r_[out * 0.008, 0.006]
            # Down onto the shoulders, longest at the two points either side of the front.
            angle = abs(math.atan2(co[0], -(co[1] - self.neck[1])))   # 0 at the front
            point = 0.032 * math.exp(-((angle - 0.42) / 0.2) ** 2) - 0.02 * math.exp(-(angle / 0.12) ** 2)
            fold = 0.006 if step == 2 else 0
            return co + np.r_[out * (0.012 + point * 0.4) / 4, -(0.024 + point) / 4 - fold]
        _, falling = self.extrude(bm, fall_edges, fall, 5)
        for step, ring in enumerate([fall_start, *falling]):
            for v in ring:
                v[piece], v[step_of] = PARTS["point collar"], step

        bm.to_mesh(self.obj.data)
        bm.free()
        self.obj.data.update()
        coords = local_coords(self.obj)
        collar = attribute(self.obj.data, "_piece") >= PARTS["band"]
        self.move(self.clear_of_body(coords.copy(), 0.007, only=collar) - coords)
        self.lay_collar_on_shoulders()
        face_outward(self.obj)

    def copy_edges(self, bm, edges):
        verts = list({v for e in edges for v in e.verts})
        result = bmesh.ops.duplicate(bm, geom=verts + list(edges))
        new_edges = [g for g in result["geom"] if isinstance(g, bmesh.types.BMEdge)]
        new_verts = [g for g in result["geom"] if isinstance(g, bmesh.types.BMVert)]
        return new_edges, new_verts

    def lay_collar_on_shoulders(self):
        """The point collar rests on the jacket: lift any of it that dips inside."""
        mesh = self.obj.data
        coords = local_coords(self.obj)
        piece = attribute(mesh, "_piece")
        cloth = piece == PARTS["torso"]
        polys = [list(p.vertices) for p in mesh.polygons if all(cloth[i] for i in p.vertices)]
        tree = BVHTree.FromPolygons([Vector(c) for c in coords], polys)
        moved = coords.copy()
        for i in np.flatnonzero(piece == PARTS["point collar"]):
            found = tree.find_nearest(Vector(coords[i]))
            if found[0] is None:
                continue
            location, normal = np.array(found[0]), np.array(found[1])
            if (coords[i] - location) @ normal < 0.004:
                moved[i] = location + normal * 0.004
        self.move(moved - coords)


def bridge_hollows(coords, torso, band=0.01):
    """Push each torso vertex out to the convex outline of its horizontal slice of the torso, as a tape
    measure (and cloth) would lie."""
    out = coords.copy()
    idx = np.flatnonzero(torso)
    z = coords[idx, 2]
    for level in np.arange(z.min(), z.max() + band, band):
        near = idx[np.abs(z - level) < band]
        here = idx[np.abs(z - level) < band / 2]
        if len(near) < 8 or len(here) == 0:
            continue
        hull = convex_hull(coords[near, :2])
        centre = hull.mean(axis=0)
        for i in here:
            direction = coords[i, :2] - centre
            length = np.linalg.norm(direction)
            if length < 1e-6:
                continue
            reach = ray_to_polygon(centre, direction / length, hull)
            if reach and reach > length:
                out[i, :2] = centre + direction / length * reach
    return out


def convex_hull(points):
    pts = sorted(set(map(tuple, np.round(points, 6))))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def ray_to_polygon(origin, direction, polygon):
    """Distance from `origin` along `direction` to the polygon's edge."""
    best = None
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
        edge = b - a
        denom = direction[0] * edge[1] - direction[1] * edge[0]
        if abs(denom) < 1e-12:
            continue
        rel = a - origin
        t = (rel[0] * edge[1] - rel[1] * edge[0]) / denom
        u = (rel[0] * direction[1] - rel[1] * direction[0]) / denom
        if t > 0 and -1e-9 <= u <= 1 + 1e-9:
            best = t if best is None else min(best, t)
    return best


class CasualGauge(JacketGauge):
    """Measures the casual jacket like the suit's: its torso and sleeves, not the collar."""
    COLLAR = 0.0

    def __init__(self, obj, body_gauge):
        cloth = attribute(obj.data, "_piece") == PARTS["torso"]
        arm = group_weights(obj, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        self.jacket = cloth
        self.sleeve = cloth & arm
        self.torso = cloth & ~arm
        self.body_gauge = body_gauge


def attribute(mesh, name, dtype=np.int32):
    values = np.empty(len(mesh.vertices), dtype=dtype)
    mesh.attributes[name].data.foreach_get("value", values)
    return values


def drop_islands(obj, smallest=200):
    """Delete stray scraps the cut left behind."""
    edges = edges_of(obj.data)
    n = len(obj.data.vertices)
    parent = np.arange(n)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(i) for i in range(n)])
    sizes = np.bincount(roots, minlength=n)
    doomed = sizes[roots] < smallest
    if doomed.any():
        log("dropped scraps", int(doomed.sum()), "vertices")
        delete_vertices(obj, doomed)


# Texture coordinates and details


def lay_out_texture(jacket):
    """Texture coordinates in metres: the front and back as seen head on, each sleeve unrolled from the
    shoulder, and the collar pieces unrolled around the neck. Every face takes its part's layout, so the
    seams fall where a jacket's do: at the sides, round the armholes, under the arms and at the collar."""
    obj = jacket.obj
    mesh = obj.data
    coords = to_world(obj, local_coords(obj))
    piece = attribute(mesh, "_piece")
    step = attribute(mesh, "_step")
    arm = group_weights(obj, lambda n: n.startswith(ARM_GROUPS)) > 0.5
    sign = np.sign(coords[:, 0])
    layout = jacket.layout

    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv = mesh.uv_layers.new(name="UVMap")
    out = np.zeros((len(mesh.loops), 2))
    for poly in mesh.polygons:
        verts = list(poly.vertices)
        loops = list(poly.loop_indices)
        pieces = piece[verts]
        p = coords[verts]
        if (pieces >= PARTS["band"]).all():
            angle = np.arctan2(p[:, 0], -(p[:, 1] - jacket.neck[1]))
            if angle.max() - angle.min() > np.pi:
                angle[angle < 0] += 2 * np.pi
            kind = pieces.max()
            height = np.array([layout.collar_height(k, s) for k, s in zip(pieces, step[verts])])
            u = 0.5 + 0.4 * angle / np.pi
            v = (layout.FALL_V if kind == PARTS["point collar"] else layout.COLLAR_V) + height / UV_METRES
        elif arm[verts].sum() * 2 > len(verts):
            side = int(np.sign(p[:, 0].sum()))
            arc, along = layout.sleeve_position(p, side)
            if arc.max() - arc.min() > np.pi * UV_SLEEVE_RADIUS:
                arc[arc < 0] += 2 * np.pi * UV_SLEEVE_RADIUS
            u = layout.sleeve_u[side] + arc / UV_METRES
            v = layout.SLEEVE_V + along / UV_METRES
        else:
            front = p[:, 1].mean() < layout.centre_y
            u = (0.25 + p[:, 0] / UV_METRES) if front else (0.75 - p[:, 0] / UV_METRES)
            v = (p[:, 2] - layout.z0) / UV_METRES
        out[loops] = np.c_[u, v]
    uv.data.foreach_set("uv", out.astype(np.float32).ravel())


class Layout:
    """Where each part of the jacket sits on its texture, in both directions."""
    COLLAR_V, FALL_V, SLEEVE_V = 0.9, 0.95, 0.5

    def __init__(self, jacket):
        coords = to_world(jacket.obj, local_coords(jacket.obj))
        self.jacket = jacket
        self.z0 = jacket.hem - 0.03
        arm = group_weights(jacket.obj, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        ring = ~arm & (np.abs(coords[:, 2] - jacket.chest_z) < 0.012)
        self.centre_y = float(coords[ring, 1].mean())
        self.sleeve_u = {1: 0.25, -1: 0.75}
        self.hem, self.chest, self.waist = jacket.hem, jacket.chest_z, jacket.waist_z
        self.sleeve_end = jacket.sleeve_end

    def collar_height(self, piece, step):
        if piece == PARTS["band"]:
            return step * STAND / 2
        if piece == PARTS["stand"]:
            return STAND + (step - 2) * UPPER_STAND / 2
        return step * 0.008

    def sleeve_position(self, points, side):
        """Around (metres of arc from the top of the arm, towards the front) and along the sleeve."""
        s, axis, _ = self.jacket.arms[side]
        rel = points - s
        along = rel @ axis
        up = np.array([0, 0, 1.0]) - axis * axis[2]
        up /= np.linalg.norm(up)
        forward = np.cross(axis, up) * side
        radial = rel - np.outer(along, axis)
        angle = np.arctan2(radial @ forward, radial @ up)
        return angle * UV_SLEEVE_RADIUS, along

    def to_dict(self):
        return {"z0": self.z0, "hem": self.hem, "chest": self.chest, "waist": self.waist, "sleeve_end": self.sleeve_end}


class Painter:
    """Paints a jacket's details into three channels: seams and shadows (red), stitching (green) and
    hardware, the zip and buttons (blue). The page and the studio renderer colour them for the garment."""
    SEAM, THREAD, METAL = 0, 1, 2

    def __init__(self, size=2048):
        self.size = size
        self.image = np.zeros((size, size, 3), dtype=np.float32)
        self.px = UV_METRES / size

    def paint(self, channel, uv_box, coverage):
        """coverage(u, v) -> 0..1 over the pixels of uv_box (u0, v0, u1, v1)."""
        u0, v0, u1, v1 = uv_box
        n = self.size
        i0, i1 = max(0, int(v0 * n) - 2), min(n, int(v1 * n) + 3)
        j0, j1 = max(0, int(u0 * n) - 2), min(n, int(u1 * n) + 3)
        if i0 >= i1 or j0 >= j1:
            return
        v, u = np.mgrid[i0:i1, j0:j1]
        value = np.clip(coverage((u + 0.5) / n, (v + 0.5) / n), 0, 1)
        target = self.image[i0:i1, j0:j1, channel]
        np.maximum(target, value, out=target)

    def save(self, path):
        image = bpy.data.images.new("details", self.size, self.size, alpha=False)
        image.colorspace_settings.name = "Non-Color"
        pixels = np.ones((self.size, self.size, 4), dtype=np.float32)
        pixels[..., :3] = self.image
        image.pixels.foreach_set(pixels.ravel())
        image.filepath_raw = path
        image.file_format = "PNG"
        image.save()
        bpy.data.images.remove(image)


def segment_distance(x, z, a, b):
    """Distance from (x, z) to the segment a-b, and how far along it, in metres."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    length = np.linalg.norm(d)
    t = np.clip(((x - a[0]) * d[0] + (z - a[1]) * d[1]) / (length * length), 0, 1)
    return np.hypot(x - a[0] - t * d[0], z - a[1] - t * d[1]), t * length


class Panel:
    """Paints on one flat part of the layout (front, back or a sleeve) in its own metres."""

    def __init__(self, painter, to_uv, from_uv, box):
        self.painter, self.to_uv, self.from_uv, self.box = painter, to_uv, from_uv, box

    def line(self, points, width, channel, strength=1.0, dash=None):
        """A seam (dash None) or a row of stitches (dash: stitch length) along a polyline in metres."""
        aa = self.painter.px
        for a, b in zip(points, points[1:]):
            (ua, va), (ub, vb) = self.to_uv(*a), self.to_uv(*b)
            pad = (width + aa * 2) / UV_METRES
            box = (min(ua, ub) - pad, min(va, vb) - pad, max(ua, ub) + pad, max(va, vb) + pad)

            def coverage(u, v, a=a, b=b):
                x, z = self.from_uv(u, v)
                distance, along = segment_distance(x, z, a, b)
                value = np.clip((width / 2 - distance) / aa + 0.5, 0, 1) * strength * self.inside(u, v)
                if dash:
                    value = value * ((along / dash) % 1.0 < 0.62)
                return value
            self.painter.paint(channel, box, coverage)

    def stitches(self, points, *offsets):
        """Rows of stitching beside a seam (offsets: metres to one side, measured across)."""
        for offset in offsets or (0,):
            self.line(offset_polyline(points, offset), 0.0011, Painter.THREAD, dash=0.0042)

    def seam(self, points, *stitch_offsets, depth=0.55):
        self.line(points, 0.0022, Painter.SEAM, depth)
        if stitch_offsets:
            self.stitches(points, *stitch_offsets)

    def disc(self, centre, radius, channel=Painter.METAL, rim=True):
        aa = self.painter.px
        cu, cv = self.to_uv(*centre)
        pad = (radius + aa * 2) / UV_METRES

        def coverage(u, v):
            x, z = self.from_uv(u, v)
            d = np.hypot(x - centre[0], z - centre[1])
            return np.clip((radius - d) / aa + 0.5, 0, 1) * self.inside(u, v)
        self.painter.paint(channel, (cu - pad, cv - pad, cu + pad, cv + pad), coverage)
        if rim:
            self.ring(centre, radius * 0.72, 0.0012)

    def ring(self, centre, radius, width):
        aa = self.painter.px
        cu, cv = self.to_uv(*centre)
        pad = (radius + width + aa * 2) / UV_METRES

        def coverage(u, v):
            x, z = self.from_uv(u, v)
            d = np.abs(np.hypot(x - centre[0], z - centre[1]) - radius)
            return np.clip((width / 2 - d) / aa + 0.5, 0, 1) * 0.6 * self.inside(u, v)
        self.painter.paint(Painter.SEAM, (cu - pad, cv - pad, cu + pad, cv + pad), coverage)

    def area(self, x0, z0, x1, z1, channel, pattern):
        """Fill a rectangle (metres) with pattern(x, z) -> 0..1."""
        (ua, va), (ub, vb) = self.to_uv(x0, z0), self.to_uv(x1, z1)

        def coverage(u, v):
            x, z = self.from_uv(u, v)
            inside = (x >= min(x0, x1)) & (x <= max(x0, x1)) & (z >= min(z0, z1)) & (z <= max(z0, z1))
            return pattern(x, z) * inside * self.inside(u, v)
        self.painter.paint(channel, (min(ua, ub), min(va, vb), max(ua, ub), max(va, vb)), coverage)

    def clear_below(self, z):
        """Wipe everything painted below height z (metres), where a waistband goes."""
        u0, v0, u1, _ = self.box
        top = self.to_uv(0, z)[1]
        n = self.painter.size
        self.painter.image[int(v0 * n):max(0, int(top * n)), int(u0 * n):int(u1 * n)] = 0

    def inside(self, u, v):
        u0, v0, u1, v1 = self.box
        return (u >= u0) & (u < u1) & (v >= v0) & (v < v1)


def offset_polyline(points, offset):
    """The polyline moved `offset` metres to its left (looking from its start to its end)."""
    if offset == 0:
        return points
    pts = np.asarray(points, float)
    out = []
    for i, p in enumerate(pts):
        d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        n = np.array([-d[1], d[0]]) / max(np.linalg.norm(d), 1e-9)
        out.append(tuple(p + n * offset))
    return out


def panels(painter, layout):
    S, z0 = UV_METRES, layout.z0
    front = Panel(painter, lambda x, z: (0.25 + x / S, (z - z0) / S),
                  lambda u, v: ((u - 0.25) * S, v * S + z0), (0, 0, 0.5, layout.SLEEVE_V - 0.02))
    back = Panel(painter, lambda x, z: (0.75 - x / S, (z - z0) / S),
                 lambda u, v: ((0.75 - u) * S, v * S + z0), (0.5, 0, 1, layout.SLEEVE_V - 0.02))
    # Sleeves: x is the arc round the arm (0 on top), z the distance down it from the shoulder joint.
    sleeves = [Panel(painter, lambda x, z, c=c: (c + x / S, layout.SLEEVE_V + z / S),
                     lambda u, v, c=c: ((u - c) * S, (v - layout.SLEEVE_V) * S),
                     (c - 0.24, layout.SLEEVE_V - 0.02, c + 0.24, layout.COLLAR_V - 0.01)) for c in (0.25, 0.75)]
    # Collar: x is the distance round the neck (0 at the front), z the height up the piece.
    collar = Panel(painter, lambda x, z: (0.5 + 0.4 * x / NECK_ARC, layout.COLLAR_V + z / S),
                   lambda u, v: ((u - 0.5) * NECK_ARC / 0.4, (v - layout.COLLAR_V) * S), (0, layout.COLLAR_V - 0.005, 1.0, layout.FALL_V - 0.003))
    fall = Panel(painter, lambda x, z: (0.5 + 0.4 * x / NECK_ARC, layout.FALL_V + z / S),
                 lambda u, v: ((u - 0.5) * NECK_ARC / 0.4, (v - layout.FALL_V) * S), (0, layout.FALL_V - 0.003, 1.0, 1.0))
    return front, back, sleeves, collar, fall


def paint_casual_details(layout, style, path, neckline, hem=None):
    """Paint one style's details. neckline(x) is the front collar seam's height at x. The jacket is built
    long and cut to each size's length, so the hem's own details (stitching, rib knit, a waistband) are
    painted only when `hem` (its height) is given, as the studio renderer does; the page draws them itself
    (see casualFabric in app/javascript/lib/stage.js), and everything that runs down the front runs to
    the bottom of the long jacket."""
    painter = Painter()
    front, back, sleeves, collar, fall = panels(painter, layout)
    bottom, chest, waist, top = layout.hem, layout.chest, layout.waist, neckline(0.0)
    collar_top = STAND + UPPER_STAND
    wide = 0.32   # past the side seams

    def rib(x, z):
        return 0.32 * (np.cos(x / 0.0045 * 2 * np.pi) * 0.5 + 0.5)

    if style in ("zip", "bomber"):
        # The zip: a tape either side of metal teeth, from the hem up through the collar, and its pull.
        front.area(-0.011, bottom, 0.011, top + 0.01, Painter.SEAM, lambda x, z: 0.3 + 0 * x)
        front.area(-0.0042, bottom, 0.0042, top + 0.01, Painter.METAL, lambda x, z: (z / 0.0034) % 1 < 0.6)
        collar.area(-0.0042, 0, 0.0042, collar_top, Painter.METAL, lambda x, z: (z / 0.0034) % 1 < 0.6)
        front.area(-0.006, top - 0.05, 0.006, top - 0.012, Painter.METAL, lambda x, z: 1 + 0 * x)
        front.ring((0, top - 0.045), 0.0025, 0.0012)
        for sx in (1, -1):
            front.stitches([(sx * 0.016, bottom), (sx * 0.016, top)])
            # Slanted hand pockets.
            a, b = (sx * 0.105, waist - 0.075), (sx * 0.14, waist + 0.04)
            front.seam([a, b], depth=0.75)
            front.stitches(offset_polyline([a, b], 0.007), 0)
            front.stitches(offset_polyline([a, b], -0.007), 0)
        collar.stitches([(-NECK_ARC, collar_top - 0.006), (NECK_ARC, collar_top - 0.006)])
        collar.stitches([(-NECK_ARC, 0.006), (NECK_ARC, 0.006)])
        if style == "bomber":
            collar.area(-NECK_ARC, 0, NECK_ARC, collar_top, Painter.SEAM, rib)
            for sleeve in sleeves:
                sleeve.area(-0.2, layout.sleeve_end - 0.065, 0.2, layout.sleeve_end + 0.01, Painter.SEAM, rib)
                sleeve.seam([(-0.2, layout.sleeve_end - 0.065), (0.2, layout.sleeve_end - 0.065)])
            if hem is not None:
                for panel in (front, back):
                    panel.area(-wide, hem, wide, hem + 0.065, Painter.SEAM, rib)
                    panel.seam([(-wide, hem + 0.065), (wide, hem + 0.065)])
        else:
            for sleeve in sleeves:
                sleeve.stitches([(-0.2, layout.sleeve_end - 0.025), (0.2, layout.sleeve_end - 0.025)])
            if hem is not None:
                for panel in (front, back):
                    panel.stitches([(-wide, hem + 0.025), (wide, hem + 0.025)])
    else:
        # A trucker or work jacket: buttoned placket, yokes, flap chest pockets, pleat seams, a waistband.
        yoke = chest + 0.085
        for sx in (1, -1):
            front.seam([(sx * 0.02, bottom), (sx * 0.02, top)], 0.006, -0.006)
        for z in np.arange(top - 0.035, bottom, -0.095):
            front.disc((0, z), 0.0075)
        for sx in (1, -1):
            # Yoke, dipping to a point over each pocket.
            pts = [(sx * 0.025, yoke), (sx * 0.05, yoke), (sx * 0.1, yoke - 0.02), (sx * 0.15, yoke), (sx * wide, yoke)]
            front.seam(pts, -0.004 * sx, -0.009 * sx)
            # Flap pocket under it, with a button at its point.
            x0, x1, flap = sx * 0.045, sx * 0.155, yoke - 0.03
            outline = [(x0, flap), (x0, flap - 0.04), (sx * 0.1, flap - 0.055), (x1, flap - 0.04), (x1, flap), (x0, flap)]
            front.seam(outline, 0.004 * sx)
            front.disc((sx * 0.1, flap - 0.043), 0.0065)
            # Pleat seams down to the waistband.
            for x in (sx * 0.075, sx * 0.135):
                front.seam([(x, flap - 0.05), (x, bottom)], 0.004, -0.004)
            # Hand pockets: slits in the side panels.
            front.seam([(sx * 0.19, waist - 0.1), (sx * 0.2, waist + 0.04)], depth=0.75)
            back.seam([(sx * 0.09, chest + 0.03), (sx * 0.09, bottom)], 0.004, -0.004)
        back.seam([(-wide, chest + 0.07), (-0.05, chest + 0.07), (0, chest + 0.03), (0.05, chest + 0.07), (wide, chest + 0.07)],
                  -0.004, -0.009)
        for sleeve in sleeves:
            cuff = layout.sleeve_end - 0.055
            sleeve.seam([(-0.2, cuff), (0.2, cuff)], 0.004, -0.004)
            sleeve.stitches([(-0.2, layout.sleeve_end - 0.006), (0.2, layout.sleeve_end - 0.006)])
            sleeve.disc((0.1, layout.sleeve_end - 0.028), 0.0065)
        fall.stitches([(-NECK_ARC, 0.034), (NECK_ARC, 0.034)])
        collar.stitches([(-NECK_ARC, STAND - 0.005), (NECK_ARC, STAND - 0.005)])
        if hem is not None:
            band = hem + WAISTBAND
            for panel in (front, back):
                panel.clear_below(band)
                panel.seam([(-wide, band), (wide, band)], 0.005, -0.04)
            for x in (0, 0.21, -0.21):
                front.disc((x, hem + 0.022), 0.0075 if x == 0 else 0.0065)
    painter.save(path)
    return painter
