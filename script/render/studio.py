# Renders one outfit on one body as a studio photo: the mannequin is shaped, the clothes are sized,
# posed and draped by cloth simulation (so they hang, fold and layer like cloth, which the page's
# real-time view can only imitate), then path-traced with Cycles on a transparent background.
#
#   Blender -b --python script/render/studio.py -- job.json
#
# job.json (written by the Rails app from what's on screen, and deleted after):
#   scale   the mannequin's height relative to the model's
#   body    MakeHuman measurement shape keys and their weights
#   items   [{ kind: "jacket" | "coat" | "trousers", style (jackets: "tailored" | "zip" | "bomber" | "shirt"),
#             ease: { shape key: cm }, color: "#rrggbb", fabric }]
#   pose    a pose name from public/models/poses.json
#   output  where to write the PNG
#   samples render samples (quality against time)
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "script", "mannequin"))
from fitroom_model import *  # noqa: E402,F401,F403
from casual_jacket import COLLARS, PARTS, CasualGauge, CasualJacket, attribute, paint_casual_details  # noqa: E402

SETTLE_FRAMES = 30
WOOL_REPEAT = 46
# Matches FABRICS in app/javascript/lib/stage.js: roughness, sheen, weave strength, coat; and the colour of
# stitching ("tone": the cloth's own, a shade lighter) and hardware.
FABRICS = {
    "wool": (0.85, 0.4, 0.35, 0.0),
    "cotton": (0.85, 0.2, 0.5, 0.0),
    "denim": (0.9, 0.1, 0.8, 0.0),
    "leather": (0.55, 0.0, 0.05, 0.15),
    "nylon": (0.38, 0.15, 0.05, 0.15),
}
TRIMS = {
    "wool": ("tone", "#2b2724"),
    "cotton": ("tone", "#3a3a3a"),
    "denim": ("#c58b45", "#8c6a3c"),
    "leather": ("tone", "#8d8f93"),
    "nylon": ("tone", "#8d8f93"),
}


def hex_to_linear(color):
    srgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]


def shape_body(body, weights):
    """Set the mannequin's measurement shape keys, refit the suit to it as MakeHuman does, then fold the
    shape into the mesh so everything after works on the shaped body."""
    names = load_targets(body)
    blocks = body.data.shape_keys.key_blocks
    for name in names:
        blocks[name].value = max(0.0, min(2.0, float(weights.get(name, 0))))
    HumanService.refit(body)
    TargetService.bake_targets(body)


def sized_coords(suit, jacket_gauge, trouser_gauge, body_world, ease):
    """The suit's vertices once each ease key is applied at its weight (cm grown in that place)."""
    base = local_coords(suit)
    jacket_ease = ease_keys(suit, jacket_gauge, body_world, jacket_gauge.measure(to_world(suit, base), body_world))
    trouser_ease = trouser_ease_keys(suit, trouser_gauge)
    coords = base.copy()
    for name, keyed in {**jacket_ease, **trouser_ease}.items():
        weight = float(ease.get(name, 0))
        if weight:
            coords += (keyed - base) * max(-20.0, min(30.0, weight))
    return coords


def casual_garment(body, body_gauge, body_world, style, ease, folder):
    """The casual jacket cut from the shaped body, sized by its ease keys and cut to length as the page does
    (see cutToLength in stage.js), with only its style's collar, and its details painted for that length.
    Returns the garment and its details texture."""
    jacket = CasualJacket(body, body_gauge)
    garment = jacket.build("jacket")
    gauge = CasualGauge(garment, body_gauge)
    base = local_coords(garment)
    built = gauge.measure(to_world(garment, base), body_world)
    coords = base.copy()
    for name, keyed in ease_keys(garment, gauge, body_world, built).items():
        weight = max(-20.0, min(30.0, float(ease.get(name, 0))))
        if weight and name != "ease-length":
            coords += (keyed - base) * weight
    if garment.data.shape_keys:
        garment.shape_key_clear()
    set_coords(garment, coords)
    length = min(max(built["length"] + float(ease.get("ease-length", 0)), 50), 80) / 100
    neckline = jacket.front_neckline()
    jacket.cut_to(length)
    piece = attribute(garment.data, "_piece")
    other = PARTS["point collar"] if COLLARS[style] == PARTS["stand"] else PARTS["stand"]
    delete_vertices(garment, piece == other)
    for poly in garment.data.polygons:
        poly.use_smooth = True
    details = os.path.join(folder, f"casual_{style}.png")
    paint_casual_details(jacket.layout, style, details, neckline, hem=jacket.back_neck - length)
    return garment, details


