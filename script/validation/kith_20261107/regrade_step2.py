"""The runs rendered again after step 2 (read the parts: graphics laid whole, hoods, necklines and collars),
graded by eye against their step 1 sheets the same way (README.md's grades and tags), and the whole sample's
grades with them: grades_step2.csv. The 48 runs are runs_step2.json's; every other run's parts were read as
before, so its grade stands.

    python3 script/validation/kith_20261107/regrade_step2.py && python3 script/validation/kith_20261107/tally.py script/validation/kith_20261107/grades_step2.csv

Swirls and streaks on plain cloth, plaids and colour blocks are step 4's and are tagged as before. A hoodie's
cords are laid on with the photo: paintCords now finds them either side of a zip, but where they were stays
visible in the relief (an outline, a smudge), so CORD stays tagged, for step 7.

The shirts and polos are graded from their renders after the collar fixes that followed the 48-run render
(the collar band plain on an all-over print too, a collar's inside at a hood's shade, the back of the neck in
the collar strip taking the collar's colour); the polo collar's leaf still doesn't read, carried to step 7.
"""
import csv
import json
from pathlib import Path

HERE = Path(__file__).parent
REGRADED = {
    # key: (grade, tags, note)
    # Prints (the P-stretch, P-hood and P-lost tops).
    "m_sweat:khm034263-413": ("fail", "SWIRL", "no hood now; NY laid whole; the cream yoke and blue bands swirled (colour blocks, step 4)"),
    "w_hoodie:khwa030159-001": ("minor", "HOOD", "label at its size; the hood shows from behind only (raglan; flat from the front and side)"),
    "user:khmg030334-104": ("fail", "P-stretch;SWIRL", "no plaid lining on the chest; hood shows; the horses smeared over the front"),
    "user:rhufw26ho03012-8611": ("ok", "", "print laid whole, a little larger than the photo's (the chart's size); hood shows"),
    "m_hoodie:esss26ho02012-6236": ("minor", "SHADE;LEN", "no hood outline on the chest; grey, not brown; streaks; long"),
    "m_hoodie:h011-99-yel": ("ok", "", "VOWELS laid whole on the chest"),
    "m_hoodie:wos-nt02-02b": ("minor", "SHADE", "the graphic laid whole; sleeve prints kept"),
    "m_hoodie:ess192as266991f-103": ("ok", "", "FOG lettering laid whole"),
    "m_sweat:ess192nb256401f-blk": ("ok", "", "NBA laid whole, in proportion"),
    "m_sweat:feafg9m12-9938bhf": ("minor", "HEM;SHADE", "as before"),
    "m_sweat:h081-99": ("minor", "SHADE;HEM", "no hood streaks on the chest; tonal print laid"),
    "m_sweat:khm032865-001": ("minor", "SHADE", "Ivy logo laid whole at the chest"),
    "m_sweat:prm2918-t-005-lss": ("fail", "COLOR;SWIRL", "print laid whole; the grey diagonal half drawn blue (colour by part, step 6)"),
    "w_hoodie:khwa030102-2023": ("minor", "SWIRL", "crest laid; no hood outline on the chest; the hood's shadow on the back"),
    "w_hoodie:khwa030170-211": ("ok", "", "KITH laid whole"),
    "m_hoodie:acnci0211-ack": ("minor", "SHADE;CORD", "logo laid; the cord loop painted out but a smudge where it was; streaks"),
    "m_hoodie:awafw26-hd003-blk": ("minor", "CORD;P-lost;HEM", "white cord loops gone, their outline left; blue label lost"),
    "w_tee:rd024-02wcgt428": ("fail", "P-lost;COLOR", "as before (no reading on a light backdrop: segmentation)"),
    # Parts (hood, collar and neck runs).
    "m_knit:khm033366-002": ("fail", "COLLAR;SWIRL;KNIT", "band grey, not the hanger's black, but the leaf doesn't read: still a crew; cables swirled"),
    "m_tee:khm035074-101": ("minor", "COLLAR;SHADE", "no hanger ring; band light grey; the leaf faint"),
    "m_hoodie:arcx000010726-black": ("minor", "SEAM;HEM", "hood shows from the side and behind"),
    "w_hoodie:esfw26ho03012-sun": ("fail", "SWIRL;SHADE", "hood in its own colour now; swirls as before"),
    "m_hoodie:casm-aw26-jtp-292-02": ("minor", "SHADE", "hood in its colour; patch laid whole"),
    "m_shirt:ourm2262erc": ("ok", "", "collar shows; plaid good"),
    "m_shirt:khma030081-4042": ("minor", "SWIRL", "collar shows; no dark patch at the neck now; plaid swirled on the chest"),
    "m_shirt:m206t711ast": ("minor", "SWIRL", "camp collar shows"),
    "m_knit:dai2610166-blk": ("minor", "HEM", "crew neck; sticker laid whole"),
    "m_knit:cpc20cmkn117a-yellow": ("minor", "P-lost", "crew neck; the lens badge on the sleeve no longer drawn (its first run since step 1 brought in the back photo)"),
    "m_knit:mrncvmg0157q0-mxv66": ("ok", "", "V-neck drawn"),
    "m_sweat:khma030297-001": ("ok", "", "turtleneck drawn"),
    "m_jacket:khma010168-151": ("fail", "SWIRL;KIND;HOOD", "as before: the hood its words name (packed in the collar) still drawn out"),
    "m_denim:khma010173-416": ("minor", "SHADE", "no hood; collar stripe shows; streaks"),
    # Print controls and controls: as before.
    "w_tee:ms-tee-ja": ("ok", "", "control: as before"),
    "m_tee:awafw26-ts004-blk": ("ok", "", "control: as before"),
    "m_tee:cohbu-m26388-tiq": ("ok", "", "control: as before"),
    "m_tee:es125ho254191f": ("ok", "SEAM", "control: as before"),
    "m_tee:khta030070-001": ("ok", "", "control: as before"),
    "m_tee:rhupf26tt01012-6498": ("ok", "SHADE", "control: as before"),
    "m_tee:y5-t23l27-007": ("ok", "", "control: front print now laid in place"),
    "w_tee:khwg030002-001": ("ok", "", "control: Kith script laid over the bust, in proportion"),
    "m_denim:acnb00363-900": ("ok", "", "control: as before"),
    "m_denim:apcwvbek-h09248": ("ok", "", "control: as before"),
    "w_dress:amfw2608": ("ok", "", "control: as before"),
    "w_dress:pdch-su26-5032-0156": ("ok", "", "control: as before"),
    "m_sweat:56200012s0060-v0029": ("ok", "", "control: as before"),
    "m_sweat:dai2610117-gry": ("ok", "", "control: as before"),
    "w_outer:nf0a3xeo-gof": ("ok", "", "control: as before"),
    "w_tee:dia257560qjcg": ("ok", "", "control: as before"),
}
runs = json.load(open(HERE / "runs_step2.json"))
listed = {k for part in ("prints", "parts", "print_controls", "controls") for k in runs[part]}
assert listed == set(REGRADED), (listed ^ set(REGRADED))
rows = list(csv.DictReader(open(HERE / "grades_step1.csv")))
keys = {r["key"] for r in rows}
missing = [k for k in REGRADED if k not in keys]
assert not missing, missing
out = []
for r in rows:
    # (A note with a comma in it, unquoted, runs on into more columns.)
    if None in r:
        r["note"] = ",".join([r["note"], *r.pop(None)])
    key = r["key"]
    if key in REGRADED:
        grade, tags, note = REGRADED[key]
        r = {"key": key, "grade": grade, "tags": tags, "note": f"step 2: {note}"}
    out.append(r)
with open(HERE / "grades_step2.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["key", "grade", "tags", "note"])
    w.writeheader()
    w.writerows(out)
print(f"{len(out)} rows, {len(REGRADED)} graded again")
