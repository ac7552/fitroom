# Sews a sewing pattern (from script/garments/pattern.py) onto Fitroom's mannequin and drapes it with
# Blender's cloth simulation, the way garment tools like CLO do: each flat panel becomes cloth, is
# wrapped loosely around the part of the body it covers (torso, arm or neck), its seams are pulled
# together by sewing springs while gravity is off, then it falls and settles. The seams are then closed
# for good, and the result is a garment that hangs and folds like cloth, at the size's real dimensions.
#
#   Blender -b --python script/garments/drape.py -- pattern.json out.glb [preview.png]
import json
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "mannequin"))
from fitroom_model import BodyGauge, build_human, delete_vertices, group_weights, local_coords, log, to_world  # noqa: E402

SEW_FRAMES = 30       # gravity off while the seams close
SETTLE_FRAMES = 40    # then it hangs
SLEEVE_START = 0.035  # metres down the arm from the shoulder joint where a sleeve's cap starts
GAP = 0.03           # how far outside the body the wrapped panels start, metres


def outline(panel):
    """The panel's outline points (cm) and, for each edge, the indices of its points along the outline."""
    points, edge_indices = [], []
    for edge in panel["edges"]:
        start = len(points)
        points.extend(edge[:-1])
        edge_indices.append(list(range(start, start + len(edge) - 1)) + [None])
    total = len(points)
    for indices in edge_indices:
        indices[-1] = (indices[-2] + 1) % total
    return np.array(points), edge_indices


def inside(points, polygon):
    """Which points lie inside the polygon (even-odd rule)."""
    x, y = points[:, 0], points[:, 1]
    result = np.zeros(len(points), dtype=bool)
    px, py = polygon[:, 0], polygon[:, 1]
    for i in range(len(polygon)):
        j = i - 1
        crosses = ((py[i] > y) != (py[j] > y)) & (x < (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i] + 1e-12) + px[i])
        result ^= crosses
    return result


def triangulate(points, spacing):
    """Fill the outline with evenly spaced triangles (cm); the outline's points come first, in order."""
    lo, hi = points.min(axis=0), points.max(axis=0)
    rows = np.arange(lo[1] + spacing / 2, hi[1], spacing * math.sqrt(3) / 2)
    grid = np.array([[x + (spacing / 2 if r % 2 else 0), y] for r, y in enumerate(rows)
                     for x in np.arange(lo[0] + spacing / 2, hi[0], spacing)]).reshape(-1, 2)
    if len(grid):
        grid = grid[inside(grid, points)]
        # Keep interior points off the outline, or they make slivers.
        near = np.min(np.linalg.norm(grid[:, None, :] - points[None, :, :], axis=2), axis=1) if len(grid) else []
        grid = grid[near > spacing * 0.6]
    all_points = np.vstack([points, grid]) if len(grid) else points
    n = len(points)
    boundary = [(i, (i + 1) % n) for i in range(n)]
    verts, edges, faces, orig_verts, _, _ = delaunay_2d_cdt(
        [Vector(p) for p in all_points], boundary, [list(range(n))], 1, 1e-5, True)
    # Map output vertices back to ours (CDT may reorder).
    index = [o[0] if o else None for o in orig_verts]
    coords = np.array([[v.x, v.y] for v in verts])
    return coords, faces, index


