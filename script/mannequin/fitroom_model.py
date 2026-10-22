# Shared code for Fitroom's Blender scripts: building the MakeHuman mannequin and suit, measuring them the
# way a tailor would, and the shape keys the page and the studio renderer use. Imported by build.py
# (the model the page loads) and ../render/studio.py (photoreal renders of one outfit).
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from bl_ext.blender_org.mpfb.services.humanservice import HumanService
from bl_ext.blender_org.mpfb.services.locationservice import LocationService
from bl_ext.blender_org.mpfb.services.targetservice import TargetService

OUT = os.path.abspath(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else os.path.abspath("public/models")
DATA = LocationService.get_user_data()
SUIT = "male_elegantsuit01"
WORN = ["suit"]
GARMENTS = ("jacket", "trousers")
JACKET_MEASURES = ("chest", "waist", "shoulders", "sleeve", "length")
TROUSER_MEASURES = ("waist", "seat", "thigh", "inseam", "leg_opening")
BODY_MEASURES = ("chest", "waist", "shoulders", "arm", "hips", "inseam")

# The browser drives these to match the measurements. Each loads as -incr and -decr.
TARGETS = ["measure-bust-circ", "measure-waist-circ", "measure-shoulder-dist", "measure-upperarm-length",
           "measure-lowerarm-length", "measure-hips-circ", "measure-upperleg-height", "measure-lowerleg-height"]
# Tape-measure landmarks sit outside the rig's joints: the shoulder bone (acromion) above the shoulder joint,
# the wrist bone past the wrist joint. Across the back, a tape reads a little less than the deltoids' width.
ACROMION = 0.04
WRIST_BONE = 0.034
ACROSS_BACK = 0.93
NAVEL = 0.6  # share of height where Fitroom asks people to measure their waist
ARM_GROUPS = ("upperarm_", "lowerarm_", "hand_", "thumb_", "index_", "middle_", "ring_", "pinky_")


def log(*args):
    print("[fitroom]", *args, flush=True)


def asset(*parts):
    return os.path.join(DATA, *parts)


# Building the person


def build_human():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)

    macro = TargetService.get_default_macro_info_dict()
    macro.update(gender=1.0, age=0.5, muscle=0.55, weight=0.64, height=0.5, proportions=0.6)
    macro["race"] = {"caucasian": 0.6, "african": 0.2, "asian": 0.2}
    body = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    HumanService.add_builtin_rig(body, "game_engine")

    # A display mannequin: just the body (the page draws it in matte white) and the suit.
    suit = HumanService.add_mhclo_asset(asset("clothes", SUIT, f"{SUIT}.mhclo"), body, asset_type="Clothes",
                                        subdiv_levels=0, material_type="MAKESKIN")
    objects = {"body": body, "suit": suit}

    # Fold MakeHuman's age, weight and other sliders into the mesh, so the only shape keys left are ours.
    TargetService.bake_targets(body)
    return objects


# Reading geometry


def local_coords(obj):
    flat = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", flat)
    return flat.reshape(-1, 3)


def key_coords(obj, name):
    block = obj.data.shape_keys.key_blocks[name]
    flat = np.empty(len(block.data) * 3, dtype=np.float64)
    block.data.foreach_get("co", flat)
    return flat.reshape(-1, 3)


def to_world(obj, coords):
    m = np.array(obj.matrix_world)
    return coords @ m[:3, :3].T + m[:3, 3]


def group_weights(obj, predicate):
    """Summed weight per vertex of the vertex groups whose names pass `predicate`."""
    wanted = {g.index for g in obj.vertex_groups if predicate(g.name)}
    weights = np.zeros(len(obj.data.vertices))
    for v in obj.data.vertices:
        weights[v.index] = sum(g.weight for g in v.groups if g.group in wanted)
    return weights


def hull_perimeter(points):
    """Perimeter of the 2D convex hull: what a tape measure reads around a cross-section."""
    pts = sorted(set(map(tuple, np.round(points, 5))))
    if len(pts) < 3:
        return 0.0

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
    hull = lower[:-1] + upper[:-1]
    return sum(math.dist(hull[i], hull[(i + 1) % len(hull)]) for i in range(len(hull)))


def slab(coords, mask, z, half=0.006):
    sel = mask & (np.abs(coords[:, 2] - z) < half)
    return coords[sel][:, :2]


