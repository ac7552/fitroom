# Drafts a garment's sewing pattern from one size's chart measurements, with GarmentCode
# (https://github.com/maria-korosteleva/GarmentCode, MIT), for script/garments/drape.py to sew onto the
# mannequin. Runs outside Blender, in a Python with GarmentCode's dependencies (numpy < 2):
#
#   GARMENTCODE=~/projects/fitroom-assets/GarmentCode python3.11 script/garments/pattern.py job.json out.json
#
# job.json:
#   style    "zip" | "bomber" | "shirt" | "hooded"
#   size     the chart's garment measurements in cm: chest, sleeve, length (shoulders, waist optional)
#   body     the mannequin's measurements in cm: height, chest, waist, hips, arm (see public/models/mannequin.json)
#   spacing  cm between points along each edge (the cloth's resolution)
#
# out.json: each panel's outline as points in cm (edge by edge, so sewn edges have matching counts), its
# placement around the body (GarmentCode's: y up, z towards the front, cm), and which edges are sewn
# to which.
import json
import math
import os
import sys

import numpy as np
import yaml

GARMENTCODE = os.path.expanduser(os.environ.get("GARMENTCODE", "~/projects/fitroom-assets/GarmentCode"))
sys.path.insert(0, GARMENTCODE)

from assets.bodies.body_params import BodyParameters  # noqa: E402
from assets.garment_programs.meta_garment import MetaGarment  # noqa: E402

# GarmentCode's average man, whose proportions fill in what Fitroom doesn't measure (neck, armhole depth,
# shoulder slope and the like); his height, chest, waist, hips and arms are replaced by the mannequin's.
REFERENCE_BODY = os.path.join(GARMENTCODE, "assets", "bodies", "mean_male.yaml")
LENGTHS = ["head_l", "waist_line", "hips_line", "bust_line", "vert_bust_line", "waist_over_bust_line",
           "armscye_depth", "neck_w", "shoulder_w", "back_width", "waist_back_width", "hip_back_width",
           "bust_points", "bum_points", "crotch_hip_diff", "leg_circ", "wrist"]
ARM_POSE_ANGLE = 46.8   # degrees below horizontal of the mannequin's arms at rest (script/mannequin)


def body_params(body, folder):
    with open(REFERENCE_BODY) as f:
        params = yaml.safe_load(f)["body"]
    scale = body["height"] / params["height"]
    for key in LENGTHS:
        params[key] *= scale
    params["back_width"] *= body["chest"] / (params["bust"] * scale)
    params.update(height=body["height"], bust=body["chest"], underbust=body["chest"] * 0.9, waist=body["waist"],
                  hips=body["hips"], arm_length=body["arm"] * 0.96, arm_pose_angle=ARM_POSE_ANGLE)
    path = os.path.join(folder, "body.yaml")
    with open(path, "w") as f:
        yaml.safe_dump({"body": params}, f)
    return BodyParameters(path)