class Arrangement:
    """Where each part of the body is, for wrapping panels around it (Blender metres, front is -Y)."""

    def __init__(self, body, gauge, chest_cm, sleeve_cm):
        coords = to_world(body, local_coords(body))
        self.neck = gauge.joint(coords, "joint-neck")
        floor, height = gauge.levels(coords)
        chest_z = floor + 0.72 * height
        ring = gauge.torso & (np.abs(coords[:, 2] - chest_z) < 0.01)
        self.centre_y = coords[ring, 1].mean()
        self.half_width = np.abs(coords[ring, 0]).max()
        self.torso_radius = max(chest_cm / 100 / (2 * math.pi), self.half_width + GAP)
        self.arms = {}
        for side, sign in (("l", 1), ("r", -1)):
            self.arms[sign] = [gauge.joint(coords, f"joint-{side}-{j}") for j in ("shoulder", "elbow", "hand")]
        self.sleeve_radius = 0.075
        # How far the body reaches from the torso's axis, by height and direction, so wrapped panels
        # always start outside it.
        arm = group_weights(body, lambda n: n.startswith(("upperarm_", "lowerarm_", "hand_", "thumb_", "index_",
                                                            "middle_", "ring_", "pinky_"))) > 0.3
        skin = gauge.skin & ~arm
        pts = coords[skin]
        self.z_bins = np.arange(0, 2.0, 0.02)
        self.a_bins = np.linspace(-math.pi, math.pi, 37)
        angle = np.arctan2(pts[:, 0], -(pts[:, 1] - self.centre_y))
        radius = np.hypot(pts[:, 0], pts[:, 1] - self.centre_y)
        zi = np.clip(np.digitize(pts[:, 2], self.z_bins) - 1, 0, len(self.z_bins) - 1)
        ai = np.clip(np.digitize(angle, self.a_bins) - 1, 0, len(self.a_bins) - 2)
        reach = np.zeros((len(self.z_bins), len(self.a_bins) - 1))
        np.maximum.at(reach, (zi, ai), radius)
        # Each cell also counts its neighbours (2 cm up and down, 10 degrees round).
        padded = np.maximum.reduce([np.roll(np.roll(reach, dz, 0), da, 1) for dz in (-1, 0, 1) for da in (-1, 0, 1)])
        self.reach = padded
        # The top of the shoulders across the body (x in 2 cm bins), for starting shoulder seams above them.
        upper = gauge.skin & (np.abs(coords[:, 1] - self.centre_y) < 0.14) & (coords[:, 2] > chest_z) & \
            (coords[:, 2] < self.neck[2] - 0.01)
        self.x_bins = np.arange(-0.4, 0.42, 0.02)
        top = np.full(len(self.x_bins), -1.0)
        xi = np.clip(np.digitize(coords[upper, 0], self.x_bins) - 1, 0, len(self.x_bins) - 1)
        np.maximum.at(top, xi, coords[upper, 2])
        self.shoulder_top = top
        self.lift = 0.0

    def body_top(self, x):
        return self.shoulder_top[min(max(int((x + 0.4) / 0.02), 0), len(self.x_bins) - 1)]

    def torso(self, p_gc):
        """Wrap a torso panel point (GarmentCode cm: x left, y up, z front) round the body."""
        x, y, z = p_gc / 100
        facing = 1 if z > 0 else -1   # front or back panel; x is the distance from its centre line
        theta = x / self.torso_radius
        angle = theta if facing > 0 else math.pi - theta   # from the front, as the body's reach is kept
        angle = (angle + math.pi) % (2 * math.pi) - math.pi
        zi = min(max(int(y / 0.02), 0), len(self.z_bins) - 1)
        ai = min(max(int((angle + math.pi) / (2 * math.pi) * (len(self.a_bins) - 1)), 0), len(self.a_bins) - 2)
        r = max(self.torso_radius, self.reach[zi, ai] + 0.02)
        return np.array([r * math.sin(theta), self.centre_y - facing * r * math.cos(theta), y + self.lift])

    def collar(self, p_gc, radius):
        x, y, z = p_gc / 100
        facing = 1 if z > 0 else -1
        theta = x / radius
        return np.array([radius * math.sin(theta), self.neck[1] - facing * radius * math.cos(theta), y + self.lift])

    def sleeve(self, along, across, facing, sign):
        """along: metres down the arm from the shoulder; across: metres round it from the panel's middle
        line; facing: +1 front panel, -1 back."""
        # Along the arm as it bends: shoulder to elbow, then elbow to wrist (and on past it).
        shoulder, elbow, wrist = self.arms[sign]
        upper = np.linalg.norm(elbow - shoulder)
        if along < upper:
            s, axis = shoulder, (elbow - shoulder) / upper
        else:
            s, axis = elbow, (wrist - elbow) / np.linalg.norm(wrist - elbow)
            along -= upper
        up = np.array([0, 0, 1.0]) - axis * axis[2]
        up /= np.linalg.norm(up)
        front = np.cross(axis, up) * sign
        if front[1] > 0:
            front = -front   # Blender's front is -Y
        theta = across / self.sleeve_radius
        n0 = front if facing > 0 else -front
        return s + axis * along + self.sleeve_radius * (math.cos(theta) * n0 + math.sin(theta) * up)