class BodyGauge:
    """Takes the five Fitroom measurements off the body mesh, the way a tailor would."""

    def __init__(self, body):
        self.skin = group_weights(body, lambda n: n == "body") > 0.5
        self.torso = self.skin & (group_weights(body, lambda n: n.startswith(ARM_GROUPS)) < 0.3)
        self.joints = {name: group_weights(body, lambda n, name=name: n == name) > 0.5
                       for name in ("joint-l-shoulder", "joint-r-shoulder", "joint-l-elbow", "joint-r-elbow",
                                    "joint-l-hand", "joint-r-hand", "joint-neck")}

    def joint(self, coords, name):
        return coords[self.joints[name]].mean(axis=0)

    def levels(self, coords):
        skin = coords[self.skin]
        floor, top = skin[:, 2].min(), skin[:, 2].max()
        return floor, top - floor

    def measure(self, coords):
        floor, height = self.levels(coords)
        z = lambda share: floor + share * height
        chest = max(hull_perimeter(slab(coords, self.torso, h)) for h in np.linspace(z(0.68), z(0.76), 17))
        waist = hull_perimeter(slab(coords, self.torso, z(NAVEL)))

        shoulders = self.shoulder_width(coords, coords, self.skin)

        arms = []
        for side in "lr":
            s, e, w = (self.joint(coords, f"joint-{side}-{j}") for j in ("shoulder", "elbow", "hand"))
            arms.append(np.linalg.norm(e - s) + np.linalg.norm(w - e) + ACROMION + WRIST_BONE)
        hips = max(hull_perimeter(slab(coords, self.torso, h)) for h in np.linspace(z(0.46), z(0.56), 21))
        middle = self.skin & (np.abs(coords[:, 0]) < 0.01) & (coords[:, 2] > z(0.3))
        inseam = coords[middle][:, 2].min() - floor
        return {"height": height * 100, "chest": chest * 100, "waist": waist * 100, "shoulders": shoulders * 100,
                "arm": float(np.mean(arms)) * 100, "hips": hips * 100, "inseam": inseam * 100}

    def shoulder_width(self, coords, body_coords, mask):
        """Width across the tops of the shoulders, in a band just above the shoulder joints."""
        z = max(self.joint(body_coords, "joint-l-shoulder")[2], self.joint(body_coords, "joint-r-shoulder")[2])
        band = mask & (coords[:, 2] > z + 0.015) & (coords[:, 2] < z + 0.04)
        return (coords[band][:, 0].max() - coords[band][:, 0].min()) * ACROSS_BACK


class JacketGauge:
    """Measures the suit's jacket the way a size chart does, and finds which vertices belong to it."""
    COLLAR = 0.035   # how far the collar stands above its seam at the back

    def __init__(self, suit, body_gauge):
        uv_layer = suit.data.uv_layers.active.data
        uvs = np.zeros((len(suit.data.vertices), 2))
        for loop in suit.data.loops:
            uvs[loop.vertex_index] = uv_layer[loop.index].uv
        self.uvs = uvs

        # The texture atlas puts most of the jacket in its top half (one sleeve sits lower down, but only
        # sleeves follow the arm bones); the shirt collar, cuffs and tie are light, the jacket cloth dark.
        image = bpy.data.images.load(asset("clothes", SUIT, f"{SUIT}_diffuse.png"))
        w, h = image.size
        pixels = np.array(image.pixels[:]).reshape(h, w, 4)
        px = np.clip((uvs[:, 0] * w).astype(int), 0, w - 1)
        py = np.clip((uvs[:, 1] * h).astype(int), 0, h - 1)
        rgb = pixels[py, px, :3]
        lum = rgb.mean(axis=1)
        grey = (rgb.max(axis=1) - rgb.min(axis=1)) < 0.08  # the jacket cloth is grey; the tie's stripes are coloured
        on_arm = group_weights(suit, lambda n: n.startswith(ARM_GROUPS)) > 0.5
        upper = (uvs[:, 1] > 0.53) | on_arm
        self.jacket = upper & (lum < 0.3) & grey
        self.shirt = upper & ~self.jacket  # collar, tie and cuffs
        self.sleeve = self.jacket & on_arm
        self.torso = self.jacket & ~self.sleeve
        self.body_gauge = body_gauge

    def measure(self, coords, body_coords):
        g = self.body_gauge
        floor, height = g.levels(body_coords)
        z = lambda share: floor + share * height
        chest_z = max(np.linspace(z(0.68), z(0.76), 17), key=lambda h: hull_perimeter(slab(body_coords, g.torso, h)))
        waist_z = z(NAVEL)
        chest = hull_perimeter(slab(coords, self.torso, chest_z, 0.01))
        waist = hull_perimeter(slab(coords, self.torso, waist_z, 0.01))

        torso = coords[self.torso]
        shoulders = g.shoulder_width(coords, body_coords, self.jacket)

        # Back length runs from the collar seam to the hem.
        neck = g.joint(body_coords, "joint-neck")
        back = torso[(torso[:, 1] > neck[1]) & (np.abs(torso[:, 0]) < 0.05)]  # Blender's front is -Y
        length = back[:, 2].max() - self.COLLAR - back[:, 2].min()

        sleeves = []
        for side, sign in (("l", 1), ("r", -1)):
            s, w = g.joint(body_coords, f"joint-{side}-shoulder"), g.joint(body_coords, f"joint-{side}-hand")
            axis = (w - s) / np.linalg.norm(w - s)
            pts = coords[self.sleeve & (np.sign(coords[:, 0]) == sign)]
            along = (pts - s) @ axis
            sleeves.append(along.max() + ACROMION)  # from the shoulder seam, which sits on the shoulder bone
        return {"chest": chest * 100, "waist": waist * 100, "shoulders": shoulders * 100, "length": length * 100,
                "sleeve": float(np.mean(sleeves)) * 100, "chest_z": chest_z, "waist_z": waist_z}


