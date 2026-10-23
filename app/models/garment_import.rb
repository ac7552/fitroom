# Turns a pasted product link, or a pasted size chart, into a garment Fitroom can fit (a top, jacket, coat or
# trousers): what it is, its colour, and its finished measurements per size. It reads the shop's page once when asked and keeps
# nothing about who asked; the parsed garment is cached briefly by link so a second look doesn't
# refetch the page.
class GarmentImport
  class Error < StandardError
    attr_reader :code

    def initialize(code, message)
      @code = code
      super(message)
    end
  end

  UNSUPPORTED = /shorts?\b|skirt|shoe|sneaker|boot|sock|\btie\b|belt|\bhat\b|\bcap\b|scarf|bag\b/i
  # Dresses (a "dress shirt" or "dress pants" isn't one), drawn as a top cut long.
  DRESSES = /\b(?:dress(?:es)?(?!\s*(?:shirts?|pants|trousers|shoes?|socks|coats?|jackets?|boots?)\b)|gowns?|maxi|midi|sundress|frock|kaftan|caftan)\b/i
  JACKETS = /jacket|blazer|suit|coat|sport ?coat|tuxedo|dinner|overshirt|shacket/i
  # T-shirts, shirts, polos, sweatshirts, hoodies and knitwear: worn on the body, under a jacket.
  TOPS = /t-?shirt|\btees?\b|shirt|polo|henley|tank\b|sweatshirt|crewneck|hoodie|hooded|sweater|jumper|cardigan|pullover|knit\b|\btop\b/i
  # How a top looks, for drawing it: the first match in its name wins, then in its category, else a tee.
  # "T-shirt" is checked before "shirt", so a T-shirt is never drawn as a button-up.
  TOP_STYLES = [
    [ "dress", DRESSES ],
    [ "hoodie", /hoodie|hooded/i ],
    [ "longsleeve", /long[- ]?sleeve.*\b(t[- ]?shirt|tee)|\b(t[- ]?shirt|tee)s?\b.*long[- ]?sleeve/i ],
    [ "tee", /\bt[- ]?shirts?\b|\btees?\b/i ],
    [ "sweatshirt", /sweatshirt|sweater|jumper|pullover|crew ?neck|knit\b|cardigan|fleece/i ],
    [ "shirt", /oxford|flannel|button[- ]?(down|up|front)|poplin|dress shirt|chambray/i ],
    [ "longsleeve", /long[- ]?sleeve|\bl\/s\b|henley/i ],
    [ "tee", /polo|tank\b/i ],
    [ "shirt", /shirts?\b/i ]
  ].freeze
  TROUSERS = /trouser|pants?\b|jeans?\b|chinos?\b|slacks/i
  # Worn over tailoring and cut long; fitted with more room and no "right" length.
  COATS = /overcoat|topcoat|top coat|car coat|trench|peacoat|pea coat|parka|duffle|\bcoat\b/i
  NOT_COATS = /sport ?coat|suit|blazer|tuxedo/i
  # A "hoodie" that's insulated or zips up with a hood is outerwear (Canada Goose calls jackets hoodies).
  HOODED_OUTERWEAR = /\bdown\b|downproof|puffer|quilted|insulated|padded|parka|windbreaker|shell|zip(?:per)? closure|two-way zip/i
  # Kiwi Sizing's chart API, which many Shopify shops load their size charts from (see Page#kiwi_sizing).
  KIWI_SIZING = "https://app.kiwisizing.com/api/getSizingChart"

  # How a jacket looks, so the 3D view draws the right one: tailored (blazers, suit and sport jackets),
  # shirt (button-front denim, trucker and work jackets), bomber, or zip (most other outerwear). First match wins.
  STYLES = [
    [ "tailored", /blazer|suit|sport ?coat|tuxedo|dinner jacket|smoking jacket|lapel/i ],
    [ "bomber", /bomber|varsity|letterman|flight jacket|ma-1|baseball jacket|harrington/i ],
    [ "zip", /two-way zip|zip(?:per)? closure|full[- ]zip|zip[- ]up|front zip/i ],
    [ "shirt", /denim jacket|jean jacket|trucker|chore|overshirt|shirt[- ]jacket|shacket|work jacket|field jacket|utility|safari|chambray|button[- ](front|closure|up)|point collar/i ],
    [ "zip", /zip|moto\b|biker|leather jacket|shearling|puffer|down jacket|windbreaker|anorak|track jacket|blouson|fleece/i ]
  ].freeze
  # Shops' outerwear sections, where a jacket that says nothing else is more likely casual than tailored.
  OUTERWEAR = /outerwear|coats?[-_ ](and|&)[-_ ]jackets|jackets?[-_ ](and|&)[-_ ]coats/i

  # What the cloth looks like, from the product's name and description, so the 3D view can draw its surface.
  FABRICS = [
    [ "denim", /denim|jean|trucker|chambray/i ],
    [ "leather", /leather|suede|biker|moto\b/i ],
    [ "nylon", /nylon|puffer|down\b|quilted|shell|windbreaker|anorak|parka/i ],
    [ "wool", /wool|cashmere|tweed|flannel|camel hair|alpaca|mohair/i ],
    [ "cotton", /cotton|canvas|chore|field|overshirt|work jacket|twill|corduroy/i ]
  ].freeze

  # Fabric colours a jacket is likely to be, as the 3D view should draw them.
  COLORS = {
    "navy" => "#1f2a4a", "midnight" => "#1a2038", "charcoal" => "#35383e", "black" => "#151619",
    "grey" => "#73777f", "gray" => "#73777f", "blue" => "#2c4a8f", "brown" => "#5a3d2b",
    "tan" => "#a9845b", "camel" => "#b38a5c", "beige" => "#c2ad8c", "khaki" => "#a99a72",
    "olive" => "#545b39", "green" => "#3e5240", "burgundy" => "#5c1e2a", "wine" => "#5c1e2a",
    "white" => "#e9e6df", "ivory" => "#e9e4d6", "cream" => "#e6dcc6",
    "indigo" => "#2b3f66", "neutrals" => "#b9ad98", "stone" => "#b8b0a0", "red" => "#7a2a2a"
  }.freeze
  DEFAULT_COLOR = "#2a3552"

  # shop_data: a Shopify product's details as the person's own browser read them ({ "product", "shop",
  # "sizing" }), for shops that answer browsers quickly but stall or turn away apps (see from_shopify).
  def self.from_url(url, shop_data: nil)
    url = url.to_s.strip
    if shop_data.is_a?(Hash) && (garment = new.from_shopify(url, given: shop_data))
      photo = shop_data["photo"].to_s
      return photo.match?(BROWSER_PHOTO) && photo.bytesize < 3_500_000 ? garment.except(:image_url).merge(photo:) : with_photo(garment)
    end
    Rails.cache.fetch([ "garment_import", FORMAT, Digest::SHA256.hexdigest(url) ], expires_in: 1.hour) do
      import = new
      (import.from_shopify(url) || import.from_page(Fetcher.get(url), source_url: url)).then { with_photo(it) }
    end
  rescue Fetcher::Error => e
    raise Error.new("fetch_failed", e.message)
  end

  KINDS = %w[top jacket coat trousers].freeze
  BROWSER_PHOTO = %r{\Adata:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+\z}
  # Bump when what an import returns changes, so cached imports from before aren't served.
  FORMAT = 9

  # The shop's main product photo, fetched here and sent to the page inline, so the person's browser never
  # contacts the shop's image server and the page can read the photo's colours. Optional: a garment
  # without one still fits.
  def self.with_photo(garment)
    url = garment.delete(:image_url)
    return garment unless url

    bytes, type = Fetcher.get_image(url)
    garment.merge(photo: "data:#{type};base64,#{Base64.strict_encode64(bytes)}")
  rescue Fetcher::Error
    garment
  end

  # garment: what a pasted chart is for ("top", "jacket", "coat" or "trousers"); a link works it out from the page.
  def self.from_text(text, garment: "jacket") = new.from_text(text, garment:)

  # Clothes from a person's own photo, which the page reads for what they are (kind and style) and which
  # stays on their device: every usual size of that kind of thing, marked as guessed.
  PHOTO_NAMES = {
    "top" => { "tee" => "T-shirt", "longsleeve" => "Long-sleeve T-shirt", "sweatshirt" => "Sweatshirt", "hoodie" => "Hoodie", "shirt" => "Shirt",
               "dress" => "Dress", "dress_long" => "Long-sleeve dress" },
    "jacket" => { "zip" => "Zip-up jacket", "bomber" => "Bomber jacket", "shirt" => "Shirt jacket", "tailored" => "Blazer" },
    "coat" => {}, "trousers" => {}
  }.freeze

  def self.from_photo(kind:, style: nil) = new.from_photo(kind:, style:)

  def from_photo(kind:, style: nil)
    kind = KINDS.include?(kind.to_s) ? kind.to_s : "top"
    style = PHOTO_NAMES.fetch(kind)[style.to_s] ? style.to_s : nil
    name = PHOTO_NAMES.fetch(kind)[style] || { "top" => "Top", "jacket" => "Jacket", "coat" => "Coat", "trousers" => "Pants" }[kind]
    product = { name: "#{name} from your photo", brand: nil, color: nil, category: nil, description: nil }
    chart = if kind == "trousers" then usual_trousers
            elsif style.to_s.start_with?("dress") then DressCut.usual_sizes(DressCut.read(product))
            else usual_sizes(kind, style || "tee")
            end
    style = "dress" if style == "dress_long"
    garment(product, chart, kind:, source_url: nil).merge(style ? { style: } : {})
  end

  # fetch_json, fetch_page: read a size chart service's answer, or a shop's size guide page (stubbed in tests).
  def initialize(fetch_json: Fetcher.method(:get_json), fetch_page: Fetcher.method(:get))
    @fetch_json = fetch_json
    @fetch_page = fetch_page
  end

  def from_page(html, source_url:)
    page = Page.new(html)
    product = page.product
    kind = kind_of(product)

    # The table that gives the most measurements wins; a resale listing's own measurements come next.
    chart = page.tables.filter_map { ChartReader.read(it.rows, context: it.context, garment: kind) }.min_by { it.missing.size }
    chart ||= page.item_measurements&.then { ChartReader.read(it, context: "item measurements", single: true, garment: kind) }
    chart ||= kiwi_chart(page, kind)
    chart ||= linked_guide_chart(page, kind, product, source_url)
    chart ||= DressCut.usual_sizes(DressCut.read(product), [ page.stated_size ].compact) if dress?(kind, product)
    chart ||= usual_chart(kind, page.stated_size, usual_key(kind, top_style_of(product), product))
    unless chart
      raise Error.new("no_size_chart", "Couldn't find a size chart on that page. Many shops load it in a pop-up: " \
                                       "copy the chart from there and paste it instead.")
    end

    garment(product, chart, kind:, source_url:)
  end

  # Shopify shops (most small and mid-size ones) answer a product's details as JSON at /products/<handle>.json:
  # quick and small, where the product page itself can be megabytes, slow, or shown only to browsers. The size
  # chart then comes from Kiwi Sizing, when the shop uses it. Returns nil when the link isn't a Shopify
  # product or the shop has no chart there, so the page is read instead.
  SHOPIFY_PRODUCT = %r{/products/([a-z0-9][a-z0-9_-]*)}i

  # given: the same details as the person's browser read them ({ "product" => the JSON's product,
  # "shop" => its myshopify domain, "sizing" => Kiwi Sizing's answer }). Many big shops answer a browser at
  # once but make an app wait; the browser reads these public, small answers, and Fitroom reads them here.
  # With no chart there, the sizes' usual measurements stand in (marked as guessed), named as the shop names
  # them when its Kiwi table converts sizes ("M (2)").
  def from_shopify(url, given: nil)
    uri = URI.parse(url)
    handle = uri.path[SHOPIFY_PRODUCT, 1] or return
    base = "#{uri.scheme}://#{uri.host}"
    data = given ? given["product"] : @fetch_json.call("#{base}/products/#{handle}.json")["product"]
    return unless data.is_a?(Hash) && data["title"].present?
    return if given && data["handle"].present? && data["handle"].to_s.casecmp(handle) != 0

    shop = given ? given["shop"] : (@fetch_json.call("#{base}/meta.json")["myshopify_domain"] rescue nil)
    return unless shop.to_s.match?(/\A[a-z0-9][a-z0-9-]*\.myshopify\.com\z/)

    description = Nokogiri::HTML.fragment(data["body_html"].to_s).text.squish
    product = {
      name: data["title"].to_s.squish.truncate(120), brand: data["vendor"].to_s.presence&.truncate(80),
      color: data["title"].to_s[/\s[-–]\s([^-–]+)\z/, 1]&.squish, category: data["product_type"].to_s.presence&.truncate(80),
      description: description.truncate(400), fabric: description[/(?:Material|Fabric|Composition):\s*([^.]+?)(?=\s+[A-Z][a-z]+:|\z)/, 1],
      image: shop_image(Array(data["images"]).first),
      sizes: shop_sizes(data)
    }
    kind = kind_of(product)
    style = usual_key(kind, top_style_of(product), product)
    sizing = given ? given["sizing"] : kiwi_answer(
      "shop" => shop, "product" => data["id"].to_s, "title" => data["title"], "tags" => Array(data["tags"]).join(",").split(/,\s*/).join(","),
      "type" => data["product_type"], "vendor" => data["vendor"])
    # Read by the server, a shop with no chart there may have one on its page; read by the browser, the page
    # is what the shop wouldn't give the server.
    if dress?(kind, product)
      # A dress's own chart, or its shop's sizes with their usual measurements.
      chart = read_kiwi(sizing, kind) || DressCut.usual_sizes(DressCut.read(product), product[:sizes])
      return garment(product, chart, kind:, source_url: url)
    end
    chart = read_kiwi(sizing, kind) || (usual_sizes(kind, style) if given)
    return unless chart

    garment(product, with_usual(chart, kind, style, size_names(sizing)), kind:, source_url: url)
  rescue Fetcher::TooSlow, Fetcher::Error => e
    # A shop that stalls here stalls on its page too, and one that turns apps away turns away the page.
    raise if e.is_a?(Fetcher::TooSlow) || e.message.include?("doesn't let apps")

    nil
  rescue URI::InvalidURIError, JSON::ParserError, NoMethodError, TypeError
    nil
  end

  def from_text(text, garment: "jacket")
    kind = KINDS.include?(garment.to_s) ? garment.to_s : "jacket"
    # Just a size ("M"), as a listing that has no chart gives: that size's usual measurements.
    if text.to_s.strip.match?(/\A(XXXL|3XL|XXL|2XL|XL|L|M|S|XS)\z/i) && (chart = usual_chart(kind, text.to_s.strip.upcase, "tee"))
      name = "Your #{kind == "trousers" ? "pants" : kind} in #{text.to_s.strip.upcase}"
      return garment({ name:, brand: nil, color: nil, category: nil, description: nil }, chart, kind:, source_url: nil)
    end
    rows = text.to_s.lines.map { |line| split_line(line) }.reject { |row| row.all?(&:blank?) }
    chart = ChartReader.read(rows, context: text.to_s, garment: kind)
    raise Error.new("no_size_chart", "Couldn't read that as a size chart. Copy the whole table, header row included.") unless chart

    name = { "top" => "Pasted top chart", "jacket" => "Pasted jacket chart", "coat" => "Pasted coat chart", "trousers" => "Pasted trousers chart" }[kind]
    garment({ name:, brand: nil, color: nil, category: nil, description: nil }, chart, kind:, source_url: nil)
  end

  private

  # The chart a Kiwi Sizing shop loads after its page opens: the first of its tables that reads as one.
  def kiwi_chart(page, kind)
    params = page.kiwi_sizing or return
    kiwi_chart_for(params, kind)
  end

  def kiwi_chart_for(params, kind) = read_kiwi(kiwi_answer(params), kind)

  def kiwi_answer(params)
    @fetch_json.call("#{KIWI_SIZING}?#{params.compact.to_query}")
  rescue Fetcher::Error, JSON::ParserError
    nil
  end

  # Of a Kiwi Sizing answer's tables, the one that reads best as a size chart.
  def read_kiwi(answer, kind)
    kiwi_tables(answer).filter_map { ChartReader.read(it, context: "size chart", garment: kind) }.min_by { it.missing.size }
  end

  def kiwi_tables(answer)
    return [] unless answer.is_a?(Hash)

    Array(answer["sizings"]).first(10).flat_map { it.is_a?(Hash) ? it["tables"].to_h.values.first(10) : [] }.filter_map do |table|
      next unless table.is_a?(Hash)

      Array(table["data"]).first(60).map { |row| Array(row).first(20).map { Nokogiri::HTML.fragment((it.is_a?(Hash) ? it["value"] : it).to_s.first(200)).text.squish } }
    end
  end

  # A size conversion table's other names for letter sizes ("S/M/L" next to "1/2/3"): { "M" => "2", ... }.
  def size_names(answer)
    kiwi_tables(answer).each do |rows|
      header = rows.first or next
      column = header.index { it.match?(%r{\A\d+(\s*/\s*\d+)+\z}) } or next
      names = rows.drop(1).filter_map do |row|
        letter = row.first.to_s.upcase.sub("3XL", "XXXL").sub("2XL", "XXL")
        [ letter, row[column] ] if USUAL_SIZES.include?(letter) && row[column].to_s.match?(/\A\d+\z/)
      end.to_h
      return names if names.any?
    end
    {}
  end

  # Pants by waist size (inches), with the usual seat, thigh, leg length and opening for each, in cm.
  def usual_trousers
    sizes = (28..40).step(2).map do |waist|
      seat = waist * 2.54 + 20
      { "name" => waist.to_s, "waist" => (waist * 2.54).round(1), "seat" => seat.round(1), "thigh" => (seat * 0.6).round(1),
        "inseam" => 81.0, "leg_opening" => 40.0 }
    end
    ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: [])
  end

  # Every letter size's usual measurements, when the shop has no chart: a guide, marked as guessed.
  def usual_sizes(kind, style)
    return if kind == "trousers"

    base, step = USUAL.fetch(USUAL.key?(style) ? style : usual_key(kind, style))
    sizes = USUAL_SIZES.each_with_index.map do |letter, n|
      chest, shoulders, sleeve, length = base.zip(step).map { |b, d| (b + d * n).round(1) }
      { "name" => letter, "chest" => chest, "waist" => nil,
        "shoulders" => shoulders, "sleeve" => sleeve, "length" => length }
    end
    ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: [ "waist" ])
  end

  # A chart read from size names alone (a conversion table gives only the chest) with each letter size's usual
  # shoulders, sleeve and length filled in, so the garment is drawn at about its size; and each size named as
  # the shop names it when it has its own ("M (2)").
  def with_usual(chart, kind, style, names = {})
    return chart unless chart.kind == "sizes" && kind != "trousers"

    usual = usual_sizes(kind, style).sizes.index_by { it["name"] }
    sizes = chart.sizes.map do |size|
      letter = size["name"].to_s[LETTER, 1]&.upcase&.sub("3XL", "XXXL")&.sub("2XL", "XXL")
      known = usual[letter] or next size
      size.merge(%w[shoulders sleeve length].to_h { [ it, size[it] || known[it] ] })
          .merge(names[letter] ? { "name" => "#{letter} (#{names[letter]})" } : {})
    end
    chart.with(sizes:, missing: chart.missing.select { |part| sizes.any? { it[part].nil? } })
  end

  # A product photo's address (the server fetches it with the usual checks).
  def shop_image(image)
    src = image.is_a?(Hash) ? image["src"].to_s : ""
    src = "https:#{src}" if src.start_with?("//")
    src if src.start_with?("https://")
  end

  # Usual finished measurements (cm) of tops and jackets by letter size, for listings that say only their
  # size ("Size: M") with no chart: [chest, shoulders, sleeve, length] at XS, then the step to each next size.
  USUAL_SIZES = %w[XS S M L XL XXL XXXL].freeze
  USUAL = {
    "tee" => [ [ 94, 42, 19.5, 68 ], [ 6, 2, 0.5, 2 ] ],
    "top" => [ [ 96, 42, 61, 66 ], [ 6, 2, 1, 2 ] ],
    "jacket" => [ [ 100, 43, 62, 66 ], [ 6, 2, 1, 1.5 ] ],
    "coat" => [ [ 104, 44, 62, 92 ], [ 6, 2, 1, 2 ] ],
    "dress" => [ [ 84, 36, 14, 95 ], [ 5, 1.5, 0.5, 1.5 ] ],
    "dress_long" => [ [ 84, 36, 58, 100 ], [ 5, 1.5, 1, 1.5 ] ]
  }.freeze

  # Which usual sizes a top's take: a T-shirt's, a dress's (with long sleeves when its listing says so), or
  # another top's.
  def usual_key(kind, style, product = nil)
    return kind unless kind == "top"
    return "tee" if style == "tee"
    return product.to_h.values_at(:name, :description).join(" ").match?(/long[- ]?sleeve|\bl\/s\b/i) ? "dress_long" : "dress" if style == "dress"

    "top"
  end
  LETTER = /\A(XXXL|3XL|XXL|2XL|XL|L|M|S|XS)\b/i

  # A one-size chart from the size a listing says it is, marked as estimated from the size's name.
  def usual_chart(kind, stated, style)
    return if kind == "trousers" || stated.nil?

    letter = stated[LETTER, 1]&.upcase&.sub("3XL", "XXXL")&.sub("2XL", "XXL") or return
    base, step = USUAL.fetch(USUAL.key?(style) ? style : usual_key(kind, style))
    n = USUAL_SIZES.index(letter)
    chest, shoulders, sleeve, length = base.zip(step).map { |b, d| (b + d * n).round(1) }
    size = { "name" => stated, "chest" => chest, "waist" => nil, "shoulders" => shoulders, "sleeve" => sleeve, "length" => length }
    ChartReader::Chart.new(sizes: [ size ], unit: "cm", kind: "sizes", missing: [ "waist" ])
  end

  # A shop's own size guide page, when the product page links to one on the same site and has no chart
  # of its own. Of its tables, the one for the product's gender and kind of garment that reads best.
  def linked_guide_chart(page, kind, product, source_url)
    link = page.size_guide_link(source_url) or return
    guide = Page.new(@fetch_page.call(link))
    gender = product.values_at(:name, :category, :description).join(" ")[GENDER, 0]&.then { it.match?(WOMEN) ? :women : :men }
    charts = guide.tables.filter_map do |table|
      next if gender && table.context.match?(gender == :men ? WOMEN : MEN_ONLY)

      ChartReader.read(table.rows, context: table.context, garment: kind)&.then { [ it, table.context.match?(GARMENT_WORDS.fetch(kind)) ? 0 : 1 ] }
    end
    charts.min_by { |chart, off_topic| [ off_topic, chart.missing.size ] }&.first
  rescue Fetcher::Error
    nil
  end

  GENDER = /\b(wom[ae]n'?s?|femme|ladies|men'?s|man|homme)\b/i
  WOMEN = /\b(wom[ae]n'?s?|femme|ladies)\b/i
  MEN_ONLY = /\b(men'?s|man|homme)\b/i
  GARMENT_WORDS = {
    "top" => /top|shirt|sweater|knit|jacket/i, "jacket" => /jacket|coat|blazer|suit/i,
    "coat" => /coat|jacket/i, "trousers" => /trouser|pant|jean/i
  }.freeze

  # Top, jacket, coat or trousers, from the product's name and category.
  def kind_of(product)
    words = product.values_at(:name, :category).join(" ")
    return "top" if words.match?(DRESSES)
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS)
    return "jacket" if words.match?(JACKETS)
    return "jacket" if words.match?(/hoodie|hooded/i) && product[:description].to_s.match?(HOODED_OUTERWEAR)
    return "trousers" if words.match?(TROUSERS)
    return "top" if words.match?(TOPS)
    return "jacket" unless words.match?(UNSUPPORTED)

    raise Error.new("not_supported", "Fitroom fits tops, jackets, coats and trousers so far, and this looks like something else.")
  end

  def dress?(kind, product) = kind == "top" && top_style_of(product) == "dress"

  # A Shopify product's size names, from its "Size" option (or its variants' names).
  def shop_sizes(data)
    option = Array(data["options"]).find { it.is_a?(Hash) && it["name"].to_s.match?(/size/i) }
    names = option ? Array(option["values"]) : Array(data["variants"]).map { it.is_a?(Hash) ? it["title"].to_s.split(" / ").first : nil }
    names.compact.map(&:to_s).map(&:strip).reject(&:empty?).uniq.first(30)
  end

  def garment(product, chart, kind:, source_url:)
    style = kind == "top" ? top_style_of(product) : nil
    chart = tee_sleeves(chart) if style == "tee"
    if style == "dress"
      cut = DressCut.read(product)
      chart = chart.with(missing: chart.missing - DressCut.not_needed(cut))
      return dress_garment(product, chart, cut, source_url)
    end
    {
      name: product[:name].presence || "Jacket",
      brand: product[:brand],
      color_name: product[:color],
      color: color_hex(product.values_at(:color, :description, :name)),
      fabric: fabric_of(product, kind),
      **(kind == "jacket" ? { style: style_of(product, source_url) } : {}),
      **(style ? { style: } : {}),
      **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:,
      garment: kind,
      chart: chart.as_json
    }
  end

  def dress_garment(product, chart, cut, source_url)
    {
      name: product[:name].presence || "Dress", brand: product[:brand], color_name: product[:color],
      color: color_hex(product.values_at(:color, :description, :name)), fabric: cut[:fabric], style: "dress",
      cut:, **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:, garment: "top", chart: chart.as_json
    }
  end

  def fabric_of(product, kind = "jacket")
    shell = product[:fabric].to_s.split(/[;,]?\s*lining/i).first   # "100% Cashmere; Lining 55% Silk, 45% Cotton"
    words = [ *product.values_at(:name, :category, :description), shell ].join(" ")
    FABRICS.find { |_, pattern| words.match?(pattern) }&.first || (kind == "top" ? "cotton" : "wool")
  end

  # A T-shirt's sleeve is short, so a long one on its chart was measured from the centre of the back (as
  # many shops do for tees): take off half the shoulders.
  def tee_sleeves(chart)
    sizes = chart.sizes.map do |size|
      next size unless size["sleeve"] && size["sleeve"] > Fit::SHORT_SLEEVE

      size.merge("sleeve" => (size["sleeve"] - (size["shoulders"] || 46) / 2.0).round(2))
    end
    chart.with(sizes:)
  end

  def top_style_of(product)
    style = product.values_at(:name, :category).each do |words|
      found = TOP_STYLES.find { |_, pattern| words.to_s.match?(pattern) }&.first
      break found if found
    end
    style = "tee" unless style.is_a?(String)
    # A "T-shirt" whose description says it has long sleeves is a long-sleeve one.
    style == "tee" && product[:description].to_s.match?(/long[- ]?sleeve/i) ? "longsleeve" : style
  end

  def style_of(product, source_url)
    words = product.values_at(:name, :category, :description).join(" ")
    found = STYLES.find { |_, pattern| words.match?(pattern) }&.first
    return found if found
    return "shirt" if fabric_of(product) == "denim"
    return "zip" if %w[leather nylon].include?(fabric_of(product))

    [ product[:category], source_url ].join(" ").match?(OUTERWEAR) ? "zip" : "tailored"
  end

  # The first of the texts (the product's colour, its description, its name) that names a colour.
  def color_hex(texts)
    texts.compact.each do |text|
      found = COLORS.find { |name, _| text.match?(/\b#{name}\b/i) }
      return found.last if found
    end
    DEFAULT_COLOR
  end

  # Copied tables come through as tabs, pipes, or columns of spaces.
  def split_line(line)
    cells = line.strip.split(/\t|\s*\|\s*|\s{2,}/).compact_blank
    cells.size >= 3 ? cells : line.strip.split(/\s+/)
  end
end
