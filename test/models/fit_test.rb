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

  MAN = BODY.merge("hips" => 101, "inseam" => 81).freeze
  WOMAN = { "chest" => 91.5, "waist" => 74, "shoulders" => 39.5, "arm" => 58, "height" => 165, "hips" => 99, "inseam" => 76 }.freeze

  def letters(names, rows, keys) = names.zip(rows).map { |name, row| { "name" => name }.merge(keys.zip(row).to_h) }
  def inches(*values) = values.map { (it * 2.54).round(2) }

  test "an elastic waist stretches about 8%, not 15 cm: past that it's tight, and a size that stretches a little wins" do
    # Kith's Spun Silk Linen Stripe Idris Pant (drawstring), its chart in inches: XS waist 28 and seat 44.3, 2 in a size.
    sizes = letters(%w[XS S M L XL XXL], (0..5).map { |i| [ *inches(28 + 2 * i, 44.27 + 2 * i), 73.4, 45.72 ] }, %w[waist seat inseam leg_opening])
    ranked = Fit.rank(MAN, sizes, "regular", "trousers", style: "trousers", details: { "elastic" => true })

    assert_equal "M", ranked.first.size
    assert_equal "good", ranked.first.checks.find { it.part == "waist" }.status
    # The XS (15 cm smaller than the waist) and the S (10 cm) won't stretch that far, and no tailor can let them out.
    %w[XS S].each do |name|
      waist = ranked.find { it.size == name }.checks.find { it.part == "waist" }
      assert_equal [ "tight", nil ], [ waist.status, waist.fix ]
    end
  end

  test "elastic-waist shorts and track pants are picked by the waist they stretch to, not one 10 cm smaller" do
    # Kith's Silk Cotton Active Short (S waist 30 in, seat 42.5 in) and Willy Chavarria's Bad Boy Track Pant (S waist 76 cm).
    shorts = letters(%w[XS S M L XL XXL], (0..5).map { |i| [ *inches(28 + 2 * i, 40.5 + 2 * i), 12 ] }, %w[waist seat inseam])
    assert_equal "M", Fit.rank(MAN, shorts, "regular", "trousers", style: "shorts", details: { "elastic" => true }).first.size
    track = letters(%w[XS S M L XL], (0..4).map { |i| [ 71.04 + 5 * i, 105.03 + 5 * i, 81, 30 ] }, %w[waist seat inseam leg_opening])
    # (The body's 86.4 cm waist is where an M's stretch ends and an L's begins.)
    best = Fit.rank(MAN, track, "regular", "trousers", style: "joggers").first
    assert_includes %w[M L], best.size
    assert_match(/stretches/, best.checks.find { it.part == "waist" }.note)
  end

  test "pants made loose on purpose are picked by the waist, their roomy seat as it's meant to be" do
    # Armani & Kith's Cargo Pant ("pleats at the waist", "relaxed, straight leg"): Italian sizes, 39 to 49 cm over the hip.
    rows = [ [ 79, 118, 69.7 ], [ 83, 122, 70.6 ], [ 87, 126, 71.5 ], [ 91, 130, 72.4 ], [ 95, 134, 72.8 ], [ 99, 138, 73.2 ] ]
    sizes = letters(%w[44 46 48 50 52 54], rows.map { [ *it, 40 ] }, %w[waist seat inseam leg_opening])
    best = Fit.rank(MAN, sizes, "regular", "trousers", style: "trousers", details: { "fit" => "loose" }).first
    assert_equal "48", best.size
    seat = best.checks.find { it.part == "seat" }
    assert_equal "good", seat.status
    assert_match(/meant to be/, seat.note)

    # Loewe's Anagram Baggy Jeans, French sizes 38 to 46 with no chart (see GarmentImport#european_waists): the
    # 44 (a 34 in waist), not the smallest.
    loewe = letters(%w[38 40 42 44 46], (28..36).step(2).map { [ *inches(it), (it * 2.54 + 28).round(1), 81, 40 ] }, %w[waist seat inseam leg_opening])
    assert_equal "44", Fit.rank(MAN, loewe, "regular", "trousers", style: "jeans", details: { "fit" => "loose" }).first.size

    # Armani & Kith's Pleated Pant: elastic, its relaxed waist 77 cm in a 44 (4 cm a size), 124 over the hip.
    pleated = letters(%w[44 46 48 50 52], (0..4).map { |i| [ 77 + 4 * i, 124 + 4 * i, 72, 40 ] }, %w[waist seat inseam leg_opening])
    best = Fit.rank(MAN, pleated, "regular", "trousers", style: "trousers", details: { "elastic" => true, "fit" => "loose" }).first
    assert_equal "48", best.size
    assert_match(/stretches/, best.checks.find { it.part == "waist" }.note)
  end

  test "a tailored trouser a little loose over the seat has it taken in" do
    # Armani & Kith's Cashmere Trouser, size 48: 87 cm at the waist, 114 over the hip.
    size = { "name" => "48", "waist" => 87, "seat" => 114, "inseam" => 87.8, "leg_opening" => 48 }
    seat = Fit.check_trousers(MAN, size).checks.find { it.part == "seat" }
    assert_equal [ "loose", "take_in_seat" ], [ seat.status, seat.fix.action ]
  end

  test "trousers sold unhemmed say so, and how long to hem them, instead of being 26 cm too long" do
    # Armani & Kith's Virgin Wool Trouser: every size's inseam 104 cm.
    sizes = letters(%w[44 46 48 50 52], (0..4).map { |i| [ 79 + 4 * i, 108 + 4 * i, 103.97, 47 ] }, %w[waist seat inseam leg_opening])
    best = Fit.rank(MAN, sizes, "regular", "trousers", style: "trousers", details: { "hem" => "unfinished" }).first
    assert_equal "48", best.size
    length = best.checks.find { it.part == "inseam" }
    assert_equal "good", length.status
    assert_equal "Comes unhemmed. Have it hemmed to about 78 cm.", length.note
    assert_equal "long", Fit.check_trousers(MAN, sizes[2]).checks.find { it.part == "inseam" }.status
  end

  test "a jacket made big on purpose is picked by the room it's made with, not squeezed into the smallest size" do
    # Armani & Kith's Lamb Leather Aviator Blouson (cm): Italian sizes, every one about 30 cm over the chest it's for.
    rows = [ [ 59.3, 53.9, 118.4, 63 ], [ 60.5, 55.1, 122.4, 63.4 ], [ 61.7, 56.3, 126.4, 63.8 ], [ 62.9, 57.5, 130.4, 64.2 ], [ 64.1, 58.7, 134.4, 64.6 ],
             [ 65.3, 59.9, 139.4, 65 ], [ 65.8, 61.1, 144.4, 65.4 ], [ 66.3, 62.3, 149.4, 65.8 ], [ 66.8, 63.5, 154.4, 66.2 ] ]
    aviator = letters(%w[44 46 48 50 52 54 56 58 60], rows, %w[length shoulders chest sleeve])
    assert Fit.design(aviator)[:roomy]
    best = Fit.rank(BODY, aviator, "regular", "jacket", style: "bomber").first
    assert_equal "50", best.size
    assert_equal %w[good good good], best.checks.select { it.part.in?(%w[shoulders chest length]) }.map(&:status)
    assert_match(/top of your hips/, best.checks.find { it.part == "length" }.note)

    # Kith's Vancouver Dejan Utility Jacket (inches, sleeves from the centre back): an XS is 47 in round the chest.
    rows = [ [ 27, 47, 35.13 ], [ 27.5, 49, 35.5 ], [ 28, 51, 35.88 ], [ 28.5, 53, 36.25 ], [ 29.25, 56, 36.75 ], [ 30, 59, 37.25 ] ]
    dejan = letters(%w[XS S M L XL XXL], rows.map { |l, c, s| [ *inches(l, c), (s * 2.54 - 23).round(2) ] }, %w[length chest sleeve])
    best = Fit.rank(BODY, dejan, "regular", "jacket", style: "zip").first
    assert_includes %w[M L], best.size
    assert_equal "good", best.checks.find { it.part == "chest" }.status
  end

  test "a women's hoodie made big on purpose is picked as it's meant to be worn, even when the listing says fitted" do
    # Kith Women's Elvina Paneled Hoodie (inches): an XS is 41.5 in round the chest and 19 in long, 2 in and 0.5 in a size.
    elvina = letters(%w[XS S M L XL XXL], (0..5).map { |i| [ *inches(41.5 + 2 * i), nil, nil, *inches(19 + 0.5 * i) ] }, %w[chest shoulders sleeve length])
    best = Fit.rank(WOMAN, elvina, "regular", "top", style: "hoodie", details: { "women" => true }).first
    assert_equal "M", best.size
    assert_equal %w[good good], best.checks.select { it.part.in?(%w[chest length]) }.map(&:status)

    # Kith Women's Toyo Zip Hoodie, read as a fitted knit from its words, but an XS is 43 in round the chest.
    toyo = letters(%w[XS S M L XL XXL], (0..5).map { |i| inches(43 + 2 * i, 19.78 + 0.5 * i, 19.74 + 0.5 * i) }, %w[chest sleeve length])
    ranked = Fit.rank(WOMAN, toyo, "regular", "top", style: "hoodie", details: { "women" => true, "fit" => "fitted", "stretch" => true })
    assert_includes %w[M L], ranked.first.size
    assert_equal "good", ranked.first.checks.find { it.part == "chest" }.status
  end

  test "a cropped jacket, a bomber or a track jacket says where it ends instead of being too short" do
    # Kith Women's Syd Faux Leather Harrington (a bomber), size M, and Keshi Cropped Blazer, size L.
    syd = { "name" => "M", "chest" => 101.66, "shoulders" => 39.5, "sleeve" => 56.5, "length" => 54.57 }
    length = Fit.check_size(WOMAN, syd, "regular", "jacket", style: "bomber", details: { "women" => true }).checks.find { it.part == "length" }
    assert_equal [ "good", 0 ], [ length.status, length.penalty ]
    assert_match(/ends at the top of your hips/, length.note)

    keshi = { "name" => "L", "chest" => 100.39, "shoulders" => 40.77, "sleeve" => 56.5, "length" => 49.49 }
    assert_equal "short", Fit.check_size(WOMAN, keshi, "regular", "jacket", style: "tailored", details: { "women" => true }).checks.find { it.part == "length" }.status
    cropped = Fit.check_size(WOMAN, keshi, "regular", "jacket", style: "tailored", details: { "women" => true, "cropped" => true })
    assert_match(/ends at your waist/, cropped.checks.find { it.part == "length" }.note)
    track = Fit.check_size(WOMAN, keshi, "regular", "jacket", style: "zip", details: { "women" => true, "ends" => "waist" })
    assert_equal "good", track.checks.find { it.part == "length" }.status
  end
end