class TrouserGauge:
    """Measures the suit's trousers the way a size chart does: waist, seat, thigh, inseam, leg opening."""

    def __init__(self, jacket_gauge):
        uvs = jacket_gauge.uvs
        rest = ~(jacket_gauge.jacket | jacket_gauge.shirt)
        shoes = (uvs[:, 0] > 0.72) & (uvs[:, 1] > 0.27) & (uvs[:, 1] < 0.55)  # the shoes' corner of the texture
        self.trousers = rest & ~shoes
        self.shoes = rest & shoes

    def landmarks(self, coords):
        pants = coords[self.trousers]
        top = pants[:, 2].max()
        crotch = pants[np.abs(pants[:, 0]) < 0.015][:, 2].min()
        hem = pants[:, 2].min()
        return top, crotch, hem

    def measure(self, coords):
        top, crotch, hem = self.landmarks(coords)
        leg = self.trousers & (coords[:, 0] > 0.005)
        waist = hull_perimeter(slab(coords, self.trousers, top - 0.015, 0.008))
        seat = max(hull_perimeter(slab(coords, self.trousers, h, 0.008)) for h in np.linspace(crotch + 0.04, crotch + 0.16, 13))
        thigh = hull_perimeter(slab(coords, leg, crotch - 0.05, 0.008))
        opening = hull_perimeter(slab(coords, leg, hem + 0.02, 0.008))
        return {"waist": waist * 100, "seat": seat * 100, "thigh": thigh * 100, "inseam": (crotch - hem) * 100,
                "leg_opening": opening * 100}


# Shape keys


def load_targets(body):
    names = []
    for target in TARGETS:
        for direction in ("incr", "decr"):
            name = f"{target}-{direction}"
            TargetService.load_target(body, TargetService.target_full_path(name), weight=0.0, name=name)
            names.append(name)
    return names


def capture_worn_shapes(objects, names):
    """For each body target, refit everything the body wears and record where its vertices end up."""
    body = objects["body"]
    blocks = body.data.shape_keys.key_blocks
    shapes = {}
    for name in names:
        blocks[name].value = 1.0
        HumanService.refit(body)
        shapes[name] = {part: local_coords(objects[part]).copy() for part in WORN}
        blocks[name].value = 0.0
        log("refitted for", name)
    HumanService.refit(body)
    return shapes


def add_shape_keys(obj, keys):
    if obj.data.shape_keys is None:
        obj.shape_key_add(name="Basis", from_mix=False)
    for name, coords in keys.items():
        block = obj.shape_key_add(name=name, from_mix=False)
        block.data.foreach_set("co", coords.astype(np.float32).ravel())


