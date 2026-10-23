require "test_helper"

# Thirty-one real Kith listings (tees, shirts, hoodies, pants, jeans, skirts, shorts, dresses, jackets, belts,
# shoes, a hat and sunglasses), as a shopper's browser reads them: the listing, its Kiwi Sizing tables, and
# for some tops the shape read off the shop photo. Each says what Fitroom should make of it.
class KithListingsTest < ActiveSupport::TestCase
  LISTINGS = JSON.parse(File.read(File.expand_path("../fixtures/files/kith_listings.json", __dir__)))

  def given(listing)
    cell = ->(value) { { "type" => "single", "value" => value } }
    tables = listing["tables"].each_with_index.to_h { |rows, i| [ "t#{i}", { "data" => rows.map { it.map(&cell) } } ] }
    {
      "shop" => "kithnyc.myshopify.com", "sizing" => { "sizings" => [ { "tables" => tables } ] }, "shape" => listing["shape"],
      "product" => {
        "id" => 1, "handle" => listing["h"], "title" => listing["title"], "vendor" => listing["vendor"],
        "product_type" => listing["type"], "tags" => listing["tags"], "body_html" => "<p>#{listing["body"]}</p>",
        "images" => [ { "src" => "//cdn.shopify.com/#{listing["h"]}.jpg" } ],
        "options" => [ { "name" => "Size", "values" => listing["sizes"] } ],
        "variants" => listing["sizes"].map { { "title" => it } }
      }
    }
  end

  LISTINGS.each do |listing|
    expect = listing["expect"]
    test "Kith: #{listing["title"]}" do
      url = "https://kith.com/products/#{listing["h"]}"
      import = GarmentImport.new(fetch_json: ->(_) { raise "the browser's answers are used" })
      if expect["error"]
        error = assert_raises(GarmentImport::Error) { import.from_shopify(url, given: given(listing)) }
        assert_equal expect["error"], error.code
        next
      end

      garment = import.from_shopify(url, given: given(listing))
      assert garment, "read as a garment"
      assert_equal expect["garment"], garment[:garment]
      assert_equal expect["style"], garment[:style] if expect["style"]
      assert_equal expect["women"], !!garment[:women]
      assert_equal !!expect["snug"], !!garment[:snug], "snug (a baby tee)"
      assert_equal !!expect["dropped"], !!garment[:dropped], "dropped shoulders, from the photo"
      %w[sleeves length].each { |part| assert_equal expect[part], garment.dig(:cut, part.to_sym), part if expect[part] }
      assert_equal expect["names"], garment[:chart][:sizes].map { it["name"] } if expect["names"]
      expect.fetch("sizes", {}).each do |name, parts|
        size = garment[:chart][:sizes].find { it["name"] == name || it["name"].start_with?("#{name} (") }
        assert size, "has size #{name}"
        parts.each { |part, value| assert_in_delta value, size[part], 0.5, "#{name} #{part}" }
      end
    end
  end
end
