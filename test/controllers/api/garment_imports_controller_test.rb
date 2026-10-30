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

class Api::GarmentImportsImageProxyTest < ActionDispatch::IntegrationTest
  PNG = "\x89PNG\r\n\x1A\n".b + ("\0" * 64).b

  # The fetcher answering with `get_image` for the block's length. (Minitest 6 has no Object#stub.)
  def with_get_image(get_image)
    fetcher = GarmentImport::Fetcher
    original = fetcher.method(:get_image)
    fetcher.define_singleton_method(:get_image) { |*args, **options| get_image.call(*args, **options) }
    yield
  ensure
    fetcher.define_singleton_method(:get_image, original)
  end

  test "passes a shop's photo through, as an image the browser may cache for an hour" do
    asked = nil
    fetch = lambda do |url, max_bytes:, types:|
      asked = [ url, max_bytes, types ]
      [ PNG, "image/png" ]
    end
    with_get_image(fetch) do
      get image_api_v1_garment_imports_path, params: { url: "https://cdn.example.com/boot.png?width=1000" }
    end

    assert_response :success
    assert_equal "image/png", response.media_type
    assert_equal PNG, response.body.b
    assert_equal %w[max-age=3600 public], response.headers["Cache-Control"].split(/,\s*/).sort
    assert_equal "https://cdn.example.com/boot.png?width=1000", asked[0]
    assert_equal 8_000_000, asked[1]
    assert_match asked[2], "image/webp"
    assert_no_match asked[2], "image/svg+xml"
    assert_no_match asked[2], "text/html"
  end

  test "turns away a private address without asking it" do
    get image_api_v1_garment_imports_path, params: { url: "http://127.0.0.1/secret.png" }

    assert_response :unprocessable_entity
    assert_equal "fetch_failed", response.parsed_body["error"]
  end

  test "turns away what isn't a link, and what isn't a photo" do
    get image_api_v1_garment_imports_path, params: { url: "not a link" }
    assert_response :unprocessable_entity

    not_photo = ->(*, **) { raise GarmentImport::Fetcher::Error, "That isn't a photo." }
    with_get_image(not_photo) do
      get image_api_v1_garment_imports_path, params: { url: "https://shop.example.com/products/boot" }
    end
    assert_response :unprocessable_entity
    assert_equal "That isn't a photo.", response.parsed_body["message"]
  end
end