def build_garment(pattern, arrangement, spacing_cm):
    panels = pattern["panels"]
    bm = bmesh.new()
    edge_verts = {}
    sleeve_frames = {}
    # Sleeve panels: GarmentCode lays them along a straight arm in the front plane; measure each panel's
    # points along that arm and across it, to lay them along the mannequin's arm instead.
    for name, panel in panels.items():
        if panel["label"] != "arm":
            continue
        pts, _ = outline(panel)
        world = (np.array(panel["rotation"]) @ np.c_[pts, np.zeros(len(pts))].T).T + panel["translation"]
        sign = 1 if world[:, 0].mean() > 0 else -1
        angle = math.radians(46.8)
        axis = np.array([sign * math.cos(angle), -math.sin(angle), 0])
        sleeve_frames[name] = (sign, axis)

    shoulder_gc = {}
    for name, panel in panels.items():
        if name in sleeve_frames:
            sign, axis = sleeve_frames[name]
            pts, _ = outline(panel)
            world = (np.array(panel["rotation"]) @ np.c_[pts, np.zeros(len(pts))].T).T + panel["translation"]
            shoulder_gc[sign] = min(shoulder_gc.get(sign, 1e9), (world @ axis).min())

    # Front and back widths make half the way round, so their side seams start together.
    widths = {}
    for name, panel in panels.items():
        if panel["label"] == "arm" or "collar" in name:
            continue
        pts, _ = outline(panel)
        world = (np.array(panel["rotation"]) @ np.c_[pts, np.zeros(len(pts))].T).T + panel["translation"]
        widths["front" if world[:, 2].mean() > 0 else "back"] = np.abs(world[:, 0]).max()
    if len(widths) == 2:
        arrangement.torso_radius = max((widths["front"] + widths["back"]) / 100 / math.pi, arrangement.half_width + 0.015)

    # Lift the body panels and collar so the shoulder seams start above the shoulders, not inside them.
    lift = 0.0
    for name, panel in panels.items():
        if panel["label"] == "arm" or "collar" in name:
            continue
        for edge in panel["edges"]:
            pts = np.array(edge)
            world = (np.array(panel["rotation"]) @ np.c_[pts, np.zeros(len(pts))].T).T + panel["translation"]
            for x, y, _ in world / 100:
                # The shoulder line, between the neck and the shoulder joint (the neckline goes round the neck).
                if y > arrangement.neck[2] - 0.2 and 0.08 < abs(x) < 0.18:
                    lift = max(lift, arrangement.body_top(x) + 0.03 - y)
    arrangement.lift = lift
    log("lifted", round(lift * 100, 1), "cm")

    collar_radius = None
    collar_lengths = [sum(np.linalg.norm(np.diff(np.array(e), axis=0), axis=1).sum() for e in p["edges"]) for n, p in panels.items()
                      if "collar" in n]
    if collar_lengths:
        collar_radius = 0.085

    for name, panel in panels.items():
        pts, edge_idx = outline(panel)
        coords2d, faces, index = triangulate(pts, spacing_cm)
        rotation, translation = np.array(panel["rotation"]), np.array(panel["translation"])
        gc3d = (rotation @ np.c_[coords2d, np.zeros(len(coords2d))].T).T + translation
        if name in sleeve_frames:
            sign, axis = sleeve_frames[name]
            up = np.array([math.sin(math.radians(46.8)) * sign, math.cos(math.radians(46.8)), 0])
            # Start the sleeve a little down the arm, clear of the body panels, so the two don't tangle;
            # sewing pulls its cap up into the armhole.
            along = gc3d @ axis - shoulder_gc[sign] + SLEEVE_START * 100
            across = gc3d @ up
            facing = 1 if gc3d[:, 2].mean() > 0 else -1
            across = across - across.mean()
            placed = np.array([arrangement.sleeve(a / 100, c / 100, facing, sign) for a, c in zip(along, across)])
        elif "collar" in name:
            placed = np.array([arrangement.collar(p, collar_radius) for p in gc3d])
        else:
            placed = np.array([arrangement.torso(p) for p in gc3d])
        verts = [bm.verts.new(p) for p in placed]
        for f in faces:
            try:
                bm.faces.new([verts[i] for i in f])
            except ValueError:
                pass
        lookup = {orig: i for i, orig in enumerate(index) if orig is not None}
        edge_verts[name] = [[verts[lookup[i]] for i in indices] for indices in edge_idx]

    sewing = []
    for a, b, how in pattern["stitches"]:
        va = edge_verts[a["panel"]][a["edge"]]
        vb = edge_verts[b["panel"]][b["edge"]]
        n = min(len(va), len(vb))
        order = range(n - 1, -1, -1) if how["reverse"] else range(n)
        for i, j in zip(range(n), order):
            if va[i] is not vb[j]:
                sewing.append((va[i], vb[j]))
    for x, y in sewing:
        try:
            bm.edges.new((x, y))
        except ValueError:
            pass
    # Which seam each thread belongs to, for reporting seams that won't close.
    global SEAMS
    SEAMS = [(f"{a['panel']}:{a['edge']} + {b['panel']}:{b['edge']}", len(edge_verts[a['panel']][a['edge']]))
             for a, b, _ in pattern["stitches"]]
    mesh = bpy.data.meshes.new("garment")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("garment", mesh)
    bpy.context.collection.objects.link(obj)
    log("garment", len(mesh.vertices), "vertices,", len(sewing), "sewing springs")
    return obj


