require "test_helper"

# Seven real listings (Kith's, October 2026): what each dress is, read from its name, category and description.
class DressCutTest < ActiveSupport::TestCase
  LISTINGS = {
    desma: [ "Kith Women Desma Suiting Dress - Black", "Mini Dresses",
             "Stretch nylon blend Straight neckline Princess seams Belt at the waist Form-fitting silhouette Material: 75% Nylon / 25% Elastane" ],
    saja: [ "Kith Women Saja Strapless Faux Leather Mini Dress - Black", "Mini Dresses",
            "Faux leather Strapless construction Boning details at the seams Form-fitting silhouette" ],
    wang: [ "Alexander Wang Leather Dress with Faux Fur Bodice - Black", "Mini Dresses",
            "Leather Wide straps Scoop neck Darts on the front and back Slim fit Material: Body Face: 100% Leather" ],
    mireli: [ "SIR Mireli Slip Dress - Rose Parquet", "Mini Dresses",
              "Printed polyester blend Contrast trims Thin straps Plunging neck Open back Mini fit Material: 65% Polyester / 35% Silk" ],
    cyrielle: [ "GUIZIO Cyrielle Dress - Sweet Peach", "Mini Dresses",
                "Lightweight chiffon polyester Sculpted one shoulder neckline Integrated high neck scarf Draped sash self-tie closure on hip Fitted silhouette Mini length" ],
    zair: [ "Aya Muse Zair Layered Gown - Caramel", "Maxi Dresses",
            "Lyocell blend Adjustable straps on the front Cutouts on the shoulder Raw sleeve cuffs Sweetheart neck Flared hem Maxi fit Material: 90% Lyocell / 10% Silk" ],
    devin: [ "Ksubi Devin Long Sleeve Shirtdress - Stone Lurex", "Mini Dresses",
             "Knitted viscose blend Semi-sheer Classic collar Button closure on the front and sleeve cuffs Slim fit Material: 75% Viscose / 20% Lurex / 5% Nylon" ]
  }.freeze

  def cut(key)
    name, category, description = LISTINGS.fetch(key)
    GarmentImport::DressCut.read({ name:, category:, description: })
  end

  test "each dress's sleeves, neckline, length, fit and cloth" do
    # A suiting holds its shape, stretch or not.
    assert_equal [ "none", "straight", "mini", "fitted", true, "structured" ], cut(:desma).values_at(:sleeves, :neckline, :length, :fit, :stretch, :fabric)
    assert_equal [ "strapless", "mini", "fitted", "leather" ], cut(:saja).values_at(:sleeves, :length, :fit, :fabric)
    assert_equal [ "straps", "scoop", "slim", "leather" ], cut(:wang).values_at(:sleeves, :neckline, :fit, :fabric)
    assert_equal [ "thin_straps", "plunge", "silk", true ], cut(:mireli).values_at(:sleeves, :neckline, :fabric, :printed)
    assert_equal [ "one_shoulder", "silk", false ], cut(:cyrielle).values_at(:sleeves, :fabric, :printed)
    assert_includes cut(:cyrielle)[:details], "tie"
    # Knitted viscose is a knit, not a silky woven.
    assert_equal [ "long", true, "jersey", "semi", true ], cut(:devin).values_at(:sleeves, :stretch, :fabric, :sheer_kind, :collar)
    refute cut(:zair)[:collar]
    deba = GarmentImport::DressCut.read({ name: "Peachy Den Deba Midi Skirt - Pistachio", category: "Maxi Skirts", description: "Nylon Flared construction Relaxed fit" })
    assert_equal "midi", deba[:length], "its own name, before the shop's category"
    natalia = GarmentImport::DressCut.read({ name: "Asta Resort Natlaia Dress - Azaelia Sequin Pink", category: "Maxi Dresses", description: "Lustrous knit woven fabric All-over sequins Frayed hem Mini length" })
    assert_equal "mini", natalia[:length], "its description's length, before the shop's category"
  end

  test "the cloth is what most of it is: a little silk doesn't make it silk, a little polyurethane doesn't make it leather" do
    mela = GarmentImport::DressCut.read({ name: "Aya Muse Mela Mini Dress - Forest", category: "Mini Dresses",
                                          description: "Viscose blend Ruffled artwork on the straps and neck Plunging neck Lace-up closure on the front Ruffled hem Slim fit",
                                          fabric: "Main: 77% Viscose / 15% Nylon / 8% Silk / Contrast Body: 58% Rayon / 42% Cupro" })
    assert_equal({ "viscose" => 77.0, "nylon" => 15.0, "silk" => 8.0 }, GarmentImport::DressCut.fibre_shares("Main: 77% Viscose / 15% Nylon / 8% Silk / Contrast Body: 58% Rayon / 42% Cupro"))
    assert_equal "silk", mela[:fabric], "a viscose hangs like silk: from its viscose, not its 8% silk"
    celeste = GarmentImport::DressCut.read({ name: "Kith Women Celeste Micro Wrap Skirt - Black", category: "Mini Skirts",
                                             description: "Polyester blend Mid-rise waistband Wrap overlay on the front", fabric: "45% Polyester / 35% Viscose / 15% PC / 5% Polyurethane" })
    assert_equal [ true, "stretch" ], celeste.values_at(:stretch, :fabric)
    assert_equal "leather", GarmentImport::DressCut.read({ name: "Faux Leather Mini Dress", description: "Material: 54% Polyurethane / 46% Viscose" })[:fabric]
    assert_equal "halter", GarmentImport::DressCut.read({ name: "Kith Women Sasha Halter Maxi Dress", description: "Viscose blend Halter neckline Back straps" })[:sleeves]
  end

  test "a dress's photo gives its shape: flaring from the waist, a halter, sleeves the words don't name" do
    desma = GarmentImport::DressCut.read({ name: "Kith Women Desma Suiting Dress - Black", category: "Mini Dresses", description: LISTINGS[:desma].last,
                                           dress_shape: { waist: 0.81, waist_at: 0.42, hips: 1.07, hem: 1.35, flare_from: "waist", neck_depth: 0.1, neck_width: 0.75 } })
    assert_equal [ "flared", true ], desma.values_at(:fit, :waist_flare)
    assert_equal({ waist: 0.81, waist_at: 0.42, hips: 1.07, hem: 1.35, neck_depth: 0.1, neck_width: 0.75 }, desma[:shape])
    dalters = GarmentImport::DressCut.read({ name: "Entire Studios Dalters Mini Dress - Java", description: "Nylon blend Shoulder pads Mock neckline Draped construction Relaxed fit",
                                             dress_shape: { sleeves: "long", neck_depth: 0 } })
    assert_equal "long", dalters[:sleeves]
    moon = GarmentImport::DressCut.read({ name: "Frankies Bikinis Moon Cloud Knit Mini Dress", description: "Cowl neckline Self-tie closure on the back Fitted silhouette",
                                          dress_shape: { halter: true, waist: 0.98, hem: 0.99, hips: 1.1 } })
    assert_equal [ "halter", "fitted" ], moon.values_at(:sleeves, :fit)
    # Sleeves the words name stay, whatever the photo's top looks like; a polo dress has a collar.
    polo = GarmentImport::DressCut.read({ name: "Alexander Wang Crystal Embellished Polo Dress - Light Pink", description: "Stretch cotton jersey Crystal buttons",
                                          dress_shape: { halter: true } })
    assert_equal [ "short", true ], polo.values_at(:sleeves, :collar)
    # A caftan's batwing sleeves are wide at the top of its photo, not a halter's narrow neck.
    caftan = GarmentImport::DressCut.read({ name: "Missoni Short Cover-Up Caftan With Batwing Sleeves - Multi", category: "Mini Dresses", description: "",
                                            dress_shape: { halter: true } })
    assert_equal [ "long", "mini" ], caftan.values_at(:sleeves, :length)
    # Only the shop's category calls the Ionis a maxi; its photo is a mini's. A dress named a maxi stays one.
    ionis = GarmentImport::DressCut.read({ name: "Aya Muse Ionis Dress - Champagne Beige", category: "Maxi Dresses", description: "Satin Ruched bodice",
                                           dress_shape: { length: 2.64 } })
    assert_equal "mini", ionis[:length]
    vicka = GarmentImport::DressCut.read({ name: "Siedres Vicka Satin Maxi Dress - White", category: "Maxi Dresses", description: "", dress_shape: { length: 2.64 } })
    assert_equal "maxi", vicka[:length]
    assert_equal "maxi", GarmentImport::DressCut.read({ name: "Belle Anna Duo Dress - Grey", category: "Maxi Dresses", description: "", dress_shape: { length: 3.91 } })[:length]
    # A flounce's width at the hem isn't the body's: the body stays as it is, the flounce goes on.
    mela = GarmentImport::DressCut.read({ name: "Aya Muse Mela Mini Dress", description: "Ruffled hem Slim fit", dress_shape: { waist: 0.84, hips: 1.1, hem: 1.29, flare_from: "knee" } })
    assert_equal [ "slim", false ], mela.values_at(:fit, :hem_flare)
    assert_equal 1.1, mela[:shape][:hem]
  end

  test "a flared hem doesn't make a gown an A-line: it keeps its fit over the hips and flares only at the hem" do
    zair = cut(:zair)
    assert_equal [ "long", "maxi", "slim", true ], zair.values_at(:sleeves, :length, :fit, :hem_flare)
    m = GarmentImport::DressCut.usual_sizes(zair, %w[XS S M L]).sizes.find { it["name"] == "M" }
    assert_in_delta 106, m["hips"], 1, "the hips eased as a slim fit's, not a flared one's"
    refute cut(:desma)[:hem_flare]
  end

  test "women's sizes by letter and by US number, at the dress's length" do
    letters = GarmentImport::DressCut.usual_sizes(cut(:saja), %w[XXS XS S M L XL XXL]).sizes
    m = letters.find { it["name"] == "M" }
    assert_in_delta 62, m["length"], 1, "a strapless mini, measured from its top edge"
    assert_nil m["sleeve"]

    numbers = GarmentImport::DressCut.usual_sizes(cut(:wang), %w[00 0 2 4 6 8 10 12 14]).sizes
    assert_equal %w[00 0 2 4 6 8 10 12 14], numbers.map { it["name"] }
    assert_operator numbers.first["chest"], :<, numbers.last["chest"]
  end

  test "a stretch dress made smaller than the body fits, and a sleeveless one isn't judged on sleeves" do
    woman = { "chest" => 91.5, "waist" => 74, "shoulders" => 39.5, "arm" => 58, "height" => 165, "hips" => 99 }
    sizes = [ [ "XS", 29, 23.5 ], [ "S", 31, 25.5 ], [ "M", 33, 27.5 ], [ "L", 35, 29.5 ] ].map do |name, chest, waist|
      { "name" => name, "chest" => chest * 2.54, "waist" => waist * 2.54, "shoulders" => 31.75, "sleeve" => nil, "length" => 80 }
    end
    best = Fit.rank(woman, sizes, "regular", "top", style: "dress", details: { "stretch" => true, "sleeves" => "none" }).first
    assert_equal "M", best.size
    assert_equal "fits", best.verdict
    assert_equal "Sleeveless", best.checks.find { it.part == "sleeve" }.note
    assert_nil best.checks.find { it.part == "shoulders" }
  end

  test "where a dress is cut out, sheer, or has a scarf, which the 3D view draws" do
    read = ->(name, description) { GarmentImport::DressCut.read({ name:, category: "Dresses", description: }) }
    belle = read.("Belle Anna Duo Dress - Grey", "Merino wool Halter strap Plunging neckline Attached scarf on the side Open back Slim fit")
    assert_equal [ [ "back" ], "side", nil ], belle.values_at(:cutouts, :scarf, :sheer)
    aya = read.("Aya Muse Zair Layered Gown - Caramel", "Lyocell blend Adjustable straps on the front Cutouts on the shoulder Raw sleeve cuffs Sweetheart neck Flared hem Maxi fit")
    assert_equal [ [ "shoulders" ], "long" ], aya.values_at(:cutouts, :sleeves)
    gaultier = read.("Jean Paul Gaultier The Smoking Women Long Dress - Black", "Printed nylon Semi sheer Raw sleeve cuffs and hem Loop accent on the back Slim fit")
    assert_equal [ "all", "semi", "long" ], gaultier.values_at(:sheer, :sheer_kind, :sleeves)
    assert_equal "sleeves", read.("Mesh Dress", "Sheer sleeves")[:sheer]
    # A shelf bra lined with power mesh doesn't make a tennis dress see-through.
    assert_nil read.("Kith Ivy for Wilson Women's Padel Dress - Ivy Green", "Light compressive stretch Interior shelf bra lined with power mesh")[:sheer]
    assert_equal [ "neck" ], [ cut(:cyrielle)[:scarf] ]
    refute_includes cut(:mireli)[:details], "cut-outs"
    assert_equal [ "back" ], cut(:mireli)[:cutouts]
  end

  test "a flounce at the hem, a side slit and a belt are drawn, so they aren't listed as left out" do
    read = ->(description) { GarmentImport::DressCut.read({ name: "Midi Dress", category: "Dresses", description: }) }
    assert_equal [ "buckle", false ], [ cut(:desma)[:belt], cut(:desma)[:details].include?("belt") ]
    flounce = read.("Ruffled hem Slim fit")
    assert_equal [ true, [] ], flounce.values_at(:flounce, :details)
    # Ruffles elsewhere stay a note.
    assert_equal [ "ruffles" ], read.("Ruffle trim on the neck Ruffled hem")[:details]
    assert_equal "sides", read.("Side slits Relaxed fit")[:slit]
    assert_equal "side", read.("Thigh-high slit Relaxed fit")[:slit]
    # A slit at the back isn't drawn, and belt loops aren't a belt.
    assert_equal [ nil, nil, [ "slit" ] ], read.("Slit at the back Belt loops at the waist").values_at(:slit, :belt, :details)
    assert_equal [ "tie", [] ], read.("Self-tie belt at the waist").values_at(:belt, :details)
    # A tie that closes it, or a sash draped to the hip, isn't a belt.
    assert_equal [ nil, [ "tie" ] ], read.("Cowl neckline Self-tie closure on the back").values_at(:belt, :details)
    assert_equal [ nil, [ "tie", "draping" ] ], read.("Draped sash self-tie closure on hip").values_at(:belt, :details)
  end
end
