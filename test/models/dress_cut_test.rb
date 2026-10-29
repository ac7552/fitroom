require "test_helper"

# Six real listings (Kith's, October 2026): what each dress is, read from its name, category and description.
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
            "Lyocell blend Adjustable straps on the front Cutouts on the shoulder Raw sleeve cuffs Sweetheart neck Flared hem Maxi fit Material: 90% Lyocell / 10% Silk" ]
  }.freeze

  def cut(key)
    name, category, description = LISTINGS.fetch(key)
    GarmentImport::DressCut.read({ name:, category:, description: })
  end

  test "each dress's sleeves, neckline, length, fit and cloth" do
    assert_equal [ "none", "straight", "mini", "fitted", true, "stretch" ], cut(:desma).values_at(:sleeves, :neckline, :length, :fit, :stretch, :fabric)
    assert_equal [ "strapless", "mini", "fitted", "leather" ], cut(:saja).values_at(:sleeves, :length, :fit, :fabric)
    assert_equal [ "straps", "scoop", "slim", "leather" ], cut(:wang).values_at(:sleeves, :neckline, :fit, :fabric)
    assert_equal [ "thin_straps", "plunge", "silk", true ], cut(:mireli).values_at(:sleeves, :neckline, :fabric, :printed)
    assert_equal [ "one_shoulder", "silk", false ], cut(:cyrielle).values_at(:sleeves, :fabric, :printed)
    assert_includes cut(:cyrielle)[:details], "tie"
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
    assert_equal [ "neck" ], [ cut(:cyrielle)[:scarf] ]
    refute_includes cut(:mireli)[:details], "cut-outs"
    assert_equal [ "back" ], cut(:mireli)[:cutouts]
  end
end