def design_for(style, size, body):
    with open(os.path.join(GARMENTCODE, "assets", "design_params", "default.yaml")) as f:
        design = yaml.safe_load(f)["design"]

    def put(path, value):
        node = design
        for key in path.split("."):
            node = node[key]
        node["v"] = value

    put("meta.upper", "Shirt")
    put("meta.wb", "StraightWB" if style in ("bomber", "shirt") else None)
    put("meta.bottom", None)
    put("shirt.strapless", False)
    put("shirt.width", size["chest"] / body["bust"])
    put("shirt.flare", 1.0)
    # The back length runs from the collar seam to the hem; GarmentCode's from the neck point.
    band = 4.5 if style in ("bomber", "shirt") else 0
    put("shirt.length", max(0.5, (size["length"] - band) / body["waist_line"]))
    put("waistband.width", band / body["waist_line"] if band else 0.2)
    put("waistband.waist", size["chest"] * (0.9 if style == "bomber" else 1.0) / body["waist"])
    put("sleeve.sleeveless", False)
    put("sleeve.armhole_shape", "ArmholeCurve")
    put("sleeve.length", min(1.15, size["sleeve"] / body["arm_length"]))
    put("sleeve.end_width", 0.85 if style == "bomber" else 1.0)
    put("sleeve.connecting_width", 0.15)
    put("sleeve.sleeve_angle", 10)
    put("sleeve.cuff.type", "CuffBand" if style in ("bomber", "shirt") else None)
    put("sleeve.cuff.cuff_len", 0.08)
    put("collar.f_collar", "CircleNeckHalf")
    put("collar.b_collar", "CircleNeckHalf")
    put("collar.width", 0.15)
    put("collar.fc_depth", 0.12 if style in ("zip", "bomber") else 0.45)
    put("collar.bc_depth", 0.0)
    collar = {"zip": "Turtle", "bomber": "Turtle", "shirt": "SimpleLapel", "hooded": "Hood2Panels"}[style]
    put("collar.component.style", collar)
    put("collar.component.depth", 7 if style in ("zip", "bomber") else 5)
    put("collar.component.lapel_standing", False)
    return design


def sample_edge(pattern, vertices, edge, count):
    """`count` points along the edge, evenly spaced along its length, ends included."""
    curve = pattern._edge_as_curve(vertices, edge)
    t = np.linspace(0, 1, 200)
    dense = np.array([[curve.point(x).real, curve.point(x).imag] for x in t])
    along = np.r_[0, np.cumsum(np.linalg.norm(np.diff(dense, axis=0), axis=1))]
    targets = np.linspace(0, along[-1], count)
    return np.c_[np.interp(targets, along, dense[:, 0]), np.interp(targets, along, dense[:, 1])], along[-1]


def flatten(pattern, spacing):
    spec = pattern.pattern
    panels = spec["panels"]
    lengths = {}
    for name, panel in panels.items():
        for i, edge in enumerate(panel["edges"]):
            lengths[name, i] = sample_edge(pattern, panel["vertices"], edge, 2)[1]
    counts = {key: max(2, math.ceil(length / spacing) + 1) for key, length in lengths.items()}
    stitches = []
    for pair in spec["stitches"]:
        (a, b) = [(side["panel"], side["edge"]) for side in pair[:2]]
        n = max(counts[a], counts[b])
        counts[a] = counts[b] = n
        # GarmentCode joins the end of the first edge to the start of the second, unless marked
        # "right_wrong" (then start to start).
        reverse = not (len(pair) == 3 and pair[2] == "right_wrong")
        stitches.append([{"panel": a[0], "edge": a[1]}, {"panel": b[0], "edge": b[1]}, {"reverse": reverse}])

    out = {}
    for name, panel in panels.items():
        rotation = np.array(np.deg2rad(panel["rotation"]))
        cx, cy, cz = np.cos(rotation)
        sx, sy, sz = np.sin(rotation)
        # Maya's intrinsic XYZ: Rz @ Ry @ Rx, as GarmentCode uses.
        rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
        ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
        rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
        edges = []
        for i, edge in enumerate(panel["edges"]):
            points, _ = sample_edge(pattern, panel["vertices"], edge, counts[name, i])
            edges.append(points.round(4).tolist())
        out[name] = {"edges": edges, "rotation": (rz @ ry @ rx).round(6).tolist(), "translation": panel["translation"],
                     "label": panel.get("label", "")}
    return {"panels": out, "stitches": stitches, "units": "cm"}


def main(job_path, out_path):
    with open(job_path) as f:
        job = json.load(f)
    folder = os.path.dirname(os.path.abspath(out_path))
    body = body_params(job["body"], folder)
    design = design_for(job["style"], job["size"], body)
    garment = MetaGarment("fitroom", body, design)
    pattern = garment.assembly()
    with open(out_path, "w") as f:
        json.dump(flatten(pattern, job.get("spacing", 1.5)), f)
    print(f"[pattern] {len(pattern.pattern['panels'])} panels, {len(pattern.pattern['stitches'])} seams -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