def ease_keys(suit, gauge, body_coords, jacket_info):
    """Displacements that make the jacket 1 cm bigger (or longer) in one place each."""
    base = local_coords(suit)
    world = to_world(suit, base)
    to_local = np.array(suit.matrix_world.inverted())[:3, :3]
    normals = np.empty(len(suit.data.vertices) * 3)
    suit.data.vertices.foreach_get("normal", normals)
    normals = normals.reshape(-1, 3)
    horizontal = normals.copy()
    horizontal[:, 2] = 0
    horizontal /= np.maximum(np.linalg.norm(horizontal, axis=1, keepdims=True), 1e-6)

    z = world[:, 2]
    chest_z, waist_z = jacket_info["chest_z"], jacket_info["waist_z"]
    torso = gauge.torso.astype(float)
    sleeve = gauge.sleeve.astype(float)
    radius_per_cm = 0.01 / (2 * math.pi)

    def gauss(d, spread):
        return np.exp(-(d * d) / (2 * spread * spread))

    def key(displacement):
        return base + displacement @ to_local.T

    chest_w = torso * gauss(z - chest_z, 0.07)
    waist_w = torso * np.where(z < waist_z, np.maximum(gauss(z - waist_z, 0.07), 0.75), gauss(z - waist_z, 0.06))

    g = gauge.body_gauge
    shoulder_z = max(g.joint(body_coords, "joint-l-shoulder")[2], g.joint(body_coords, "joint-r-shoulder")[2])
    across = np.clip((np.abs(world[:, 0]) - 0.04) / 0.14, 0, 1) * np.clip((z - chest_z) / (shoulder_z - chest_z), 0, 1)
    shoulder_shift = np.zeros_like(world)
    shoulder_shift[:, 0] = np.sign(world[:, 0]) * 0.005 * np.maximum(torso * across, sleeve)

    sleeve_shift = np.zeros_like(world)
    for side, sign in (("l", 1), ("r", -1)):
        s, w = g.joint(body_coords, f"joint-{side}-shoulder"), g.joint(body_coords, f"joint-{side}-hand")
        length = np.linalg.norm(w - s)
        axis = (w - s) / length
        mine = gauge.sleeve & (np.sign(world[:, 0]) == sign)
        t = np.clip(((world - s) @ axis) / length, 0, 1)
        sleeve_shift[mine] = np.outer(t[mine] * 0.01, axis)

    hem_z = world[gauge.torso][:, 2].min()
    length_shift = np.zeros_like(world)
    length_shift[:, 2] = -0.01 * torso * np.clip((waist_z - z) / max(waist_z - hem_z, 1e-3), 0, 1)

    return {
        "ease-chest": key(horizontal * (radius_per_cm * chest_w)[:, None]),
        "ease-waist": key(horizontal * (radius_per_cm * waist_w)[:, None]),
        "ease-shoulders": key(shoulder_shift),
        "ease-sleeve": key(sleeve_shift),
        "ease-length": key(length_shift),
    }


def trouser_ease_keys(suit, gauge):
    """Displacements that make the trousers 1 cm bigger around the waist, seat, thigh or leg opening, or
    1 cm longer in the leg."""
    base = local_coords(suit)
    world = to_world(suit, base)
    to_local = np.array(suit.matrix_world.inverted())[:3, :3]
    normals = np.empty(len(suit.data.vertices) * 3)
    suit.data.vertices.foreach_get("normal", normals)
    horizontal = normals.reshape(-1, 3).copy()
    horizontal[:, 2] = 0
    horizontal /= np.maximum(np.linalg.norm(horizontal, axis=1, keepdims=True), 1e-6)

    z = world[:, 2]
    top, crotch, hem = gauge.landmarks(world)
    pants = gauge.trousers.astype(float)
    radius_per_cm = 0.01 / (2 * math.pi)

    def gauss(d, spread):
        return np.exp(-(d * d) / (2 * spread * spread))

    def around(weight):
        return base + (horizontal * (radius_per_cm * pants * weight)[:, None]) @ to_local.T

    longer = np.zeros_like(world)
    longer[:, 2] = -0.01 * pants * np.clip((crotch - z) / max(crotch - hem, 1e-3), 0, 1)
    return {
        "ease-trousers-waist": around(gauss(z - (top - 0.015), 0.035)),
        "ease-seat": around(gauss(z - (crotch + 0.1), 0.07) * (z > crotch - 0.06)),
        "ease-thigh": around(gauss(z - (crotch - 0.05), 0.08) * (z < crotch + 0.02)),
        "ease-leg-opening": around(gauss(z - hem, 0.14) * (z < crotch - 0.2)),
        "ease-inseam": base + longer @ to_local.T,
    }


