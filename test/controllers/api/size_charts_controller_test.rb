require "test_helper"

class Api::SizeChartsControllerTest < ActionDispatch::IntegrationTest
  test "lists charts without their sizes" do
    get api_v1_size_charts_path, as: :json
    assert_response :success
    chart = response.parsed_body["size_charts"].find { it["key"] == "sample_suit_jacket" }
    assert_equal "jacket", chart["garment"]
    assert_nil chart["sizes"]
  end

  test "shows one chart with its sizes" do
    get api_v1_size_chart_path("sample_suit_jacket"), as: :json
    assert_response :success
    assert_equal 18, response.parsed_body["sizes"].size
  end

  test "the fit guide lists measurements and cuts" do
    get api_v1_fit_guide_path, as: :json
    assert_response :success
    json = response.parsed_body
    assert_equal %w[chest waist shoulders arm height hips inseam], json["measurements"].map { it["key"] }
    assert_equal [ false, true ], json["measurements"].values_at(0, 5).map { it["optional"] }
    assert_equal %w[slim regular classic], json["cuts"].map { it["key"] }
  end
end
