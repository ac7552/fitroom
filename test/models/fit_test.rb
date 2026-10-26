require "test_helper"

class FitTest < ActiveSupport::TestCase
  # A made-up 40R build: 40 in chest, 34 in waist, 5 ft 10 in.
  BODY = { "chest" => 101.6, "waist" => 86.4, "shoulders" => 45.5, "arm" => 65.5, "height" => 178 }.freeze

  setup { @sizes = SizeChart.find("sample_suit_jacket").sizes }

  def size(name) = @sizes.find { |s| s["name"] == name }

  test "a 40R body gets 40R in a regular cut, with nothing to fix" do
    best = Fit.rank(BODY, @sizes, "regular").first
    assert_equal "40R", best.size
    assert_equal "fits", best.verdict
    assert_equal 0, best.penalty
  end

  test "longer arms are a sleeve alteration, not a different size" do
    result = Fit.check_size(BODY.merge("arm" => 68.5), size("40R"))
    sleeve = result.checks.find { |c| c.part == "sleeve" }
    assert_equal "short", sleeve.status
    assert_equal "lengthen_sleeves", sleeve.fix.action
    assert_equal "alter", result.verdict
  end

  test "shoulders that are too narrow can't be fixed" do
    result = Fit.check_size(BODY, size("36R"))
    shoulders = result.checks.find { |c| c.part == "shoulders" }
    assert_equal "tight", shoulders.status
    assert_nil shoulders.fix
    assert_equal "compromise", result.verdict
  end

  test "a slim cut never picks a bigger size than regular" do
    assert_operator Fit.rank(BODY, @sizes, "slim").first.size.to_i, :<=, 40
  end

  test "a waist that's too loose is taken in, up to a limit" do
    roomy = Fit.check_size(BODY.merge("waist" => 81), size("40R"))
    assert_equal "take_in_waist", roomy.checks.find { |c| c.part == "waist" }.fix.action

    far_too_roomy = Fit.check_size(BODY.merge("waist" => 70), size("40R"))
    assert_nil far_too_roomy.checks.find { |c| c.part == "waist" }.fix
  end

  test "a coat gets room for a jacket underneath, and its length is described, not judged" do
    coat = { "name" => "L", "chest" => 101.6 + 18, "waist" => nil, "shoulders" => 46, "sleeve" => 64, "length" => 95 }
    result = Fit.check_size(BODY, coat, "regular", "coat")

    assert_equal "good", result.checks.find { it.part == "chest" }.status
    length = result.checks.find { it.part == "length" }
    assert_equal "good", length.status
    assert_equal "Ends just above the knee", length.note

    as_jacket = Fit.check_size(BODY, coat, "regular", "jacket")
    assert_equal "loose", as_jacket.checks.find { it.part == "chest" }.status
  end
  test "a top made big on purpose, with dropped shoulders, is judged as it's meant to be worn" do
    # A boxy crewneck's chart (cm): every size about 47 cm bigger round the chest than its usual body.
    sizes = [ [ "XS", 135.3, 69.2, 54.0, 62.2 ], [ "S", 140.3, 70.5, 54.3, 63.5 ], [ "M", 145.4, 71.8, 54.6, 64.8 ],
              [ "L", 150.5, 73.0, 54.9, 66.0 ], [ "XL", 158.1, 74.9, 55.2, 68.0 ] ].map do |name, chest, shoulders, sleeve, length|
      { "name" => name, "chest" => chest, "waist" => nil, "shoulders" => shoulders, "sleeve" => sleeve, "length" => length }
    end
    assert Fit.design(sizes)[:dropped]

    best = Fit.rank(BODY, sizes, "regular", "top").first
    assert_equal "M", best.size
    assert_equal %w[good good], best.checks.select { it.part.in?(%w[shoulders chest]) }.map(&:status)
    assert_equal "S", Fit.rank(BODY, sizes, "slim", "top").first.size
  end

  test "a dress sits closer than a T-shirt, and its length is where it ends" do
    woman = { "chest" => 91.5, "waist" => 74, "shoulders" => 39.5, "arm" => 58, "height" => 165 }
    sizes = SizeChart.find("sample_dress").sizes
    best = Fit.rank(woman, sizes, "regular", "top", style: "dress").first
    assert_equal "M", best.size
    assert_match(/knee/, best.checks.find { it.part == "length" }.note)
  end

  test "a baby tee is made the size of the body, short, and its size is picked so" do
    body = { "chest" => 91.5, "waist" => 74, "shoulders" => 39.5, "arm" => 58, "height" => 165 }
    sizes = [ [ "S", 85, 35.5, 53 ], [ "M", 90, 37, 54 ], [ "L", 95, 38.5, 55.5 ], [ "XL", 100, 40, 57 ] ].map do |name, chest, shoulders, length|
      { "name" => name, "chest" => chest, "waist" => nil, "shoulders" => shoulders, "sleeve" => 12, "length" => length }
    end

    assert_equal "L", Fit.rank(body, sizes, "regular", "top", style: "tee", details: { "women" => true }).first.size
    snug = Fit.rank(body, sizes, "regular", "top", style: "tee", details: { "women" => true, "snug" => true })
    assert_equal "M", snug.first.size
    assert_match(/baby tee/, snug.first.checks.find { it.part == "length" }.note)
  end

  test "a fitted knit hoodie stretches on: it's picked a little smaller than the body, not a size with a jacket's room" do
    # Kith's Adley Shrunken Multi Sweater Hoodie (women's), its chart in cm, on the women's example body.
    body = { "chest" => 91.5, "waist" => 74, "shoulders" => 39.5, "arm" => 58, "height" => 165 }
    sizes = [ [ "XS", 76.2, 35.56, 63.82, 48.9 ], [ "S", 81.28, 36.83, 64.77, 50.8 ], [ "M", 86.36, 38.1, 65.72, 52.71 ],
              [ "L", 91.44, 39.37, 66.68, 54.61 ], [ "XL", 99.06, 41.28, 67.95, 56.52 ], [ "XXL", 106.68, 43.18, 69.22, 58.42 ] ].map do |name, chest, shoulders, sleeve, length|
      { "name" => name, "chest" => chest, "waist" => nil, "shoulders" => shoulders, "sleeve" => sleeve, "length" => length }
    end
    knit = { "women" => true, "fit" => "fitted", "stretch" => true }

    # Read as a jacket, it wanted a jacket's room: XL. As an ordinary women's top it still wants some: XL.
    assert_equal "XL", Fit.rank(body, sizes, "regular", "jacket").first.size
    assert_equal "XL", Fit.rank(body, sizes, "regular", "top", style: "hoodie", details: { "women" => true }).first.size
    ranked = Fit.rank(body, sizes, "regular", "top", style: "hoodie", details: knit)
    assert_includes %w[S M], ranked.first.size
    best = ranked.first
    chest = best.checks.find { it.part == "chest" }
    assert_equal "good", chest.status
    assert_operator chest.ease, :<, 0
    assert_match(/stretches/, chest.note)
    # Its shoulder seam sits a little inside the shoulder bone; a shrunken knit ends at the waist.
    assert_equal "good", best.checks.find { it.part == "shoulders" }.status
    assert_equal "good", best.checks.find { it.part == "length" }.status
    assert_match(/waist/, best.checks.find { it.part == "length" }.note)
    # Slim and classic move at most one size either way; none of them picks XL.
    assert_includes %w[S M], Fit.rank(body, sizes, "slim", "top", style: "hoodie", details: knit).first.size
    assert_includes %w[M L], Fit.rank(body, sizes, "classic", "top", style: "hoodie", details: knit).first.size
    # Much smaller than the body is too tight, and a size with a jacket's room is loose.
    assert_equal "tight", ranked.find { it.size == "XS" }.checks.find { it.part == "chest" }.status
    assert_equal "loose", ranked.find { it.size == "XL" }.checks.find { it.part == "chest" }.status
    # A fitted top in a cloth that doesn't stretch is judged as any other top.
    assert_equal "XL", Fit.rank(body, sizes, "regular", "top", style: "hoodie", details: { "women" => true, "fit" => "fitted", "stretch" => false }).first.size
  end

  test "a tee whose photo shows dropped shoulders is meant to be wide there and boxy" do
    body = { "chest" => 101.6, "waist" => 86.4, "shoulders" => 45.5, "arm" => 65.5, "height" => 178 }
    sizes = [ { "name" => "S", "chest" => 110.5, "waist" => nil, "shoulders" => 50.8, "sleeve" => 19.4, "length" => 68.6 } ]

    plain = Fit.rank(body, sizes, "regular", "top", style: "tee").first
    assert_equal %w[loose short], plain.checks.values_at(0, 4).map(&:status)
    boxy = Fit.rank(body, sizes, "regular", "top", style: "tee", details: { "dropped" => true }).first
    assert_equal %w[good good], boxy.checks.values_at(0, 4).map(&:status)
  end

  test "joggers' elastic waist stretches onto the body, and a tailor can't let it out" do
    sizes = [ { "name" => "L", "waist" => 86, "seat" => 112, "thigh" => 67, "inseam" => 81, "leg_opening" => 26 },
              { "name" => "XS", "waist" => 71, "seat" => 97, "thigh" => 58, "inseam" => 81, "leg_opening" => 26 } ]
    body = BODY.merge("waist" => 87.6)

    snug = Fit.check_trousers(body, sizes[0], style: "joggers").checks.find { it.part == "waist" }
    assert_equal "good", snug.status
    assert_match(/elastic/i, snug.note)
    small = Fit.check_trousers(body, sizes[1], style: "joggers").checks.find { it.part == "waist" }
    assert_equal "tight", small.status
    assert_nil small.fix
    # Trousers with no elastic are let out by a tailor.
    assert_equal "let_out_waist", Fit.check_trousers(body, sizes[0]).checks.find { it.part == "waist" }.fix.action
  end

  test "pull-on trousers (a drawcord or elastic waist) stretch onto the body as joggers do" do
    size = { "name" => "M", "waist" => 81.3, "seat" => 122.6, "inseam" => 73.7, "leg_opening" => 45.7 }
    waist = Fit.check_trousers(BODY.merge("waist" => 86.4), size, details: { "elastic" => true }).checks.find { it.part == "waist" }
    assert_equal "good", waist.status
    assert_match(/elastic/i, waist.note)
  end

  test "a skirt and shorts say where they end" do
    body = BODY.merge("hips" => 100, "inseam" => 81)
    skirt = Fit.check_trousers(body, { "name" => "M", "waist" => 72, "seat" => 98, "length" => 96 }, style: "skirt").checks.find { it.part == "length" }
    assert_equal "Ends near the ankle", skirt.note
    shorts = Fit.check_trousers(body, { "name" => "M", "waist" => 86, "seat" => 108, "inseam" => 18 }, style: "shorts").checks.find { it.part == "inseam" }
    assert_match(/above the knee/, shorts.note)
  end
end