def set_coords(obj, coords):
    obj.data.vertices.foreach_set("co", coords.astype(np.float32).ravel())
    obj.data.update()


def mannequin(body, body_gauge, rig):
    """A display mannequin: no helper geometry, and a plain egg instead of MakeHuman's head."""
    coords = to_world(body, local_coords(body))
    neck = body_gauge.joint(coords, "joint-neck")
    keep = group_weights(body, lambda n: n == "body") > 0.5
    head = coords[:, 2] > neck[2] + 0.035
    skin = coords[keep & head]
    low, high = skin.min(axis=0), skin.max(axis=0)
    delete_vertices(body, ~keep | head)
    for modifier in [m for m in body.modifiers if m.type == "MASK"]:
        body.modifiers.remove(modifier)
    for poly in body.data.polygons:
        poly.use_smooth = True

    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=48, location=tuple((low + high) / 2))
    egg = bpy.context.active_object
    egg.scale = ((high - low)[0] / 2 * 0.92, (high - low)[1] / 2 * 0.92, (high - low)[2] / 2 * 0.98)
    bpy.ops.object.shade_smooth()
    world = egg.matrix_world.copy()
    egg.parent, egg.parent_type, egg.parent_bone = rig, "BONE", "head"
    egg.matrix_world = world
    return egg


def pose(rig, name):
    """Turn the rig's bones as public/models/poses.json says. The page's axes are glTF's (y up, facing +z);
    Blender's are z up, facing -y, so the page's z axis is Blender's -y."""
    data = json.load(open(os.path.join(ROOT, "public", "models", "poses.json")))
    turns = data["poses"].get(name, data["poses"]["standing"])["turns"]
    to_rig = rig.matrix_world.to_3x3().inverted()
    for bone_name, axis, angle in turns:
        bone = rig.pose.bones.get(bone_name)
        if bone is None:
            continue
        world_axis = Vector((1, 0, 0)) if axis == "x" else Vector((0, -1, 0))
        head = bone.head.copy()
        turn = Matrix.Translation(head) @ Matrix.Rotation(angle, 4, (to_rig @ world_axis).normalized()) @ Matrix.Translation(-head)
        bone.matrix = turn @ bone.matrix
        bpy.context.view_layer.update()
    fingers = data["fingers"]
    for side in "lr":
        for finger in fingers["bones"]:
            for joint, curl in fingers["curl"].items():
                bone = rig.pose.bones.get(f"{finger}_{joint}_{side}")
                if bone:
                    bone.rotation_mode = "XYZ"
                    bone.rotation_euler.x += curl
        thumb = rig.pose.bones.get(f"thumb_02_{side}")
        if thumb:
            thumb.rotation_mode = "XYZ"
            thumb.rotation_euler.x += fingers["thumb_02"]
    bpy.context.view_layer.update()


def push_out(obj, metres):
    """Start a garment a little further out, so layers never begin tangled."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * metres
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def shirt_mask(obj):
    """The shirt collar, cuffs and tie: light or coloured in the suit's texture."""
    image = bpy.data.images.load(asset("clothes", SUIT, f"{SUIT}_diffuse.png"), check_existing=True)
    w, h = image.size
    pixels = np.array(image.pixels[:]).reshape(h, w, 4)
    layer = obj.data.uv_layers.active.data
    uvs = np.zeros((len(obj.data.vertices), 2))
    for loop in obj.data.loops:
        uvs[loop.vertex_index] = layer[loop.index].uv
    rgb = pixels[np.clip((uvs[:, 1] * h).astype(int), 0, h - 1), np.clip((uvs[:, 0] * w).astype(int), 0, w - 1), :3]
    return (rgb.mean(axis=1) >= 0.3) | ((rgb.max(axis=1) - rgb.min(axis=1)) >= 0.08)