def delete_vertices(obj, doomed):
    """Delete vertices by index; shape keys and vertex groups follow."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if doomed[v.index]], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def split_suit(suit, jacket_gauge):
    """Split the suit into the jacket (with the shirt collar, cuffs and tie inside it) and the trousers
    (with the shoes), so an outfit can have either or both."""
    trousers = suit.copy()
    trousers.data = suit.data.copy()
    bpy.context.collection.objects.link(trousers)
    in_jacket = jacket_gauge.jacket | jacket_gauge.shirt
    delete_vertices(suit, ~in_jacket)
    delete_vertices(trousers, in_jacket)
    for garment in (suit, trousers):
        face_outward(garment)
    return suit, trousers


def face_outward(obj):
    """Make every face of a garment point the same way (some of MakeHuman's are flipped), so the page can
    tell the outside of the cloth from its lining."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def mark_covered_body(body, body_gauge, coords):
    """Record, on each body vertex, whether the jacket or the trousers covers it, so the page can hide the
    body just where the clothes being worn are (the clothes fit too close for it not to show through).
    Then delete MakeHuman's helper geometry."""
    floor, height = body_gauge.levels(coords)
    z = coords[:, 2]
    under = group_weights(body, lambda n: n.startswith("Delete.")) > 0.5
    lowerarm = group_weights(body, lambda n: n.startswith("lowerarm_")) > 0.5
    hands = group_weights(body, lambda n: n.startswith(ARM_GROUPS[2:])) > 0.3
    arms = group_weights(body, lambda n: n.startswith(ARM_GROUPS)) > 0.3
    # The wrist stays: a jacket's cuff ends there, and a hollow sleeve looks wrong when a size runs short.
    wrists = [body_gauge.joint(coords, f"joint-{side}-hand") for side in "lr"]
    wrist = lowerarm & (np.min([np.linalg.norm(coords - w, axis=1) for w in wrists], axis=0) < 0.07)
    jacket = under & ~hands & ~wrist & ((z > floor + 0.5 * height) | arms)
    trousers = under & ~arms & (z < floor + 0.62 * height)
    # The page hides MakeHuman's head and draws a faceless egg in its place, as on a display mannequin.
    neck = body_gauge.joint(coords, "joint-neck")
    head = z > neck[2] + 0.035
    for name, mask in (("_cover_jacket", jacket), ("_cover_trousers", trousers), ("_head", head)):
        attribute = body.data.attributes.new(name=name, type="FLOAT", domain="POINT")
        attribute.data.foreach_set("value", mask.astype(np.float32))

    keep = group_weights(body, lambda n: n == "body") > 0.5
    skin = coords[keep & head]
    low, high = skin.min(axis=0), skin.max(axis=0)
    centre, half = (low + high) / 2, (high - low) / 2
    delete_vertices(body, ~keep)
    for modifier in [m for m in body.modifiers if m.type == "MASK"]:
        body.modifiers.remove(modifier)
    # Where the egg goes, in the page's coordinates (glTF is y-up: Blender's (x, y, z) is (x, z, -y)).
    return {"centre": [round(float(v), 4) for v in (centre[0], centre[2], -centre[1])],
            "radii": [round(float(v), 4) for v in (half[0] * 0.92, half[2] * 0.95, half[1] * 0.92)]}


def subdivide_with_shape_keys(obj, levels=1):
    """Smooth the mesh with one level of Catmull-Clark subdivision, keeping every shape key: each key is
    evaluated through the subdivision and written onto the new, denser mesh."""
    blocks = obj.data.shape_keys.key_blocks
    names = [b.name for b in blocks][1:]
    for b in blocks:
        b.value = 0.0
    for modifier in obj.modifiers:
        modifier.show_viewport = False
    smooth = obj.modifiers.new("smooth", "SUBSURF")
    smooth.levels = smooth.render_levels = levels

    depsgraph = bpy.context.evaluated_depsgraph_get()

    def evaluated():
        depsgraph.update()
        mesh = obj.evaluated_get(depsgraph).to_mesh()
        flat = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", flat)
        obj.evaluated_get(depsgraph).to_mesh_clear()
        return flat.reshape(-1, 3)

    keys = {}
    for name in names:
        blocks[name].value = 1.0
        keys[name] = evaluated()
        blocks[name].value = 0.0
    depsgraph.update()
    dense = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)

    obj.modifiers.remove(smooth)
    obj.shape_key_clear()
    obj.data = dense
    for modifier in obj.modifiers:
        modifier.show_viewport = True
    add_shape_keys(obj, keys)
    for poly in obj.data.polygons:
        poly.use_smooth = True


