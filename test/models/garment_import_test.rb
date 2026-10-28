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
    html = page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", "Navy Wool Scarf").gsub("Suit jackets", "Accessories")
    error = assert_raises(GarmentImport::Error) { GarmentImport.new.from_page(html, source_url: "x") }
    assert_equal "not_supported", error.code
  end

  def top(name, category = "Tops")
    html = page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", name).gsub("Suit jackets", category)
    GarmentImport.new.from_page(html, source_url: "x")
  end

  test "a T-shirt is a top drawn as a tee, never as a button-up shirt" do
    assert_equal [ "top", "tee" ], top("Ocra Arctic T-Shirt").values_at(:garment, :style)
    assert_equal "tee", top("Ocra Arctic T-Shirt", "Shirts")[:style]
    assert_equal "tee", top("Pima Tee")[:style]
    assert_equal "longsleeve", top("Long Sleeve T-Shirt")[:style]
  end

  test "shirts, sweatshirts and hoodies are tops in their own styles" do
    assert_equal [ "top", "shirt" ], top("Navy Oxford Shirt", "Shirts").values_at(:garment, :style)
    assert_equal "shirt", top("Linen Shirt")[:style]
    assert_equal "sweatshirt", top("Heavyweight Crewneck Sweatshirt")[:style]
    assert_equal "hoodie", top("Pullover Hoodie")[:style]
    # A hoodie that zips all the way down is drawn with a zip; a pullover or a half-zip isn't.
    assert_equal true, top("Striped Zip-Up Hoodie")[:zip]
    assert_nil top("Pullover Hoodie")[:zip]
    assert_nil top("Half-Zip Hoodie")[:zip]
  end

  test "a chart's impossible numbers are left out, to be estimated" do
    chart = GarmentImport::ChartReader::Chart.new(sizes: [ { "name" => "0", "waist" => 73.7, "seat" => 101.6, "leg_opening" => 3.18 } ], unit: "cm", kind: "garment", missing: [])
    size = GarmentImport.new.send(:plausible, chart, "trousers").sizes.first
    assert_nil size["leg_opening"]
    assert_equal 73.7, size["waist"]
  end

  test "pants named for their cloth are pants" do
    pants = GarmentImport.new.from_page(page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", "Tallis Waist Strap Suiting Trouser - Black").gsub("Suit jackets", "Trousers"), source_url: "x")
    assert_equal "trousers", pants[:garment]
  end

  test "a two-colour name is the colour it names first" do
    import = GarmentImport.new
    assert_equal GarmentImport::COLORS["white"], import.send(:color_hex, [ "White / Brown" ])
    assert_equal GarmentImport::COLORS["navy"], import.send(:color_hex, [ "Navy/Grey" ])
    assert_equal GarmentImport::COLORS["black"], import.send(:color_hex, [ nil, "Black cotton jersey" ])
  end

  test "a blend is its main fibre" do
    import = GarmentImport.new
    assert_equal "wool", import.send(:fabric_of, { name: "Mulberry IV Wool Jersey Tee", fabric: "80% Wool / 20% Nylon" }, "top")
    assert_equal "cotton", import.send(:fabric_of, { name: "Shirt", fabric: "60% Cotton / 40% Rayon" }, "top")
    assert_equal "nylon", import.send(:fabric_of, { name: "Track Pant", fabric: "100% Nylon" }, "trousers")
    assert_equal "cotton", import.send(:fabric_of, { name: "Camilla Plunge Shirt", fabric: "76% Lyocell / 22% Nylon / 2% Polyurethane" }, "top")
    assert_equal "nylon", import.send(:fabric_of, { name: "Tee", fabric: "80% Polyamide / 20% Elastane" }, "top")
  end

  test "pull-on pants with an elastic or drawcord waist are marked so, and fit as elastic" do
    pants = ->(name) { GarmentImport.new.from_page(page("navy-suit-jacket").gsub("Navy Wool Suit Jacket", name).gsub("Suit jackets", "Pants"), source_url: "x") }
    assert_equal({ elastic: true }, pants.call("Drawcord Linen Pant")[:cut])
    assert_equal({ elastic: true }, pants.call("Elastic Waist Trouser")[:cut])
    assert_equal({ fit: "loose" }, pants.call("Pleated Wool Trouser")[:cut])
    assert_nil pants.call("Fleece Jogger Drawstring")[:cut]
  end

  test "a romper is a tank tucked into shorts, a jumpsuit a top tucked into pants, one piece" do
    import = GarmentImport.new
    romper = import.send(:one_piece, { name: "Kith Women Aire Plunge Cross Back Romper - Legacy", category: "Rompers", description: "Elasticated straps", sizes: %w[XS S M L], women: true }, "x") { |part, kind| import.send(:usual_for, kind, import.send(:top_style_of, part), part) }
    assert_equal [ "onepiece", "romper" ], romper.values_at(:garment, :style)
    assert_equal [ "tank", "shorts" ], [ romper[:parts][:top][:style], romper[:parts][:trousers][:style] ]
    assert romper[:parts].values.all? { it[:one_piece] }
    jumpsuit = import.send(:one_piece, { name: "Long Sleeve Utility Jumpsuit", category: "Jumpsuits", sizes: %w[S M L] }, "x") { |part, kind| import.send(:usual_for, kind, import.send(:top_style_of, part), part) }
    assert_equal [ "longsleeve", "trousers" ], [ jumpsuit[:parts][:top][:style], jumpsuit[:parts][:trousers][:style] ]
  end

  test "shoes, socks and belts are drawn, in their own styles, with the shop's sizes" do
    import = GarmentImport.new
    kind = ->(name, category) { import.send(:kind_of, { name:, category:, sorted: true }) }
    assert_equal "shoes", kind.("New Balance Made in UK 991v1 Luxe Suede - Cocoa", "Low Top Sneakers")
    assert_equal "shoes", kind.("Dr. Martens Wayborne Boot Mayhem - Dark Brown", "Boots")
    assert_equal "socks", kind.("Kith Classic Crew Sock - White", "Socks")
    assert_equal "belt", kind.("Anderson's Leather Black Belt - Black", "Belts")
    assert_raises(GarmentImport::Error) { kind.("Giorgio Armani & Kith Belt Bag - Tan", "Belts") }
    assert_raises(GarmentImport::Error) { kind.("Kith Boxer Brief - Black", "Underwear") }
    shoe = import.send(:accessory, { name: "Timberland 6 Inch Premium Boot - Wheat", category: "Boots", sizes: %w[8 9 10] }, "shoes", "x")
    assert_equal [ "shoes", "boot" ], shoe.values_at(:garment, :style)
    assert_equal %w[8 9 10], shoe[:chart][:sizes].map { it["name"] }
    assert_equal "loafer", import.send(:accessory, { name: "G.H. Bass Larson Penny Loafer", category: "Shoes" }, "shoes", "x")[:style]
    assert_equal "ankle", import.send(:accessory, { name: "Kith Ankle Sock 3-Pack", category: "Socks" }, "socks", "x")[:style]
    belt = import.send(:accessory, { name: "Leather Belt", category: "Belts", description: "Brass buckle", sizes: [ "Default Title" ] }, "belt", "x")
    assert_equal [ "gold", [ "One size" ] ], [ belt[:buckle], belt[:chart][:sizes].map { it["name"] } ]
  end

  test "shorts whose chart gives their whole length as the inseam are measured from the crotch" do
    chart = GarmentImport::ChartReader::Chart.new(sizes: [ { "name" => "48", "waist" => 87, "inseam" => 58.0 }, { "name" => "50", "waist" => 91, "inseam" => 20.0 } ], unit: "cm", kind: "garment", missing: [])
    shorts = GarmentImport.new.send(:garment, { name: "Cupro Cargo Short", category: "Shorts" }, chart, kind: "trousers", source_url: "x")
    assert_equal [ 28.0, 20.0 ], shorts[:chart][:sizes].map { it["inseam"] }
  end

  test "a short-sleeve shirt is a button-up with short sleeves, and a short-sleeve tee is still a tee" do
    assert_equal "shortshirt", top("by Parra Abstract Mountain Short Sleeve Shirt - Red")[:style]
    assert_equal "shortshirt", top("Camp Collar Shirt")[:style]
    assert_equal "tee", top("Short Sleeve T-Shirt")[:style]
    assert_equal "polo", top("Short Sleeve Polo")[:style]
    # Craig Green files its tees as "Jerseys".
    assert_equal [ "top", "tee" ], top("Craig Green Flatlock Short Sleeve Jersey - White", "Jerseys").values_at(:garment, :style)
  end

  test "polos, tank tops, sweaters and cardigans are drawn as themselves" do
    assert_equal "polo", top("Kith Tilden Polo")[:style]
    assert_equal "tank", top("Kith Crest Ribbed Tank")[:style]
    assert_equal "sweater", top("Wyona Sweater")[:style]
    assert_equal "sweater", top("Merino Crewneck Sweater")[:style]
    assert_equal "shortknit", top("Mock Neck Short Sleeve Sweater")[:style]
    assert_equal "shirt", GarmentImport.new.send(:style_of, { name: "Ell Denim Ford Jacket - Black", category: "Jackets" }, "x")
    assert_equal "shirt", GarmentImport.new.send(:style_of, { name: "Japanese Denim Trucker Jacket", category: "Jackets", description: "Zip pocket at the chest." }, "x")
    assert_equal "jacket", GarmentImport.new.send(:kind_of, { name: "Willy Chavarria Bad Boy Track Jacket - Peacoat", category: "Jackets" })
    assert_equal "jacket", GarmentImport.new.send(:kind_of, { name: "Kith Women Ina II Crochet Cable Zip Track - Incognito", category: "Sweaters" })
    assert_equal "top", GarmentImport.new.send(:kind_of, { name: "Merino Half-Zip Sweater", category: "Sweaters" })
    assert_equal "coat", GarmentImport.new.send(:kind_of, { name: "Susanna Chow Dorothy Suede Maxi Coat - Graphite", category: "Coats" })
    # A coat with no chart gets a coat's usual length, not a tee's.
    coat = GarmentImport.new.send(:usual_sizes, "coat", "tee", { name: "Rick Owens Poiret Coat", sizes: %w[S M L] })
    assert_operator coat.sizes.find { it["name"] == "M" }["length"], :>, 90
    assert_equal "onepiece", GarmentImport.new.send(:kind_of, { name: "Kith Women Aire Plunge Cross Back Romper - Legacy", category: "Rompers" })
    assert_equal "cotton", GarmentImport.new.send(:fabric_of, { name: "Polo", description: "Body 1: 100% Lyocell / Body 2: 60% Viscose / 35% Nylon / 5% Cashmere" }, "top")
    # A cardigan is worn open over a top, as a jacket is, so a tee can go under it.
    assert_equal [ "jacket", "cardigan" ], top("Color-Blocked Cardigan").values_at(:garment, :style)
    assert_equal "sweatshirt", top("Undercover Cindy Sherman Sweatshirt")[:style]
  end

  test "shorts, skirts, leggings and joggers are bottoms in their own styles" do
    import = GarmentImport.new
    read = ->(name, category) { product = { name:, category:, sorted: true }; [ import.send(:kind_of, product), import.send(:bottom_style_of, product) ] }
    assert_equal [ "trousers", "shorts" ], read.("Teatora Wallet Short Resort", "Shorts")
    assert_equal [ "trousers", "skirt" ], read.("Aya Muse Obra Skirt", "Mini Skirts")
    assert_equal [ "trousers", "leggings" ], read.("Kith Women Avery Tights", "Leggings")
    assert_equal [ "trousers", "joggers" ], read.("Loose Fit Sweatpant", "Sweatpants")
    assert_equal [ "trousers", "jeans" ], read.("Maria Slim Bootcut Jean", "Jeans")
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
    assert_equal "centre_back_guessed", chart[:sleeve_from]
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

  test "a listing with only its size gets that size's usual measurements, marked as a guess" do
    garment = GarmentImport.new.from_page(page("resale-tee"), source_url: "https://shop.example/tee")

    assert_equal [ "top", "longsleeve", "cotton" ], garment.values_at(:garment, :style, :fabric)
    assert_equal "https://images.example/tee_1.jpg", garment[:image_url]
    chart = garment[:chart]
    assert_equal [ "sizes", [ "waist" ] ], chart.values_at(:kind, :missing)
    size = chart[:sizes].sole
    assert_equal "M", size["name"]
    assert_in_delta 108, size["chest"], 0.01
    assert_operator size["sleeve"], :>, 55
  end

  test "a utility jacket that zips is drawn as a zip-up" do
    garment = GarmentImport.new.from_page(resale("Utility Jacket", "Nylon utility jacket. Two-way zipper closure."), source_url: outerwear)
    assert_equal [ "jacket", "zip", "nylon" ], garment.values_at(:garment, :style, :fabric)
  end

  test "a Shopify shop's product is read from its JSON, with its Kiwi Sizing chart" do
    asked = []
    answers = {
      "https://shop.example/products/graphic-tee.json" => { "product" => {
        "id" => 42, "title" => "Graphic Tee - White", "vendor" => "Sample Label", "product_type" => "Short Sleeve Tees",
        "tags" => "tees, mens", "body_html" => "<p>Logo print on the front</p><p>Material: 100% Cotton</p>",
        "images" => [ { "src" => "https://cdn.example/tee.jpg" } ] } },
      "https://shop.example/meta.json" => { "myshopify_domain" => "sample-shop.myshopify.com" }
    }
    import = GarmentImport.new(fetch_json: ->(url) { asked << url; answers.fetch(url) { KIWI_CHART } })
    garment = import.from_shopify("https://shop.example/collections/tops/products/graphic-tee")

    assert_equal [ "top", "tee", "cotton" ], garment.values_at(:garment, :style, :fabric)
    assert_equal [ "Graphic Tee - White", "https://cdn.example/tee.jpg" ], garment.values_at(:name, :image_url)
    assert_equal GarmentImport::COLORS["white"], garment[:color]
    kiwi = Rack::Utils.parse_query(URI(asked.last).query)
    assert_equal [ "sample-shop.myshopify.com", "42", "tees,mens" ], kiwi.values_at("shop", "product", "tags")
  end

  test "a Shopify product the browser read, with only a size conversion table, gets guessed sizes named as the shop names them" do
    cell = ->(value) { { "type" => "single", "value" => value } }
    sizing = { "sizings" => [ { "tables" => { "a" => { "data" => [
      [ "S/M/L", "1/2/3", "US" ].map(&cell), [ "S", "1", "38" ].map(&cell), [ "M", "2", "40" ].map(&cell), [ "L", "3", "42" ].map(&cell)
    ] } } } ] }
    given = { "shop" => "sample-shop.myshopify.com", "sizing" => sizing, "product" => {
      "id" => 7, "handle" => "label-tee-2", "title" => "Label Cindy Tee - White", "vendor" => "Label", "product_type" => "Short Sleeve Tees",
      "body_html" => "<p>Graphic printed at front</p>", "images" => [ { "src" => "//cdn.shopify.com/tee.jpg" } ] } }
    import = GarmentImport.new(fetch_json: ->(_) { raise "the browser's answers are used, not fetched again" })
    garment = import.from_shopify("https://shop.example/collections/tops/products/label-tee-2", given:)

    assert_equal [ "top", "tee", "https://cdn.shopify.com/tee.jpg" ], garment.values_at(:garment, :style, :image_url)
    assert_equal "sizes", garment[:chart][:kind]
    assert_includes garment[:chart][:sizes].map { it["name"] }, "M (2)"
    assert_nil import.from_shopify("https://shop.example/products/other-tee", given:), "details for another product are ignored"
  end

  test "a shrunken sweater hoodie with a two-way zip is a fitted knit top, not a zip jacket" do
    # Kith's "Adley Shrunken Multi Sweater Hoodie" (women's), as the browser reads it: a cotton-viscose knit
    # in the women's hoodies collection. Its "two-way zipper" used to make it outerwear, like a down hoodie.
    cell = ->(value) { { "type" => "single", "value" => value } }
    sizing = { "sizings" => [ { "tables" => { "a" => { "data" => [
      [ "Size", "Chest", "Shoulders", "Sleeve Length", "Body Length" ], [ "XS", "30", "14", "25.125", "19.25" ], [ "S", "32", "14.5", "25.5", "20" ],
      [ "M", "34", "15", "25.875", "20.75" ], [ "L", "36", "15.5", "26.25", "21.5" ], [ "XL", "39", "16.25", "26.75", "22.25" ]
    ].map { it.map(&cell) } } } } ] }
    given = { "shop" => "kithnyc.myshopify.com", "sizing" => sizing, "product" => {
      "id" => 9, "handle" => "khwsw0106-265", "title" => "Kith Women Adley Shrunken Multi Sweater Hoodie - Legacy", "vendor" => "Kith Women",
      "product_type" => "Hoodies", "tags" => "hoodies, sweaters, Tops, wmns",
      "body_html" => "<p>Cotton blend with a fixed hood, a Kith-branded two-way zipper on the front, Kith embroidery at the chest, and ribbed sleeve cuffs, sides, and hem.</p><p>Material: 60% Cotton / 40% Viscose</p>",
      "images" => [ { "src" => "//cdn.shopify.com/adley.jpg" } ], "options" => [ { "name" => "Size", "values" => %w[XS S M L XL] } ] } }
    import = GarmentImport.new(fetch_json: ->(_) { raise "the browser's answers are used" })
    garment = import.from_shopify("https://kith.com/collections/womens-apparel-hoodies/products/khwsw0106-265", given:)

    assert_equal [ "top", "hoodie", "knit", true, true ], garment.values_at(:garment, :style, :fabric, :zip, :women)
    assert_equal({ fit: "fitted", stretch: true }, garment[:cut])
    assert_nil garment[:cropped]
    assert_equal "garment", garment[:chart][:kind]
    assert_in_delta 34 * 2.54, garment[:chart][:sizes].find { it["name"] == "M" }["chest"], 0.01
    # Its 25.875" sleeve (65.7 cm) is from the shoulder seam: the shop's flat photo shows the cuffs about 24 cm
    # below the hem, as 65.7 cm from the shoulder gives (from the centre back, 46.7 cm, they'd end at the hem).
    # Extra-long sleeves on a shrunken body are the look; they aren't read as a centre back measurement.
    assert_in_delta 25.875 * 2.54, garment[:chart][:sizes].find { it["name"] == "M" }["sleeve"], 0.01
    assert_nil garment[:chart][:sleeve_from]
    # The same hoodie, insulated, is still a jacket; so is a knit zip-up with no hood (see kind_of).
    down = given.merge("product" => given["product"].merge("title" => "Lodge Hoodie - Black", "body_html" => "<p>Nylon, downproof. Two-way zipper closure.</p>"))
    assert_equal [ "jacket", "zip" ], import.from_shopify("https://kith.com/products/khwsw0106-265", given: down).values_at(:garment, :style)
    # A plain fleece hoodie isn't fitted ("ribbed fitted cuffs" don't count), and its fleece isn't a knit.
    fleece = given.merge("product" => given["product"].merge("title" => "Kith Williams III Hoodie - Black", "body_html" => "<p>Cotton fleece. Kangaroo pocket. Ribbed fitted cuffs and hem.</p>"))
    plain = import.from_shopify("https://kith.com/products/khwsw0106-265", given: fleece)
    assert_equal [ "top", "hoodie", "cotton", nil ], plain.values_at(:garment, :style, :fabric, :cut)
    # A sweater is a knit whatever its fibre; a slim-fit woven shirt is fitted but doesn't stretch.
    assert_equal "knit", import.send(:fabric_of, { name: "Merino Crewneck Sweater", fabric: "100% Merino Wool" }, "top")
    assert_equal({ fit: "fitted", stretch: false }, import.send(:top_cut, { name: "Slim Fit Oxford Shirt", description: "Cotton poplin." }))
  end

  test "a sleeve measured from the centre back is read from the shoulder seam, once, at import" do
    # A women's knit whose sleeves are longer than any arm: the usual 58 cm arm plus half the shoulders.
    cb = GarmentImport.from_text("Size | Chest | Shoulders | Sleeve | Length (cm)\nS | 84 | 37 | 75 | 58\nM | 88 | 38 | 76 | 60\nL | 92 | 39 | 77 | 62\n", garment: "top")
    assert_equal "centre_back_guessed", cb[:chart][:sleeve_from]
    assert_equal [ 56.5, 57.0, 57.5 ], cb[:chart][:sizes].map { it["sleeve"] }
    # A men's T-shirt's short sleeve is what it says.
    tee = GarmentImport.from_text("Size | Chest | Shoulders | Sleeve | Length (cm)\nM | 104 | 46 | 22 | 70\nL | 110 | 48 | 23 | 72\n", garment: "top")
    assert_nil tee[:chart][:sleeve_from]
    assert_equal [ 22.0, 23.0 ], tee[:chart][:sizes].map { it["sleeve"] }
    # A chart that says its sleeve runs from the centre back is converted even when the sleeve is short.
    said = GarmentImport.from_text("Size | Chest | Shoulders | Sleeve (from center back) | Length (cm)\nM | 104 | 46 | 44 | 70\nL | 110 | 48 | 45 | 72\n", garment: "top")
    assert_equal "centre_back", said[:chart][:sleeve_from]
    assert_equal [ 21.0, 21.0 ], said[:chart][:sizes].map { it["sleeve"] }
    # A men's long sleeve from the shoulder (66 cm on a 65 cm arm) is left alone; a chart with no shoulders
    # takes off half a man's usual 46.
    long = GarmentImport.from_text("Size | Chest | Shoulders | Sleeve | Length (cm)\nM | 108 | 47 | 66 | 72\nL | 114 | 49 | 67 | 74\n", garment: "top")
    assert_nil long[:chart][:sleeve_from]
    raglan = GarmentImport.from_text("Size | Chest | Sleeve | Length (cm)\nM | 108 | 86 | 72\nL | 114 | 88 | 74\n", garment: "top")
    assert_equal [ 63.0, 65.0 ], raglan[:chart][:sizes].map { it["sleeve"] }
    assert_equal "centre_back_guessed", raglan[:chart][:sleeve_from]
  end

  test "a site that turns away every app says so at once, without asking it" do
    error = assert_raises(GarmentImport::Error) { GarmentImport.from_url("https://www.therealreal.com/products/men/clothing/shirts/a-shirt-x1") }
    assert_match(/therealreal\.com doesn't let apps read its pages.*just its size/, error.message)
  end

  test "a link that isn't a Shopify product is left to the page" do
    assert_nil GarmentImport.new(fetch_json: ->(_) { raise GarmentImport::Fetcher::Error, "no" }).from_shopify("https://shop.example/item/1")
  end

  test "a pasted size on its own gets that size's usual measurements" do
    garment = GarmentImport.from_text("M", garment: "top")
    assert_equal [ "top", "tee" ], garment.values_at(:garment, :style)
    assert_equal "sizes", garment[:chart][:kind]
    assert_in_delta 106, garment[:chart][:sizes].sole["chest"], 0.01
  end

  test "a sweatshirt hoodie is a top, drawn as a hoodie" do
    import = GarmentImport.new(fetch_json: ->(_) { KIWI_CHART })
    html = page("kiwi-hoodie").gsub(/Nylon\. .*?Color: Black/, "Cotton fleece. Kangaroo pocket.").gsub("Sample Down Hoodie", "Sample Fleece Hoodie")
    garment = import.from_page(html, source_url: "x")
    assert_equal [ "top", "hoodie", "cotton" ], garment.values_at(:garment, :style, :fabric)
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

  test "pants with no size chart get the waist sizes their page offers, to pick from on the mannequin" do
    html = <<~HTML
      <html><head><title>Athletic-Fit Linen-Blend Pant | Banana Republic Factory</title></head><body>
        <h1>Athletic-Fit Linen-Blend Pant</h1><p>$39.99</p>
        <div class="pdp-dimension--waist"><h3>Waist</h3><button>28W</button><button>30W</button><button>32W</button><button>34W</button></div>
        <div class="pdp-dimension--length"><h3>Length</h3><button>30L</button><button>32L</button></div>
        <a href="/size-guide">Size Guide</a>
      </body></html>
    HTML
    garment = GarmentImport.new(fetch_page: ->(_) { "<html></html>" }).from_page(html, source_url: "https://bananarepublicfactory.gapfactory.com/browse/product.do?pid=1")

    assert_equal [ "trousers", "trousers" ], garment.values_at(:garment, :style)
    assert_equal %w[28 30 32 34], garment[:chart][:sizes].map { it["name"] }
    assert_in_delta 32 * 2.54, garment[:chart][:sizes][2]["waist"], 0.1
  end

  test "pants whose page shows no sizes at all still get the usual waists" do
    garment = GarmentImport.new.from_page("<html><title>Pleated Wool Trousers</title></html>", source_url: "x")

    assert_equal "trousers", garment[:garment]
    assert_operator garment[:chart][:sizes].size, :>=, 5
  end

  test "a top with no chart gets the letter sizes its page lists" do
    html = <<~HTML
      <html><title>Heavyweight Pocket Tee</title><body>
        <fieldset class="size-selector"><label>S</label><label>M</label><label>L</label><label>XL</label></fieldset>
      </body></html>
    HTML
    garment = GarmentImport.new.from_page(html, source_url: "x")

    assert_equal %w[S M L XL], garment[:chart][:sizes].map { it["name"] }
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

  test "clothes read from a photo get every usual size of that kind" do
    hoodie = GarmentImport.from_photo(kind: "top", style: "hoodie")
    assert_equal [ "top", "hoodie", "Hoodie from your photo" ], hoodie.values_at(:garment, :style, :name)
    assert_equal "sizes", hoodie[:chart][:kind]
    assert_equal %w[XS S M L XL XXL XXXL], hoodie[:chart][:sizes].map { it["name"] }

    pants = GarmentImport.from_photo(kind: "trousers")
    assert_equal "trousers", pants[:garment]
    assert_in_delta 81.3, pants[:chart][:sizes].find { it["name"] == "32" }["waist"], 0.1
  end

  test "a dress is a dress, not a jacket, with long sleeves when its listing says so" do
    import = GarmentImport.new(fetch_json: ->(_) { raise GarmentImport::Fetcher::Error, "no chart" })
    page = resale("Cut-Out Long-Sleeve Maxi Dress", "Ribbed knit maxi dress with long sleeves.")
    garment = import.from_page(page, source_url: "x")
    assert_equal [ "top", "dress" ], garment.values_at(:garment, :style)
    assert_operator garment[:chart][:sizes].sole["sleeve"], :>, 40

    assert_equal "top", GarmentImport.new.send(:kind_of, { name: "Oxford Dress Shirt" })
    assert_not_equal "dress", GarmentImport.new.send(:top_style_of, { name: "Oxford Dress Shirt" })
  end

  def trouser_chart(inseams) = GarmentImport::ChartReader::Chart.new(sizes: inseams.each_with_index.map { |inseam, i| { "name" => (44 + 2 * i).to_s, "waist" => 79.0 + 4 * i, "seat" => 108.0 + 4 * i, "inseam" => inseam } }, unit: "cm", kind: "garment", missing: [])

  test "pants the shop calls baggy, wide, relaxed or pleated are cut loose; slim, skinny or tapered ones slim" do
    import = GarmentImport.new
    cut = ->(name, description = "", style = "trousers") { import.send(:bottoms_cut, { name:, description: }, style, trouser_chart([ 81, 81 ])) }
    assert_equal({ fit: "loose" }, cut.("Loewe Anagram Baggy Jeans - Jeans Blue", "", "jeans"))
    assert_equal({ elastic: true, fit: "loose" }, cut.("Giorgio Armani & Kith Pleated Pant - Senape", "Elasticated waistband with drawcord"))
    assert_equal({ fit: "loose" }, cut.("Giorgio Armani & Kith Cargo Pant - Sabbia", "Pleats at the waist. Relaxed, straight leg fit"))
    assert_equal({ fit: "loose" }, cut.("Wide-Leg Trouser"))
    assert_equal({ fit: "slim" }, cut.("Slim Tapered Chino"))
    assert_nil cut.("Giorgio Armani & Kith Cashmere Trouser - Iron", "Button closure at the waistband. Straight-leg fit")
    # A wide waistband isn't a wide leg; leggings aren't cut loose or slim.
    assert_nil cut.("Twill Trouser", "Wide waistband")
    assert_nil cut.("Slim Leggings", "", "leggings")
  end

  test "trousers sold unhemmed are marked so: every size far longer than a leg, or the listing says it" do
    import = GarmentImport.new
    hem = ->(inseams, description = "", name = "Trouser") { import.send(:bottoms_cut, { name:, description: }, "trousers", trouser_chart(inseams)) }
    # Armani & Kith's Virgin Wool Trouser: 104 cm in every size. Its Cashmere Trouser's 88 to 89 cm is hemmed.
    assert_equal({ hem: "unfinished" }, hem.([ 103.97 ] * 5))
    assert_nil hem.([ 87.8, 87.8, 87.8, 88.3, 88.8 ])
    assert_equal({ hem: "unfinished" }, hem.([ 82 ] * 3, "Unhemmed, to be finished to your length."))
    # A raw hem is a cut edge (frayed jeans), unless the legs are long too.
    assert_nil hem.([ 82 ] * 3, "Raw hem", "Raw Hem Jean")
  end

  test "French and Italian sizes are read as the waists they're for, not as inches" do
    import = GarmentImport.new
    # Loewe's Anagram Baggy Jeans come in French 38 to 46: a 44 is a 34 in waist, not a 44.
    loewe = import.send(:usual_trousers, { name: "Loewe Anagram Baggy Jeans", sizes: %w[38 40 42 44 46] })
    assert_in_delta 34 * 2.54, loewe.sizes.find { it["name"] == "44" }["waist"], 0.1
    italian = import.send(:usual_trousers, { name: "Wool Trouser", sizes: %w[44 46 48 50 52 54] })
    assert_in_delta 32 * 2.54, italian.sizes.find { it["name"] == "48" }["waist"], 0.1
    # Waist sizes stay waist sizes.
    levis = import.send(:usual_trousers, { name: "501 Jean", sizes: %w[28 29 30 31 32 33 34 36 38 40] })
    assert_in_delta 34 * 2.54, levis.sizes.find { it["name"] == "34" }["waist"], 0.1
  end

  test "a women's jacket or coat with no chart gets a women's usual sizes" do
    import = GarmentImport.new
    jacket = import.send(:usual_sizes, "jacket", "zip", { women: true, sizes: %w[XS S M L XL] }).sizes.find { it["name"] == "M" }
    assert_equal [ 101, 40.5, 57, 60 ], jacket.values_at("chest", "shoulders", "sleeve", "length")
    assert_operator import.send(:usual_sizes, "coat", nil, { women: true, sizes: %w[S M L] }).sizes.find { it["name"] == "M" }["shoulders"], :<, 42
  end

  test "a jacket made to end at the waist, and an oversized top or jacket, say so in their cut" do
    import = GarmentImport.new
    assert_equal({ ends: "waist" }, import.send(:jacket_cut, { name: "Kith Women Ina II Terry Track Zip - Astronaut" }))
    assert_equal({ ends: "waist" }, import.send(:jacket_cut, { name: "Giorgio Armani & Kith Lamb Leather Aviator Blouson Jacket - Meteorite" }))
    assert_equal({ fit: "oversized" }, import.send(:jacket_cut, { name: "Utility Jacket", description: "An oversized fit with dropped shoulders." }))
    assert_nil import.send(:jacket_cut, { name: "Kith Vancouver Dejan Utility Jacket - Kindling", description: "Nylon. Mock neckline." })
    assert_equal({ fit: "oversized" }, import.send(:top_cut, { name: "Boxy Pocket Tee", description: "Cotton." }))
    assert_equal "bomber", import.send(:style_of, { name: "Giorgio Armani & Kith Lamb Leather Aviator Blouson Jacket - Meteorite", category: "Leather Jackets" }, "x")
  end

  test "a long sleeve the shop photo shows hanging past the hem is read from the shoulder, not the centre back" do
    # Kith Women's Camilla Plunge Shirt (inches): an L's sleeve is 27.6 in (70 cm) on 15.5 in shoulders and a
    # 22 in body. From the centre back that's a 50 cm, three-quarter sleeve; the photo shows long ones,
    # reaching about 1.45 times the body's length.
    rows = [ [ 14, 33, 26.83, 20.5 ], [ 14.5, 35, 27.08, 21 ], [ 15, 37, 27.33, 21.5 ], [ 15.5, 39, 27.58, 22 ], [ 16, 41, 27.83, 22.5 ], [ 16.5, 43, 28.08, 23 ] ]
    sizes = %w[XS S M L XL XXL].zip(rows).map { |name, row| { "name" => name }.merge(%w[shoulders chest sleeve length].zip(row.map { (it * 2.54).round(2) }).to_h) }
    chart = GarmentImport::ChartReader::Chart.new(sizes:, unit: "in", kind: "garment", missing: [ "waist" ])
    import = GarmentImport.new

    guessed = import.send(:shoulder_sleeves, chart, { women: true })
    assert_equal "centre_back_guessed", guessed.sleeve_from
    seen = import.send(:shoulder_sleeves, chart, { women: true, shape: { sleeve: 2.66, length: 1.84 } })
    assert_nil seen.sleeve_from
    assert_in_delta 70.05, seen.sizes.find { it["name"] == "L" }["sleeve"], 0.01
    # A photo of sleeves that end at the wrist (as long as the body) keeps the centre-back reading.
    assert_equal "centre_back_guessed", import.send(:shoulder_sleeves, chart, { women: true, shape: { sleeve: 1.7, length: 1.84 } }).sleeve_from
  end
end