def mannequin_only(body):
    keep = group_weights(body, lambda n: n == "body") > 0.5
    delete_vertices(body, ~keep)
    for modifier in [m for m in body.modifiers if m.type == "MASK"]:
        body.modifiers.remove(modifier)


def simulate(garment, body):
    """Sew with gravity off, then let it hang, in one simulation. The cloth's natural shape is how it was
    wrapped round the body: the pattern's true size, gently curved, so it only folds where it has to.
    (Simulating again from the sewn shape would set its wrinkles in.)"""
    body.modifiers.new("collide", "COLLISION")
    body.collision.thickness_outer = 0.004
    body.collision.cloth_friction = 1

    modifier = garment.modifiers.new("cloth", "CLOTH")
    s = modifier.settings
    s.quality = 12
    s.mass = 0.3
    s.tension_stiffness = s.compression_stiffness = 40
    s.shear_stiffness = 20
    s.bending_stiffness = 15
    s.air_damping = 5
    s.use_sewing_springs = True
    s.sewing_force_max = 0   # unbounded
    weights = s.effector_weights
    weights.gravity = 0.0
    weights.keyframe_insert("gravity", frame=SEW_FRAMES)
    weights.gravity = 1.0
    weights.keyframe_insert("gravity", frame=SEW_FRAMES + 5)
    c = modifier.collision_settings
    c.distance_min = 0.004
    c.use_self_collision = True
    c.self_distance_min = 0.003
    total = SEW_FRAMES + SETTLE_FRAMES
    modifier.point_cache.frame_start, modifier.point_cache.frame_end = 1, total

    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, total
    started = time.time()
    for frame in range(1, total + 1):
        scene.frame_set(frame)
        if frame % 10 == 0:
            log("frame", frame, round(time.time() - started, 1), "s", "seams", seam_gap(garment))
    # Keep the draped shape: copy it out of the simulation, then drop the simulation and the flat shape.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = garment.evaluated_get(depsgraph).to_mesh()
    draped = np.empty(len(evaluated.vertices) * 3)
    evaluated.vertices.foreach_get("co", draped)
    garment.evaluated_get(depsgraph).to_mesh_clear()
    garment.modifiers.remove(modifier)
    garment.data.vertices.foreach_set("co", draped.astype(np.float32))
    garment.data.update()
    report_seams(garment)
    close_seams(garment)
    for poly in garment.data.polygons:
        poly.use_smooth = True


