require "test_helper"

class GarmentImportTest < ActiveSupport::TestCase
  def page(name) = file_fixture("#{name}.html").read

  test "reads a garment chart in inches from a product page" do
    garment = GarmentImport.new.from_page(page("navy-suit-jacket"), source_url: "https://shop.example/navy")

    assert_equal "Navy Wool Suit Jacket", garment[:name]
    assert_equal "Sample Tailoring Co.", garment[:brand]
    assert_equal GarmentImport::COLORS["navy"], garment[:color]
    chart = garment[:chart]
    assert_equal [ "in", "garment", [] ], chart.values_at(:unit, :kind, :missing)
    forty = chart[:sizes].find { it["name"] == "40R" }
    assert_in_delta 44.5 * 2.54, forty["chest"], 0.01
    assert_in_delta 18 * 2.54, forty["shoulders"], 0.01
  end

  test "turns a sideways body-measurement chart in cm into estimated jacket sizes" do
    garment = GarmentImport.new.from_page(page("charcoal-blazer"), source_url: "https://shop.example/charcoal")

    chart = garment[:chart]
    assert_equal [ "cm", "body" ], chart.values_at(:unit, :kind)
    assert_equal %w[shoulders length], chart[:missing]
    fifty = chart[:sizes].find { it["name"] == "50" }
    assert_in_delta 100 + 11, fifty["chest"], 0.01
    assert_nil fifty["length"]
    assert_equal GarmentImport::COLORS["charcoal"], garment[:color]
  end

  test "reads a pasted chart with tabs, fractions and ranges" do
    garment = GarmentImport.from_text("Size\tChest\tWaist\tSleeve\n40R\t44 ½\t39-40\t25\n42R\t46 1/2\t41.5\t25.25\n")

    forty = garment[:chart][:sizes].first
    assert_in_delta 44.5 * 2.54, forty["chest"], 0.01
    assert_in_delta 39.5 * 2.54, forty["waist"], 0.01
  end

  test "doubles pit-to-pit widths" do
    garment = GarmentImport.from_text("Size | Pit to pit (cm) | Length (cm)\nM | 54 | 74\nL | 57 | 76\n")

    assert_equal [ 108.0, 114.0 ], garment[:chart][:sizes].map { it["chest"] }
  end

  test "says when there's no size chart" do
    error = assert_raises(GarmentImport::Error) { GarmentImport.new.from_page("<html><title>Blazer</title></html>", source_url: "x") }
    assert_equal "no_size_chart", error.code
  end

  test "turns away things it can't fit yet" do
    html = page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", "Navy Oxford Shirt").gsub("Suit jackets", "Shirts")
    error = assert_raises(GarmentImport::Error) { GarmentImport.new.from_page(html, source_url: "x") }
    assert_equal "not_supported", error.code
  end

  test "reads a resale listing's own measurements, skipping style tags between label and value" do
    garment = GarmentImport.new.from_page(page("resale-coat"), source_url: "https://shop.example/coat")

    assert_equal "coat", garment[:garment]
    assert_equal GarmentImport::COLORS["charcoal"], garment[:color]
    chart = garment[:chart]
    assert_equal [ "in", "garment", [ "waist" ] ], chart.values_at(:unit, :kind, :missing)
    size = chart[:sizes].sole
    assert_equal "L / US42, IT52", size["name"]
    assert_in_delta 46.5 * 2.54, size["chest"], 0.01
    # 34.5" was measured from the back of the neck; from the shoulder seam it's 34.5" minus half of 18".
    assert_in_delta (34.5 - 9) * 2.54, size["sleeve"], 0.01
  end

  # The resale coat fixture, rewritten as a different listing: name, description and "Fabric" field.
  def resale(name, description, fabric: nil)
    html = page("resale-coat").gsub("Wool Overcoat", name).gsub("Charcoal wool overcoat.", description).gsub(%("category":"Coats",), "")
    html = html.sub("</div>\n</body>", "</div>\n<div><div>Fabric</div><div>#{fabric}</div></div>\n</body>") if fabric
    html
  end

  def outerwear = "https://shop.example/products/men/clothing/outerwear/item"

  test "a jacket that says nothing about itself, in the outerwear section, made of leather, is a zip-up" do
    garment = GarmentImport.new.from_page(resale("Jacket", "Jacket. Black.", fabric: "Not listed, feels like leather"), source_url: outerwear)

    assert_equal [ "jacket", "zip", "leather" ], garment.values_at(:garment, :style, :fabric)
    assert_equal GarmentImport::COLORS["black"], garment[:color]
  end

  test "a denim jacket with a point collar is a button-up, coloured by its colour word, not 'denim'" do
    garment = GarmentImport.new.from_page(resale("Denim Jacket", "Denim Jacket. Neutrals. Point Collar.", fabric: "100% Cotton"),
                                          source_url: outerwear)

    assert_equal [ "shirt", "denim" ], garment.values_at(:style, :fabric)
    assert_equal GarmentImport::COLORS["neutrals"], garment[:color]
  end

  test "bombers, and blazers sold as outerwear, are drawn as such" do
    bomber = GarmentImport.new.from_page(resale("Bomber Jacket", "Bomber Jacket. Black."), source_url: outerwear)
    blazer = GarmentImport.new.from_page(resale("Wool Blazer", "Wool Blazer. Navy."), source_url: outerwear)

    assert_equal "bomber", bomber[:style]
    assert_equal "tailored", blazer[:style]
  end

  test "a lining doesn't decide the fabric" do
    garment = GarmentImport.new.from_page(resale("Cashmere Coat", "Cashmere Coat. Black.", fabric: "100% Cashmere; Lining 55% Silk, 45% Cotton"),
                                          source_url: outerwear)

    assert_equal [ "coat", "wool" ], garment.values_at(:garment, :fabric)
    assert_nil garment[:style]
  end

  test "a suit jacket from a shop page is tailored" do
    assert_equal "tailored", GarmentImport.new.from_page(page("navy-suit-jacket"), source_url: "https://shop.example/navy")[:style]
  end

  KIWI_CHART = {
    "sizings" => [ {
      "name" => "Generic Tops",
      "tables" => { "t1" => { "data" => [
        [ "S/M/L", "US", "UK", "EU", "IT" ], [ "S", "38", "38", "39", "48" ], [ "M", "40", "40", "40", "50" ], [ "L", "42", "42", "41", "52" ]
      ].map { |row| row.map { { "type" => "single", "value" => it } } } } }
    } ]
  }.freeze

  test "reads a Kiwi Sizing shop's chart from Kiwi, and a down hoodie as a zip-up jacket" do
    asked = nil
    import = GarmentImport.new(fetch_json: ->(url) { asked = url; KIWI_CHART })
    garment = import.from_page(page("kiwi-hoodie"), source_url: "https://shop.example/products/hoodie")

    query = Rack::Utils.parse_query(URI(asked).query)
    assert asked.start_with?(GarmentImport::KIWI_SIZING)
    assert_equal [ "sample-shop.myshopify.com", "123456", "Hoodies" ], query.values_at("shop", "product", "type")
    assert_equal %(hoodies,mens,Sample "Outdoor"), query["tags"]
    assert_equal [ "jacket", "zip", "nylon" ], garment.values_at(:garment, :style, :fabric)
    assert_equal GarmentImport::COLORS["black"], garment[:color]
  end

  test "a size conversion chart is read as the chest each size fits" do
    import = GarmentImport.new(fetch_json: ->(_) { KIWI_CHART })
    chart = import.from_page(page("kiwi-hoodie"), source_url: "x")[:chart]

    assert_equal [ "sizes", %w[waist shoulders sleeve length] ], chart.values_at(:kind, :missing)
    assert_equal [ "S / US 38", "M / US 40", "L / US 42" ], chart[:sizes].map { it["name"] }
    # A US 40 fits a 40 inch chest; the jacket is that plus a regular cut's room.
    assert_in_delta 40 * 2.54 + 11, chart[:sizes][1]["chest"], 0.01
  end

  test "a sweatshirt hoodie is still turned away" do
    import = GarmentImport.new(fetch_json: ->(_) { KIWI_CHART })
    html = page("kiwi-hoodie").gsub(/Nylon\. .*?Color: Black/, "Cotton fleece. Kangaroo pocket.")
    error = assert_raises(GarmentImport::Error) { import.from_page(html, source_url: "x") }
    assert_equal "not_supported", error.code
  end

  test "a Kiwi shop whose chart service is down says there's no chart" do
    import = GarmentImport.new(fetch_json: ->(_) { raise GarmentImport::Fetcher::Error, "down" })
    error = assert_raises(GarmentImport::Error) { import.from_page(page("kiwi-hoodie"), source_url: "x") }
    assert_equal "no_size_chart", error.code
  end

  test "a sport coat is a jacket, not a coat" do
    html = page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", "Navy Sport Coat")
    assert_equal "jacket", GarmentImport.new.from_page(html, source_url: "x")[:garment]
  end

  test "reads a trousers chart, inseam and all" do
    chart = <<~CHART
      Size\tWaist (in)\tSeat\tThigh\tInseam\tLeg opening
      32\t32\t41\t24.5\t32\t16
      34\t34\t43\t25.5\t32\t16.5
    CHART
    garment = GarmentImport.from_text(chart, garment: "trousers")

    assert_equal "trousers", garment[:garment]
    first = garment[:chart][:sizes].first
    assert_equal "32", first["name"]
    assert_in_delta 32 * 2.54 + 2.5, first["waist"], 0.01 # a 32 waist chart is for the body, so Fitroom adds the waistband's room
    assert_in_delta 32 * 2.54, first["inseam"], 0.01
    assert_in_delta 16 * 2.54, first["leg_opening"], 0.01
  end

  test "a page for trousers is read as trousers" do
    html = page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", "Navy Wool Trousers").gsub("Suit jackets", "Trousers")
      .sub(%r{<table>.*</table>}m, <<~TABLE)
        <table><tr><th>Size</th><th>Waist</th><th>Seat</th><th>Inseam</th></tr>
        <tr><td>32</td><td>33.5</td><td>41</td><td>32</td></tr><tr><td>34</td><td>35.5</td><td>43</td><td>32</td></tr></table>
      TABLE
    garment = GarmentImport.new.from_page(html, source_url: "x")

    assert_equal "trousers", garment[:garment]
    assert_equal "garment", garment[:chart][:kind]
    assert_in_delta 33.5 * 2.54, garment[:chart][:sizes].first["waist"], 0.01
  end
end
