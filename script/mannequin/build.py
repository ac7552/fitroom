# Builds Fitroom's 3D model: a white display mannequin (a MakeHuman body; the page gives it a plain egg head) and a
# suit split into a jacket and trousers, with shape keys the browser uses to match someone's measurements and each jacket size.
#
# Run with Blender 5.2+ and the MPFB extension, with MakeHuman's CC0 system assets installed:
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --python script/mannequin/build.py -- public/models
#
# Writes:
#   mannequin.glb   meshes, rig and shape keys (no materials; the page builds those)
#   mannequin.json  what each shape key does to the body's and the jacket's measurements, in cm
#   textures/       a tintable suit texture and its baked ambient occlusion
#
# Shape keys:
#   measure-*-incr/decr  MakeHuman's measurement targets, on the body and (refitted) on everything it wears
#   ease-*               grow the jacket by 1 cm of chest, waist or shoulder width, or 1 cm longer sleeves or body,
#                        so the page can show any size's measurements on any body
#
# Every asset used is CC0 (see public/models/CREDITS.md).
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fitroom_model import *  # noqa: E402,F401,F403
from casual_jacket import STYLES, CasualGauge, CasualJacket, paint_casual_details  # noqa: E402

if __name__ == "__main__":
    os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)
    objects = build_human()
    body, suit = objects["body"], objects["suit"]
    names = load_targets(body)
    shapes = capture_worn_shapes(objects, names)

    body_gauge = BodyGauge(body)
    jacket_gauge = JacketGauge(suit, body_gauge)
    trouser_gauge = TrouserGauge(jacket_gauge)
    base_world = to_world(body, local_coords(body))
    suit_world = to_world(suit, local_coords(suit))
    suit_jacket = jacket_gauge.measure(suit_world, base_world)

    # The casual jacket is cut from the body, so it already has the body's measurement shape keys.
    casual_jacket = CasualJacket(body, body_gauge)
    casual = casual_jacket.build()
    casual_gauge = CasualGauge(casual, body_gauge)

    base = {
        "body": body_gauge.measure(base_world),
        "jacket": suit_jacket,
        "trousers": trouser_gauge.measure(suit_world),
        "casual": casual_gauge.measure(to_world(casual, local_coords(casual)), base_world),
    }
    measures = {"body": BODY_MEASURES, "jacket": JACKET_MEASURES, "trousers": TROUSER_MEASURES, "casual": JACKET_MEASURES}
    for layer, values in base.items():
        log(layer, {k: round(float(values[k]), 1) for k in measures[layer]})

    def measure_all(body_coords, suit_coords, casual_coords):
        return {"body": body_gauge.measure(body_coords), "jacket": jacket_gauge.measure(suit_coords, body_coords),
                "trousers": trouser_gauge.measure(suit_coords), "casual": casual_gauge.measure(casual_coords, body_coords)}

    calibration = {}
    for name in names:
        now = measure_all(to_world(body, key_coords(body, name)), to_world(suit, shapes[name]["suit"]),
                          to_world(casual, key_coords(casual, name)))
        calibration[name] = {layer: {k: round(float(now[layer][k] - base[layer][k]), 3) for k in measures[layer]}
                             for layer in measures}
        log(name, calibration[name])

    jacket_ease = ease_keys(suit, jacket_gauge, base_world, base["jacket"])
    trouser_ease = trouser_ease_keys(suit, trouser_gauge)
    casual_ease = ease_keys(casual, casual_gauge, base_world, base["casual"])
    add_shape_keys(suit, {name: shapes[name]["suit"] for name in names})
    add_shape_keys(suit, {**jacket_ease, **trouser_ease})
    add_shape_keys(casual, casual_ease)

    # Check the ease keys do what they say: each should add about 1 cm to its own measurement.
    suit_coords, casual_coords = to_world(suit, local_coords(suit)), to_world(casual, local_coords(casual))
    ease_check, casual_check = {}, {}
    for name, coords in {**jacket_ease, **trouser_ease}.items():
        now = measure_all(base_world, to_world(suit, coords), casual_coords)
        layer = "jacket" if name in jacket_ease else "trousers"
        ease_check[name] = {k: round(float(now[layer][k] - base[layer][k]), 3) for k in measures[layer]}
    for name, coords in casual_ease.items():
        now = measure_all(base_world, suit_coords, to_world(casual, coords))
        casual_check[name] = {k: round(float(now["casual"][k] - base["casual"][k]), 3) for k in JACKET_MEASURES}
    log("ease check", ease_check, casual_check)

    jacket, trousers = split_suit(suit, jacket_gauge)
    neckline = casual_jacket.front_neckline()
    casual_jacket.finish()
    objects = {"body": body, "jacket": jacket, "trousers": trousers, "casual": casual}
    cover = body.data.attributes.new(name="_cover_casual", type="FLOAT", domain="POINT")
    cover.data.foreach_set("value", casual_jacket.body_cover().astype(np.float32))
    head = mark_covered_body(body, body_gauge, base_world)
    # The cloth gets one level of smoothing; the matte white body is smooth enough as it is.
    for obj in (jacket, trousers, casual):
        subdivide_with_shape_keys(obj)
        log("smoothed", obj.name, len(obj.data.vertices), "vertices")
    for poly in body.data.polygons:
        poly.use_smooth = True

    textures = {
        "suit": save_texture(asset("clothes", SUIT, f"{SUIT}_diffuse.png"), "suit", 2048, fabric=True),
        "suit_ao": bake_ambient_occlusion([jacket, trousers]),
    }
    for style in STYLES:
        paint_casual_details(casual_jacket.layout, style, os.path.join(OUT, "textures", f"casual_{style}.png"), neckline)
        textures[f"casual_{style}"] = f"textures/casual_{style}.png"

    export(objects)
    export_hero_jacket(jacket)
    with open(os.path.join(OUT, "mannequin.json"), "w") as f:
        json.dump({
            "units": "cm",
            **{layer: {k: round(float(base[layer][k]), 2) for k in (("height",) if layer == "body" else ()) + measures[layer]}
               for layer in measures},
            "head": head,
            "targets": calibration,
            "ease_check": ease_check,
            "ease_check_casual": casual_check,
            "textures": textures,
        }, f, indent=2)
    log("wrote", OUT)