def seam_gap(garment):
    """The mean length of the sewing threads (metres) in the simulated shape."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = garment.evaluated_get(depsgraph).to_mesh()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    lengths = [e.calc_length() for e in bm.edges if not e.link_faces]
    bm.free()
    garment.evaluated_get(depsgraph).to_mesh_clear()
    # Nearly every stitch, not just the average: a few open ones pucker the seam when it's closed.
    return round(float(np.percentile(lengths, 95)), 4) if lengths else 0

def report_seams(garment):
    """Log each seam's mean gap (cm) after sewing, threads being in seam order."""
    bm = bmesh.new()
    bm.from_mesh(garment.data)
    lengths = [e.calc_length() for e in bm.edges if not e.link_faces]
    bm.free()
    at = 0
    for name, count in SEAMS:
        gaps = lengths[at:at + count]
        at += count
        if gaps and np.mean(gaps) > 0.005:
            log("open seam", name, round(float(np.mean(gaps)) * 100, 1), "cm")


def close_seams(garment):
    """Join each pair of sewn points into one, so the garment is one piece of cloth."""
    bm = bmesh.new()
    bm.from_mesh(garment.data)
    loose = [e for e in bm.edges if not e.link_faces]
    for e in loose:
        a, b = e.verts
        a.co = b.co = (a.co + b.co) / 2
    seam = list({v for e in loose for v in e.verts})
    bmesh.ops.remove_doubles(bm, verts=seam, dist=0.0005)
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    # Ease out the puckers closing left: smooth the cloth either side of each seam.
    near = {v for v in bm.verts if v.is_valid and any(e.other_vert(v) in seam for e in v.link_edges)} | {v for v in seam if v.is_valid}
    ring = set(near)
    for v in near:
        ring.update(e.other_vert(v) for e in v.link_edges)
    for _ in range(6):
        bmesh.ops.smooth_vert(bm, verts=list(ring), factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(garment.data)
    bm.free()
    log("seams closed:", len(loose), "stitches")


def studio_render(path, garment, body, color="#1b1b1d", roughness=0.62):
    """The studio photo's lighting and backdrop (script/render/studio.py), for comparing."""
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "render"))
    import studio as photo
    scene = bpy.context.scene
    photo.studio(scene, 1.74)
    cloth_material = photo.plain_material("cloth", photo.hex_to_linear(color), roughness)
    cloth_material.node_tree.nodes["Principled BSDF"].inputs["Coat Weight"].default_value = 0.05
    for obj, material in ((garment, cloth_material),
                          (body, photo.plain_material("mannequin", (0.85, 0.84, 0.82), 0.45))):
        obj.data.materials.clear()
        obj.data.materials.append(material)
    solid = garment.modifiers.new("thickness", "SOLIDIFY")
    solid.thickness = 0.002
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 1200
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def preview(path, garment, body):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.85, 0.86, 0.88, 1)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    scene.collection.objects.link(sun)
    for obj, color in ((garment, (0.05, 0.05, 0.06, 1)), (body, (0.85, 0.84, 0.82, 1))):
        m = bpy.data.materials.new(obj.name)
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
        m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
        obj.data.materials.clear()
        obj.data.materials.append(m)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 1.1
    scene.render.resolution_x, scene.render.resolution_y = 800, 1000
    root, ext = os.path.splitext(path)
    for label, angle in (("front", 15), ("side", 80), ("back", 180)):
        a = math.radians(angle)
        cam.location = (3 * math.sin(a), -3 * math.cos(a), 1.15)
        cam.rotation_euler = (math.radians(90), 0, a)
        scene.render.filepath = f"{root}-{label}{ext}"
        bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    pattern = json.load(open(args[0]))
    objects = build_human()
    body = objects["body"]
    bpy.data.objects.remove(objects["suit"])
    gauge = BodyGauge(body)
    arrangement = Arrangement(body, gauge, chest_cm=pattern.get("chest", 110), sleeve_cm=60)
    garment = build_garment(pattern, arrangement, spacing_cm=float(os.environ.get("DRAPE_SPACING", 1.0)))
    mannequin_only(body)
    if os.environ.get("DRAPE_ARRANGE_ONLY"):   # a look at the starting arrangement, before anything moves
        preview(args[2], garment, body)
        return
    simulate(garment, body)
    if len(args) > 2:
        if os.environ.get("DRAPE_STUDIO"):
            studio_render(args[2], garment, body)
        else:
            preview(args[2], garment, body)


if __name__ == "__main__":
    main()
