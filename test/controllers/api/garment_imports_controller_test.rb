require "test_helper"

class Api::GarmentImportsControllerTest < ActionDispatch::IntegrationTest
  test "reads a pasted size chart" do
    post api_v1_garment_imports_path, params: { text: "Size\tChest\tWaist\n40R\t44.5\t39.5\n42R\t46.5\t41.5\n" }, as: :json

    assert_response :success
    garment = response.parsed_body["garment"]
    assert_equal "jacket", garment["garment"]
    assert_equal %w[40R 42R], garment["chart"]["sizes"].map { it["name"] }
  end

  test "explains a link it can't use" do
    post api_v1_garment_imports_path, params: { url: "http://127.0.0.1/admin" }, as: :json

    assert_response :unprocessable_entity
    assert_equal "fetch_failed", response.parsed_body["error"]
  end

  test "needs a link or a chart" do
    post api_v1_garment_imports_path, params: {}, as: :json
    assert_response :unprocessable_entity
  end
end
