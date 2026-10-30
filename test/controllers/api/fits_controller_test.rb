require "test_helper"

class Api::FitsControllerTest < ActionDispatch::IntegrationTest
  MEASUREMENTS = { chest: 40, waist: 34, shoulders: 18, arm: 25.75, height: 70 }.freeze

  def post_fit(params, chart: "sample_suit_jacket")
    post api_v1_size_chart_fits_path(chart), params:, as: :json
  end

  test "ranks sizes for a body in inches" do
    post_fit({ unit: "in", cut: "regular", measurements: MEASUREMENTS })

    assert_response :success
    assert_equal "no-store", response.headers["Cache-Control"]
    json = response.parsed_body
    assert_equal "40R", json["best"]
    assert_equal "cm", json["units"]
    assert_equal 18, json["sizes"].size
    assert_equal %w[shoulders chest waist sleeve length], json["sizes"].first["checks"].map { it["part"] }
    # Each check says the range of ease that fits for the cut, so the page can show where a size falls in it.
    best = json["sizes"].find { it["size"] == "40R" }["checks"].index_by { it["part"] }
    chest = best["chest"]
    assert_equal 2, chest["good_cm"].size
    assert chest["good_cm"].first < chest["good_cm"].last
    assert_equal [ -1.0, 1.0 ], best["sleeve"]["good_cm"]
  end

  test "explains what's missing or out of range" do
    post_fit({ unit: "cm", measurements: { chest: 101, waist: 86, shoulders: 3, arm: 65 } })

    assert_response :unprocessable_entity
    errors = response.parsed_body["errors"]
    assert_equal "is required", errors["height"]
    assert_match "between", errors["shoulders"]
  end

  test "rejects unknown cuts and units" do
    post_fit({ unit: "ft", cut: "baggy", measurements: MEASUREMENTS })

    assert_response :unprocessable_entity
    errors = response.parsed_body["errors"]
    assert errors.key?("cut")
    assert errors.key?("unit")
  end

  test "an unknown chart is a 404" do
    post_fit({ measurements: MEASUREMENTS }, chart: "nope")
    assert_response :not_found
  end

  test "measurements never reach the log" do
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
    filtered = filter.filter("measurements" => { "chest" => 40 }, "fit" => { "measurements" => { "chest" => 40 } })
    assert_equal "[FILTERED]", filtered["measurements"]
    assert_equal "[FILTERED]", filtered["fit"]["measurements"]
  end

  test "the API sets no cookies" do
    post_fit({ unit: "in", measurements: MEASUREMENTS })
    assert_nil response.headers["Set-Cookie"]
  end

  test "fits sizes sent in the request, such as an imported garment's" do
    sizes = [
      { name: "40R", chest: 113, waist: 100.3, shoulders: 45.7, sleeve: 63.5, length: nil },
      { name: "42R", chest: 118.1, waist: 105.4, shoulders: 47, sleeve: 64.1, length: nil }
    ]
    post api_v1_fits_path, params: { unit: "in", measurements: MEASUREMENTS, sizes: }, as: :json

    assert_response :success
    json = response.parsed_body
    assert_equal "40R", json["best"]
    assert_nil json["size_chart"]
    assert_equal "unknown", json["sizes"].first["checks"].find { it["part"] == "length" }["status"]
  end

  test "checks the sizes sent in the request" do
    post api_v1_fits_path, params: { measurements: MEASUREMENTS, sizes: [ { name: "", chest: "big" } ] }, as: :json

    assert_response :unprocessable_entity
    errors = response.parsed_body["errors"]
    assert_equal "is required", errors["sizes.0.name"]
    assert_equal "must be a number", errors["sizes.0.chest"]
  end

  test "fits trousers, using hips and inseam when given" do
    sizes = [ { name: "34", waist: 88.9, seat: 107, thigh: 62, inseam: 81.3, leg_opening: 40 } ]
    post api_v1_fits_path, params: { unit: "in", garment: "trousers", measurements: MEASUREMENTS.merge(hips: 39.5, inseam: 32.25), sizes: }, as: :json

    assert_response :success
    checks = response.parsed_body["sizes"].first["checks"]
    assert_equal %w[waist seat inseam leg_opening], checks.map { it["part"] }
    assert_equal "Cut with a straight leg", checks.last["note"]
  end

  test "micro shorts with an inch-long inseam are fitted; other measurements still need 5 cm" do
    sizes = [ { name: "S", waist: 81.3, seat: 90.2, inseam: 2.54, leg_opening: 63.5 } ]
    post api_v1_fits_path, params: { unit: "in", garment: "trousers", style: "shorts", measurements: MEASUREMENTS.merge(hips: 39.5, inseam: 32.25), sizes: }, as: :json
    assert_response :success
    assert_equal "S", response.parsed_body["best"]

    post api_v1_fits_path, params: { unit: "in", garment: "trousers", measurements: MEASUREMENTS, sizes: [ { name: "S", waist: 3, seat: 90 } ] }, as: :json
    assert_response :unprocessable_entity
  end

  test "trousers without hips or inseam say what's missing" do
    post api_v1_fits_path, params: { garment: "trousers", unit: "in", measurements: MEASUREMENTS, sizes: [ { name: "34", waist: 88.9, seat: 107 } ] }, as: :json

    seat = response.parsed_body["sizes"].first["checks"].find { it["part"] == "seat" }
    assert_equal [ "unknown", "Add your hips to check this" ], seat.values_at("status", "note")
  end

  test "warns about measurements most people don't have" do
    post_fit({ unit: "in", measurements: MEASUREMENTS.merge(shoulders: 25) })

    warning = response.parsed_body["warnings"].sole
    assert_equal "shoulders", warning["part"]
    assert_match "not around the arms", warning["message"]
  end
end