def make_cloth(obj, pin_top, colliders, fixed=None):
    """Wool cloth hanging from its top (collar, or waistband), pushed only by `colliders`. Vertices in
    `fixed` follow the skeleton instead of simulating."""
    z = to_world(obj, local_coords(obj))[:, 2]
    pin = obj.vertex_groups.new(name="pin")
    top = z.max()
    for i, height in enumerate(z):
        weight = 1.0 if fixed is not None and fixed[i] else max(0.0, 1 - (top - height) / pin_top)
        if weight > 0:
            pin.add([i], weight, "REPLACE")

    cloth = obj.modifiers.new("cloth", "CLOTH")
    settings = cloth.settings
    settings.quality = 8
    settings.mass = 0.35
    settings.tension_stiffness = settings.compression_stiffness = 80
    settings.shear_stiffness = 40
    settings.bending_stiffness = 8.0
    settings.air_damping = 2
    settings.vertex_group_mass = "pin"
    settings.pin_stiffness = 1
    collision = cloth.collision_settings
    collision.distance_min = 0.004
    collision.use_self_collision = False
    collision.collection = colliders
    cloth.point_cache.frame_start, cloth.point_cache.frame_end = 1, SETTLE_FRAMES

    obj.modifiers.new("collide", "COLLISION")   # so garments layered over this one can't pass through it
    obj.collision.thickness_outer = 0.003


def collection_of(name, objs):
    collection = bpy.data.collections.new(name)
    for obj in objs:
        collection.objects.link(obj)
    return collection


