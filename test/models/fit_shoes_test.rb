require "test_helper"

class FitShoesTest < ActiveSupport::TestCase
  S = Fit::Shoes

  test "size names parse on their scale, with widths" do
    assert_equal({ number: 9.5, scale: "us_m", width: nil }, S.parse_size("9.5"))
    assert_equal({ number: 42.5, scale: "eu", width: nil }, S.parse_size("EU 42.5", "us_m"))
    assert_equal({ number: 8.0, scale: "uk", width: nil }, S.parse_size("UK 8"))
    assert_equal({ number: 27.0, scale: "cm", width: nil }, S.parse_size("27 cm"))
    assert_equal "2E", S.parse_size("9 Wide")[:width]
    assert_equal "2E", S.parse_size("US 10 (2E)")[:width]
    assert_equal "B", S.parse_size("9 Narrow")[:width]
    assert_nil S.parse_size("W 8")[:width]
    assert_equal 8.0, S.parse_size("W 8", "us_w")[:number]
    assert_nil S.parse_size("One size")
  end

  test "the scales: a US men's 9, a UK 8 and an EU 42 are all a 27 cm last; women's run 1.5 sizes ahead" do
    assert_in_delta 27.0, S.last_length(S.parse_size("9")), 0.01
    assert_in_delta 27.0, S.last_length(S.parse_size("UK 8")), 0.01
    assert_in_delta 27.0, S.last_length(S.parse_size("EU 42")), 0.01
    assert_in_delta 25.5, S.last_length(S.parse_size("9", "us_w")), 0.01
    assert_in_delta 27.0 + 2.54 / 3, S.last_length(S.parse_size("10")), 0.01
    # Brands: Nike runs short, Converse long.
    assert_in_delta 26.6, S.last_length(S.parse_size("9"), "Nike Air Force 1"), 0.01
    assert_in_delta 27.5, S.last_length(S.parse_size("9"), "Converse"), 0.01
  end

  test "the chart's scale from its names" do
    assert_equal "us_m", S.scale_for(%w[7 7.5 8 8.5 9 10 11 12])
    assert_equal "us_w", S.scale_for(%w[6 7 8 9], women: true)
    assert_equal "us_w", S.scale_for([ "W 6", "W 7", "W 8" ])
    assert_equal "eu", S.scale_for(%w[40 41 42 43 44])
    assert_equal "eu", S.scale_for([ "EU 42", "EU 43" ])
    assert_equal "cm", S.scale_for([ "25.5", "26", "26.5", "27" ])
  end

  test "a 26.5 cm foot in a sneaker is a US 10: a thumb's width of room; 9.5 touches, 11 slips" do
    sizes = %w[8 8.5 9 9.5 10 10.5 11 11.5].map { { "name" => _1 } }
    results = S.rank({ "foot" => 26.5, "ball" => 9.8 }, sizes, brand: "New Balance", style: "sneaker", fabric: "mesh")
    assert_equal "10", results.first.size
    by = results.to_h { [ _1.size, _1 ] }
    assert_equal "tight", by["9"].checks.find { _1.part == "toe" }.status
    assert_equal "loose", by["11.5"].checks.find { _1.part == "toe" }.status
    assert_equal "good", by["10"].checks.find { _1.part == "width" }.status
  end

  test "a loafer holds the foot: less room; a wide foot wants a 2E" do
    sizes = %w[9 9.5 10 10.5].map { { "name" => _1 } }
    loafer = S.rank({ "foot" => 26.5 }, sizes, style: "loafer", fabric: "leather")
    assert_equal "9.5", loafer.first.size
    wide = S.rank({ "foot" => 26.5, "ball" => 10.8 }, [ { "name" => "10" }, { "name" => "10 Wide" } ], style: "sneaker", fabric: "leather")
    assert_equal "10 Wide", wide.first.size
    assert_equal "tight", wide.last.checks.find { _1.part == "width" }.status
  end

  test "warnings for a foot outside the usual range" do
    assert_empty S.warnings({ "foot" => 26.5, "ball" => 9.8 })
    assert_equal 1, S.warnings({ "foot" => 34, "ball" => 9.8 }).size
  end
end
