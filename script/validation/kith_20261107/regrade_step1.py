"""The runs rendered again after step 1 (pick the right photo), graded by eye against their baseline sheets the
same way (README.md's grades and tags), and the whole sample's grades with them: grades_step1.csv. Every
other run's photos were chosen as before, so its grade stands.

    python3 script/validation/kith_20261107/regrade_step1.py && python3 script/validation/kith_20261107/tally.py script/validation/kith_20261107/grades_step1.csv

The back of a garment with only a front photo (drawn plain, pale or blurred: BACKWARP on single-photo
dresses, skirts and shorts) is how the front's cloth is laid on the back, not which photo was chosen: those
are tagged SHADE now, for step 4. A back laid from the right photo but warped is STRIPE or SHADE, likewise.
"""
import csv
from pathlib import Path

HERE = Path(__file__).parent
REGRADED = {
    # key: (grade, tags, note)
    "m_tee:casm-aw26-jts-102-01": ("minor", "HEM", "front now the printed front (was the back photo); back plain from its own photo"),
    "m_tee:ee125bt232002f-silv": ("fail", "COLOR;LEN;SHADE", "back from its back photo, warped; peach; dress length"),
    "m_tee:26ss-04-03-grn": ("minor", "STRIPE", "back from its back photo; stripes warped"),
    "m_tee:khm035141-906": ("minor", "SHADE", "3-pack: the white tee in front, alone; reads as one tee"),
    "m_sweat:khm034249-413": ("minor", "SHADE", "flat front; oval Knicks logo on the back from the hanger back photo"),
    "m_knit:khm034249-413": ("minor", "SHADE", "as m_sweat: flat front, right back"),
    "m_sweat:khma030297-001": ("minor", "NECK", "imports now (turtleneck); black knit, neck reads as a mock neck"),
    "m_sweat:khm034263-413": ("fail", "SWIRL;HOOD;P-stretch", "flat front now; NY print smeared; hood drawn on a crewneck"),
    "m_shirt:m206t711ast": ("minor", "COLLAR", "imports; camp collar lost"),
    "m_shirt:acnbb0707-ao0": ("minor", "COLLAR", "back from its back photo (horse print is real); camp collar lost"),
    "m_shirt:khma030081-4042": ("minor", "COLLAR", "flat front now: plaid reads; collar lost"),
    "m_shirt:261cwdt-shm02-bl": ("fail", "COLLAR;SHADE", "back from its back photo now; collar lost; streaks"),
    "m_shirt:lev004tl-0000": ("minor", "COLLAR", "imports; western yoke reads; collar band only"),
    "m_shirt:lev006uu-0000": ("minor", "COLLAR;SHADE", "imports"),
    "m_knit:khma030310-620": ("fail", "KIND;NECK", "flat front now; crossover V lost, drawn round-necked"),
    "m_jacket:khma010253-001": ("fail", "KIND", "flat front now, no hood; vest still drawn with sleeves"),
    "m_jacket:khma030266-211": ("minor", "SHADE", "flat front now: corduroy jacket reads; light streaks"),
    "m_jacket:khma010118-350": ("minor", "COLLAR", "flat front now: cropped trench reads; lapels flat"),
    "m_coat:khma010173-416": ("fail", "HOOD", "flat front now; a hood drawn that the jacket hasn't (from the words)"),
    "m_coat:khma010074-416": ("minor", "SHADE", "flat front now: no red shirt or hands, no hood"),
    "m_coat:khma010126-104": ("fail", "P-lost;COLOR", "back from the hanger back photo now (Kith script, stars); sleeve colours off"),
    "m_coat:khma010120-413": ("minor", "SHADE", "flat front now: no hands"),
    "m_pants:kikkkaw26t10-21": ("ok", "", "flat front now"),
    "m_pants:khma060146-199": ("minor", "HANGER;B-shape", "back from its back photo: red stripes gone; hanger mark at the waist"),
    "m_denim:khma030089-416": ("minor", "SHADE", "flat front now: no hood"),
    "m_denim:khma010173-416": ("fail", "HOOD", "flat front now; a hood drawn that the jacket hasn't (from the words)"),
    "m_denim:apcwvbek-h09248": ("ok", "", "flat front now: no enlarged rivets"),
    "m_denim:khma010146-2024": ("minor", "SHADE", "flat front now: no skin, no hood"),
    "m_denim:lev0033v-0006": ("minor", "SHADE", "no back photo used (the detail crop was): back plain denim"),
    "w_hoodie:aw1cc4262803-041f": ("minor", "HOOD;SHADE", "single photo; fur hood lost; back blotchy"),
    "w_dress:mimc25sg04-sm9x2": ("fail", "KIND;SHADE", "single photo; jumpsuit as dress over trousers; back pale"),
    "w_dress:at260wca00418": ("fail", "P-lost;SHADE;KIND", "single photo; sash lost; back plain black"),
    "w_dress:aw1cc3266080-001": ("minor", "SWIRL;SHADE", "single photo; crystals swirled; back plain"),
    "w_outer:khwa030076-001": ("fail", "TAILOR;LEN", "flat front chosen; still drawn from the suit model with shirt and tie"),
    "w_outer:khw010358-601": ("minor", "SHADE", "flat front now: no jeans or skin; cropped length right"),
    "w_outer:khwa370081-001": ("minor", "COLLAR", "flat front now; shearling collar lost"),
    "w_pants:khwa060093-001": ("minor", "B-shape;P-lost", "as before"),
    "w_skirt:arpf263033k10151004": ("minor", "SHADE", "single photo; back blurred"),
    "w_skirt:osldgf268-lilorg": ("ok", "SHADE", "single photo; good front, back mottled"),
    "w_skirt:dgp26324w159-100": ("minor", "SWIRL;HEM", "as before (its second photo no longer laid on the back: outline didn't match)"),
    "w_shorts:ebw4403camks-bps": ("ok", "", "flat front now; back from its back photo"),
    "w_shorts:bebound830vsk": ("minor", "STRIPE;SHADE", "single photo; back plain"),
    "fm_sneaker:nikiq7128-003": ("fail", "S-front;S-blob", "a shoe now (was read as a garment): heel view laid on the back; front still a blob"),
    "fm_sneaker:dm31816001": ("minor", "S-front;S-streak", "as before"),
    "fw_sneaker:s58ws0109p1895t6253": ("fail", "S-blob;S-parts", "no side photo taken (its only side is tilted on its toe): plain generic shoe"),
    "fw_sneaker:aakj5249": ("minor", "S-front;S-hole", "as before"),
    "fw_sneaker:dm43402001": ("minor", "S-front", "as before"),
    "fw_heel:cmk201998-003": ("ok", "", "as before"),
    "fw_heel:febond-taupe": ("fail", "S-blob;S-tear;S-back", "as before"),
    "fw_heel:femaeve-mocha": ("minor", "S-tear", "slightly cleaner straps"),
    "fw_heel:repv511ve-410": ("minor", "S-front;S-streak", "as before"),
    "fw_heel:diy03366pr617h1940": ("minor", "S-back;S-streak", "as before"),
    "fw_heel:jchj000183901": ("fail", "S-open;S-tear;S-heel;S-washout", "as before"),
    "fw_heel:ptpx1854-xptac-black": ("minor", "S-tear;S-front;S-back", "heel view now laid on the back: red sole shows through the heel"),
    "fw_heel:saf868ssn-chi": ("fail", "S-open;S-tear;S-heel", "zebra print reads better; still lumpy"),
    "fw_sandal:bsjeli-bupi": ("fail", "S-blob;S-open", "no wrong photo now (the crop is refused); its side too thin to outline: generic shoe"),
    "fw_sandal:s66wp0126p7706hb495": ("minor", "S-open;S-tear", "its side photo now (was the three-quarter pair): reads as the slingback"),
    "fw_flat:mngwf23f010mh": ("minor", "S-front", "as before"),
    "fw_flat:aakj5248": ("minor", "S-front;S-back", "as before"),
    "fw_flat:ug1178111-san": ("minor", "S-washout", "its side photo now (was the sole): shearling collar, no tread on the upper"),
    "fw_flat:s59wz0092p7561t8013": ("minor", "S-front;S-heel", "as before"),
    "fw_flat:ug1178450-blk": ("minor", "S-back;S-washout", "as before"),
    "fw_flat:s58wz0127p3753t4091": ("minor", "S-front;S-tabi", "as before"),
    "fw_flat:tab240-blk": ("ok", "", "as before"),
    "fw_flat:repv4210gmesh-410": ("minor", "S-front", "as before"),
    # Controls: photos chosen as before.
    "w_skirt:slr26s076-f198": ("ok", "", "control: as before"),
    "fm_sneaker:nwbmsnb130n": ("minor", "S-front;S-back", "control: as before"),
    "m_hoodie:wos-nt02-02b": ("fail", "P-stretch;P-lost", "control: as before"),
    "m_coat:ricru02f4986-49": ("minor", "SLEEVE;COLLAR", "control: as before"),
    "w_dress:khwa080073-624": ("minor", "NECK;B-shape", "control: as before"),
    "m_shorts:amss26sh01112c926": ("ok", "", "control: as before"),
    "m_shorts:essrw00261-0131": ("ok", "", "control: as before"),
    "m_sweat:55100038s01ff-v002e": ("minor", "HEM;COLLAR", "control: as before"),
    "m_sweat:feafg9m12-9938bhf": ("minor", "P-stretch;HEM;SHADE", "control: as before"),
    "m_coat:engsw245-ct300": ("fail", "LEN;SWIRL;P-stretch", "control: as before (back now has the print)"),
    "m_denim:khma010084-6024": ("minor", "COLLAR", "control: as before"),
    "w_shorts:bucir25-bt9": ("ok", "", "control: as before"),
}
rows = list(csv.DictReader(open(HERE / "grades.csv")))
keys = {r["key"] for r in rows}
missing = [k for k in REGRADED if k not in keys]
assert not missing, missing
out = []
for r in rows:
    # (A note with a comma in it, unquoted, runs on into more columns.)
    if None in r:
        r["note"] = ",".join([r["note"], *r.pop(None)])
    key = r["key"]
    # The rows the import fix let a second run grade ("…#2") are the same listing, now graded once.
    if key.endswith("#2") and key[:-2] in REGRADED:
        continue
    if key in REGRADED:
        grade, tags, note = REGRADED[key]
        r = {"key": key, "grade": grade, "tags": tags, "note": f"step 1: {note}"}
    out.append(r)
with open(HERE / "grades_step1.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["key", "grade", "tags", "note"])
    w.writeheader()
    w.writerows(out)
print(f"{len(out)} rows, {len(REGRADED)} graded again")