def cloth_material(name, color, fabric="wool"):
    """The suit's texture with its cloth (marked in alpha by the model build) dyed `color`, a fine wool
    weave, and sheen. Shirt, tie and buttons keep their own colours."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes["Principled BSDF"]
    roughness, sheen, weave_strength, coat = FABRICS.get(fabric, FABRICS["wool"])
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Sheen Weight"].default_value = sheen
    shader.inputs["Coat Weight"].default_value = coat

    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(os.path.join(ROOT, "public", "models", "textures", "suit.webp"), check_existing=True)
    texture.image.alpha_mode = "CHANNEL_PACKED"   # the shirt's colour is kept where alpha marks "not cloth"
    tint = nodes.new("ShaderNodeRGB")
    tint.outputs[0].default_value = (*hex_to_linear(color), 1)
    dyed = nodes.new("ShaderNodeMix")
    dyed.data_type, dyed.blend_type = "RGBA", "MULTIPLY"
    dyed.inputs["Factor"].default_value = 1
    links.new(texture.outputs["Color"], dyed.inputs[6])
    links.new(tint.outputs[0], dyed.inputs[7])
    pick = nodes.new("ShaderNodeMix")
    pick.data_type = "RGBA"
    links.new(texture.outputs["Alpha"], pick.inputs["Factor"])
    links.new(texture.outputs["Color"], pick.inputs[6])
    links.new(dyed.outputs[2], pick.inputs[7])
    links.new(pick.outputs[2], shader.inputs["Base Color"])

    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (WOOL_REPEAT, WOOL_REPEAT, 1)
    coords = nodes.new("ShaderNodeTexCoord")
    weave = nodes.new("ShaderNodeTexImage")
    weave.image = bpy.data.images.load(os.path.join(ROOT, "public", "models", "textures", "wool_normal.jpg"), check_existing=True)
    weave.image.colorspace_settings.name = "Non-Color"
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = weave_strength
    links.new(coords.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], weave.inputs["Vector"])
    links.new(weave.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return material


def casual_material(name, color, fabric, details_path):
    """The casual jacket's cloth in `color`, with its style's painted details coloured for the fabric: seams
    and shadows darken it, stitching and hardware take their own colours (see casualFabric in stage.js)."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes["Principled BSDF"]
    roughness, sheen, weave_strength, coat = FABRICS.get(fabric, FABRICS["wool"])
    thread, metal = TRIMS.get(fabric, TRIMS["wool"])
    shader.inputs["Sheen Weight"].default_value = sheen
    shader.inputs["Coat Weight"].default_value = coat

    details = nodes.new("ShaderNodeTexImage")
    details.image = bpy.data.images.load(details_path)
    details.image.colorspace_settings.name = "Non-Color"
    channels = nodes.new("ShaderNodeSeparateColor")
    links.new(details.outputs["Color"], channels.inputs["Color"])

    def rgb(hex_color):
        node = nodes.new("ShaderNodeRGB")
        node.outputs[0].default_value = (*hex_to_linear(hex_color), 1)
        return node.outputs[0]

    def mix(factor, a, b):
        node = nodes.new("ShaderNodeMix")
        node.data_type = "RGBA"
        links.new(factor, node.inputs["Factor"])
        links.new(a, node.inputs[6])
        links.new(b, node.inputs[7])
        return node.outputs[2]

    shade = nodes.new("ShaderNodeMath")
    shade.operation = "MULTIPLY"
    shade.inputs[1].default_value = 0.6
    links.new(channels.outputs["Red"], shade.inputs[0])
    cloth = mix(shade.outputs[0], rgb(color), rgb("#000000"))
    stitched = mix(channels.outputs["Green"], cloth, rgb(lighter(color) if thread == "tone" else thread))
    links.new(mix(channels.outputs["Blue"], stitched, rgb(metal)), shader.inputs["Base Color"])
    shiny = nodes.new("ShaderNodeMapRange")
    shiny.inputs["To Min"].default_value, shiny.inputs["To Max"].default_value = roughness, 0.3
    links.new(channels.outputs["Blue"], shiny.inputs["Value"])
    links.new(shiny.outputs["Result"], shader.inputs["Roughness"])

    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (WOOL_REPEAT, WOOL_REPEAT, 1)
    coords = nodes.new("ShaderNodeTexCoord")
    weave = nodes.new("ShaderNodeTexImage")
    weave.image = bpy.data.images.load(os.path.join(ROOT, "public", "models", "textures", "wool_normal.jpg"), check_existing=True)
    weave.image.colorspace_settings.name = "Non-Color"
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = weave_strength
    links.new(coords.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], weave.inputs["Vector"])
    links.new(weave.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return material


def lighter(color, amount=0.06):
    """The colour a shade lighter, as three.js's offsetHSL(0, 0, amount) makes it."""
    import colorsys
    r, g, b = (int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, min(1.0, l + amount), s)
    return "#" + "".join(f"{round(c * 255):02x}" for c in (r, g, b))


def plain_material(name, color, roughness):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Coat Weight"].default_value = 0.2
    return material


def studio(scene, height):
    """Soft studio light: the HDRI the page uses and a large key light from the front left, and a camera
    framing the whole figure like a lookbook photo, against a plain backdrop in the page's colour."""
    world = bpy.data.worlds.new("studio")
    scene.world = world
    world.use_nodes = True
    environment = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
    environment.image = bpy.data.images.load(os.path.join(ROOT, "public", "models", "studio.hdr"))
    nodes, links = world.node_tree.nodes, world.node_tree.links
    lighting = nodes["Background"]
    links.new(environment.outputs["Color"], lighting.inputs["Color"])
    lighting.inputs["Strength"].default_value = 0.8
    # The camera sees a plain backdrop in the page's colour; everything else is lit by the studio HDRI.
    backdrop = nodes.new("ShaderNodeBackground")
    backdrop.inputs["Color"].default_value = (*hex_to_linear("#eceef1"), 1)
    backdrop.inputs["Strength"].default_value = 1.35   # makes up for the render's lowered exposure
    camera_ray = nodes.new("ShaderNodeLightPath")
    choose = nodes.new("ShaderNodeMixShader")
    links.new(camera_ray.outputs["Is Camera Ray"], choose.inputs["Fac"])
    links.new(lighting.outputs["Background"], choose.inputs[1])
    links.new(backdrop.outputs["Background"], choose.inputs[2])
    links.new(choose.outputs["Shader"], nodes["World Output"].inputs["Surface"])

    key = bpy.data.lights.new("key", "AREA")
    key.energy, key.size = 160 * height ** 2, 3
    light = bpy.data.objects.new("key", key)
    scene.collection.objects.link(light)
    light.location = (-2.2 * height, -3.0 * height, 3.2 * height)
    light.rotation_euler = (Vector((0, 0, height * 0.55)) - light.location).to_track_quat("-Z", "Y").to_euler()


    camera = bpy.data.cameras.new("camera")
    camera.lens = 70
    view = bpy.data.objects.new("camera", camera)
    scene.collection.objects.link(view)
    scene.camera = view
    view.location = (0.5 * height, -2.4 * height, 0.56 * height)
    view.rotation_euler = (Vector((0, 0, height * 0.5)) - view.location).to_track_quat("-Z", "Y").to_euler()


def render(job):
    started = time.time()
    objects = build_human()
    body, suit = objects["body"], objects["suit"]
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    shape_body(body, job["body"])

    body_gauge = BodyGauge(body)
    body_world = to_world(body, local_coords(body))
    jacket_gauge = JacketGauge(suit, body_gauge)
    trouser_gauge = TrouserGauge(jacket_gauge)
    items = {item["kind"]: item for item in job["items"]}

    # Each item is the suit sized for it, then cut down to its own part; a casual jacket is cut from the body.
    garments = {}
    casual = None
    for kind in ("trousers", "jacket", "coat"):
        if kind not in items:
            continue
        style = items[kind].get("style", "tailored")
        if kind == "jacket" and style in COLLARS:
            casual, details = casual_garment(body, body_gauge, body_world, style, items[kind]["ease"],
                                             os.path.dirname(job["output"]))
            garments[kind] = casual
            continue
        copy = suit.copy()
        copy.data = suit.data.copy()
        bpy.context.collection.objects.link(copy)
        set_coords(copy, sized_coords(suit, jacket_gauge, trouser_gauge, body_world, items[kind]["ease"]))
        jacket_part, trouser_part = split_suit(copy, jacket_gauge)
        keep, drop = (trouser_part, jacket_part) if kind == "trousers" else (jacket_part, trouser_part)
        bpy.data.objects.remove(drop)
        keep.name = kind
        garments[kind] = keep
    bpy.data.objects.remove(suit)

    egg = mannequin(body, body_gauge, rig)
    rig.scale = (job["scale"],) * 3
    pose(rig, job.get("pose", "standing"))
    log("dressed", round(time.time() - started, 1))

    # Body first, then each layer collides with what's under it.
    body.modifiers.new("collide", "COLLISION")
    body.collision.thickness_outer = 0.006
    body.collision.cloth_friction = 5
    under = [body]
    for kind in ("trousers", "jacket", "coat"):
        if kind not in garments:
            continue
        garment = garments[kind]
        if kind != "trousers":
            push_out(garment, 0.004 if kind == "jacket" else 0.014)
        if garment is casual:
            # The casual jacket is built hanging as cloth does; simulated, it sags onto the body like wet
            # cloth. So it's posed as built, and only collides with what's worn over it.
            garment.modifiers.new("collide", "COLLISION")
            garment.collision.thickness_outer = 0.003
        else:
            make_cloth(garment, 0.05 if kind == "trousers" else 0.11, collection_of(f"{kind} colliders", list(under)),
                       None if kind == "trousers" else shirt_mask(garment))
        under.append(garment)

    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, SETTLE_FRAMES
    simulated = time.time()
    for frame in range(1, SETTLE_FRAMES + 1):
        scene.frame_set(frame)
    log("draped", round(time.time() - simulated, 1))

    white = plain_material("mannequin", (0.85, 0.84, 0.82), 0.45)
    for obj in (body, egg):
        obj.data.materials.clear()
        obj.data.materials.append(white)
    for kind, garment in garments.items():
        garment.data.materials.clear()
        item = items[kind]
        if garment is casual:
            garment.data.materials.append(casual_material(kind, item["color"], item.get("fabric", "wool"), details))
        else:
            garment.data.materials.append(cloth_material(kind, item["color"], item.get("fabric", "wool")))

    height = job["scale"] * 1.72
    studio(scene, height)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = max(16, min(256, int(job.get("samples", 64))))
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 1200
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = job["output"]
    rendered = time.time()
    bpy.ops.render.render(write_still=True)
    log("rendered", round(time.time() - rendered, 1), "total", round(time.time() - started, 1))


if __name__ == "__main__":
    render(json.load(open(sys.argv[sys.argv.index("--") + 1])))