def bake_ambient_occlusion(targets, size=1024, samples=96):
    """Bake the shadows folds cast on themselves (under the lapels, in the armpits, inside the collar) into
    a texture on the suit's own layout, with the mannequin in place as an occluder. The jacket and trousers
    share one texture layout, so they bake into one image."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    if scene.world is None:
        scene.world = bpy.data.worlds.new("studio")
    scene.world.light_settings.distance = 0.12

    image = bpy.data.images.new("suit_ao", size, size, alpha=False)
    material = bpy.data.materials.new("bake")
    material.use_nodes = True
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    material.node_tree.nodes.active = node
    # Only the clothes shade themselves; the mannequin inside them sits too close and would leave dark blotches.
    hidden = [o for o in bpy.data.objects if o.type == "MESH" and o not in targets]
    for obj in hidden:
        obj.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    for target in targets:
        target.data.materials.clear()
        target.data.materials.append(material)
        target.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.bake(type="AO", margin=8, use_clear=True)
    for obj in hidden:
        obj.hide_render = False
    image.filepath_raw = os.path.join(OUT, "textures", "suit_ao.webp")
    image.file_format = "WEBP"
    image.save(filepath=image.filepath_raw, quality=90)
    return "textures/suit_ao.webp"


# Textures


def save_texture(source, name, size, *, fabric=False):
    image = bpy.data.images.load(source)
    if image.size[0] > size:
        image.scale(size, size)
    if fabric:
        tintable_fabric(image)
    image.filepath_raw = os.path.join(OUT, "textures", f"{name}.webp")
    image.file_format = "WEBP"
    bpy.context.scene.render.image_settings.quality = 88
    image.save(filepath=image.filepath_raw, quality=88)
    return f"textures/{name}.webp"


def tintable_fabric(image):
    """Lighten the suit cloth to a neutral grey and mark it in alpha, so the page can dye it any colour.
    Shirt, tie, buttons and shoes keep their own colours (alpha 0)."""
    w, h = image.size
    px = np.array(image.pixels[:]).reshape(h, w, 4)
    rgb = px[..., :3]
    lum = rgb.mean(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    v, u = np.mgrid[0:h, 0:w]
    u, v = u / w, v / h
    shoes = (u > 0.72) & (v > 0.28) & (v < 0.55)
    cloth = (lum > 0.09) & (lum < 0.3) & (sat < 0.06) & ~shoes
    grey = np.clip(lum / np.median(lum[cloth]) * 0.72, 0, 1)
    px[..., :3] = np.where(cloth[..., None], grey[..., None], rgb)
    px[..., 3] = cloth.astype(float)
    image.pixels[:] = px.ravel()


# Export


def export_hero_jacket(suit):
    """A light, static copy of the jacket for the home page: arms relaxed, no rig, no shape keys."""
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    # Turn each upper arm about the world's front-to-back axis, pivoting on its own shoulder joint. Pose
    # matrices are in the rig's space, so express the axis there too.
    axis = rig.matrix_world.to_3x3().inverted() @ Vector((0, 1, 0))
    for side, angle in (("l", 0.68), ("r", -0.68)):
        bone = rig.pose.bones[f"upperarm_{side}"]
        head = bone.head.copy()
        turn = Matrix.Translation(head) @ Matrix.Rotation(angle, 4, axis.normalized()) @ Matrix.Translation(-head)
        bone.matrix = turn @ bone.matrix
        bpy.context.view_layer.update()

    hero = suit.copy()
    hero.data = suit.data.copy()
    hero.name = hero.data.name = "jacket"
    bpy.context.collection.objects.link(hero)
    hero.shape_key_clear()
    bpy.ops.object.select_all(action="DESELECT")
    hero.select_set(True)
    bpy.context.view_layer.objects.active = hero
    for modifier in list(hero.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    hero.parent = None
    hero.matrix_world = suit.matrix_world

    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, "jacket.glb"), export_format="GLB", use_selection=True,
        export_morph=False, export_skins=False, export_materials="NONE", export_animations=False, export_yup=True,
    )
    bpy.data.objects.remove(hero)
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)



def export(objects):
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    rig.name = "rig"
    for name, obj in objects.items():
        obj.name = name
        obj.data.name = name
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [rig, *objects.values()]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, "mannequin.glb"), export_format="GLB", use_selection=True,
        export_morph=True, export_morph_normal=False, export_try_sparse_sk=True, export_skins=True, export_apply=False,
        export_attributes=True,
        export_materials="NONE", export_animations=False, export_yup=True,
    )


