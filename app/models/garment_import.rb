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

  UNSUPPORTED = /shoe|sneaker|boot|sock|\btie\b|belt|\bhat\b|\bcap\b|scarf|bag\b/i
  # Things worn but not fitted here, each with what to call it ("Fitroom can't try on shoes yet"). Read from the
  # name, the shop's category and its tags; checked first, so "Low Top Sneakers" is never a top.
  NOT_FITTED = [
    [ "shoes", /sneakers?|\bshoes?\b|\bboots?\b|footwear|loafers?|sandals?|slides?\b|mules?\b|clogs?|trainers?|\bheels?\b/i ],
    [ "belts", /\bbelts?\b|belt bag/i ],
    [ "bags", /\bbags?\b|backpack|tote|wallet|pouch|card holder|small leather goods/i ],
    [ "hats", /\bhats?\b|\bcaps?\b|beanie|headwear|bucket hat|balaclava/i ],
    [ "sunglasses", /sunglasses|eyewear|glasses|frames\b/i ],
    [ "jewelry", /jewel|necklace|bracelet|\brings?\b|earrings?|watch(?:es)?\b/i ],
    [ "socks", /\bsocks?\b|underwear|boxers?|briefs\b/i ],
    [ "scarves and ties", /scarf|scarves|\bties?\b|gloves?/i ],
    [ "swimwear", /swim|bikini/i ],
    [ "rompers and jumpsuits", /romper|jumpsuit|playsuit|overalls?\b|dungarees|unitard|catsuit/i ],
    [ "accessories", /accessor/i ]
  ].freeze
  # Dresses (a "dress shirt" or "dress pants" isn't one), drawn as a top cut long.
  DRESSES = /\b(?:dress(?:es)?(?!\s*(?:shirts?|pants|trousers|shoes?|socks|coats?|jackets?|boots?)\b)|gowns?|maxi|midi|sundress|frock|kaftan|caftan)\b/i
  JACKETS = /jacket|blazer|suit|coat|sport ?coat|tuxedo|dinner|overshirt|shacket/i
  # T-shirts, shirts, polos, sweatshirts, hoodies and knitwear: worn on the body, under a jacket.
  TOPS = /t-?shirt|\btees?\b|shirt|polo|henley|tank\b|sweatshirt|crewneck|hoodie|hooded|sweater|jumper|cardigan|pullover|knit\b|\bjerseys?\b|\btop\b/i
  # How a top looks, for drawing it: the first match in its name wins, then in its category, else a tee.
  # "T-shirt" is checked before "shirt", so a T-shirt is never drawn as a button-up.
  TOP_STYLES = [
    [ "dress", DRESSES ],
    [ "hoodie", /hoodie|hooded/i ],
    [ "tank", /\btanks?\b|tank top|camisole|\bcami\b|singlet|sleeveless/i ],
    [ "polo", /\bpolos?\b/i ],
    [ "cardigan", /cardigan/i ],
    [ "longsleeve", /long[- ]?sleeve.*\b(t[- ]?shirt|tee)|\b(t[- ]?shirt|tee)s?\b.*long[- ]?sleeve/i ],
    [ "tee", /\bt[- ]?shirts?\b|\btees?\b/i ],
    [ "sweater", /sweater|jumper|knit\b|knitted|cashmere crew|merino/i ],
    [ "sweatshirt", /sweatshirt|pullover|crew ?neck|fleece/i ],
    [ "shortshirt", /short[- ]?sleeve.*shirt|\bs\/s\b.*shirt|camp[- ]?(collar|shirt)|bowling shirt|aloha|hawaiian|resort shirt/i ],
    [ "shirt", /oxford|flannel|button[- ]?(down|up|front)|poplin|dress shirt|chambray/i ],
    [ "longsleeve", /long[- ]?sleeve|\bl\/s\b|henley/i ],
    [ "shirt", /shirts?\b/i ]
  ].freeze
  TROUSERS = /trouser|pants?\b|jeans?\b|chinos?\b|slacks|leggings?\b|\btights\b|joggers?\b|sweatpants?|track ?pants?|\bshorts?\b(?![- ]?sleeve)|skirts?\b|skort/i
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
    [ "cardigan", /cardigan/i ],
    [ "tailored", /blazer|suit|sport ?coat|tuxedo|dinner jacket|smoking jacket|lapel/i ],
    [ "bomber", /bomber|varsity|letterman|flight jacket|ma-1|baseball jacket|harrington/i ],
    [ "zip", /two-way zip|zip(?:per)? closure|full[- ]zip|zip[- ]up|front zip/i ],
    [ "shirt", /denim(?: \w+)? jacket|jean jacket|trucker|chore|overshirt|shirt[- ]jacket|shacket|work jacket|field jacket|utility|safari|chambray|button[- ](front|closure|up)|point collar/i ],
    [ "zip", /zip|moto\b|biker|leather jacket|shearling|puffer|down jacket|windbreaker|anorak|track jacket|blouson|fleece/i ]
  ].freeze
  # Shops' outerwear sections, where a jacket that says nothing else is more likely casual than tailored.
  OUTERWEAR = /outerwear|coats?[-_ ](and|&)[-_ ]jackets|jackets?[-_ ](and|&)[-_ ]coats/i

  # What the cloth looks like, from the product's name and description, so the 3D view can draw its surface.
  FABRICS = [
    # Linen first: a silk-linen blend hangs and looks like linen, not satin.
    [ "linen", /linen|ramie|hemp/i ],
    [ "silk", /silk|satin|taffeta|chiffon|charmeuse/i ],
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
    "tan" => "#a9845b", "camel" => "#b38a5c", "caramel" => "#a8743f", "beige" => "#c2ad8c", "khaki" => "#a99a72",
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
      garment = photo.match?(BROWSER_PHOTO) && photo.bytesize < 3_500_000 ? garment.except(:image_url).merge(photo:) : with_photo(garment)
      # The shop's photo of the back, which the browser found and read.
      back = shop_data["back_photo"].to_s
      return garment[:photo] && back.match?(BROWSER_PHOTO) && back.bytesize < 3_500_000 ? garment.merge(back_photo: back) : garment
    end
    Rails.cache.fetch([ "garment_import", FORMAT, Digest::SHA256.hexdigest(url) ], expires_in: 1.hour) do
      import = new
      (import.from_shopify(url) || import.from_page(Fetcher.get(url), source_url: url)).then { with_photo(it) }
    end
  rescue Fetcher::Error => e
    raise Error.new("fetch_failed", e.message)
  end

  KINDS = %w[top jacket coat trousers].freeze
  ELASTIC_WAIST = /elastic(?:ated|ised|ized)?\s+(?:waist|waistband)|drawcord|drawstring|pull[- ]on/i
  BROWSER_PHOTO = %r{\Adata:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+\z}
  # Bump when what an import returns changes, so cached imports from before aren't served.
  FORMAT = 19

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
    "top" => { "tee" => "T-shirt", "longsleeve" => "Long-sleeve T-shirt", "sweatshirt" => "Sweatshirt", "hoodie" => "Hoodie", "shirt" => "Shirt", "shortshirt" => "Short-sleeve shirt",
               "polo" => "Polo", "tank" => "Tank top", "sweater" => "Sweater", "cardigan" => "Cardigan", "shortknit" => "Short-sleeve sweater",
               "dress" => "Dress", "dress_long" => "Long-sleeve dress" },
    "jacket" => { "zip" => "Zip-up jacket", "bomber" => "Bomber jacket", "shirt" => "Shirt jacket", "tailored" => "Blazer", "cardigan" => "Cardigan" },
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
    # No chart anywhere: the sizes the page offers, with their usual measurements (marked as guessed), so
    # the link still works and the person picks their size on the mannequin. Pants always get some (by
    # waist, or the usual waists); other clothes only when the page lists its sizes.
    unless chart
      product = product.merge(sizes: page.size_names)
      product[:women] = women?(product, source_url)
      if kind == "trousers"
        chart = bottom_style_of(product) == "skirt" ? usual_skirts(product) : usual_trousers(product)
      elsif product[:sizes].any? && !dress?(kind, product)
        chart = usual_sizes(kind, top_style_of(product), product)
      end
    end
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
      sizes: shop_sizes(data),
      tags: Array(data["tags"]).join(",").split(/,\s*/).map(&:strip).first(40),
      sorted: data["product_type"].to_s.present?,
      shape: photo_shape(given&.dig("shape")),
      bottom_shape: photo_bottom_shape(given&.dig("bottom_shape"))
    }
    product[:women] = women?(product, url)
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
    if kind == "trousers" && bottom_style_of(product) == "skirt"
      chart = read_kiwi(sizing, kind) || usual_skirts(product)
      return garment(product, chart, kind:, source_url: url)
    end
    chart = read_kiwi(sizing, kind) || (usual_for(kind, style, product) if given)
    return unless chart

    garment(product, with_usual(chart, kind, style, size_names(sizing), product), kind:, source_url: url)
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

  # Pants by waist size (inches), or by letter size, with the usual seat, thigh, leg length and opening for
  # each, in cm: named as the shop names them, women's cut for a women's listing, and as wide at the hem as
  # it says ("Wide leg", "Bootcut", "Slim").
  def usual_trousers(product = {})
    names = Array(product[:sizes])
    women = product[:women]
    words = product.values_at(:name, :description).join(" ")
    opening, roomy = TROUSER_LEGS.find { |pattern, _| words.match?(pattern) }&.last || [ women ? 38 : 40, 0 ]
    roomy += 8 if words.match?(/oversized|baggy|relaxed/i)
    waists = names.filter_map { it.to_s.strip[/\A(2[2-9]|3\d|4[0-6])\z/, 1]&.to_i }
    inseam = bottom_style_of(product) == "shorts" ? shorts_inseam(product) : nil
    sizes =
      if waists.size >= 2
        waists.uniq.sort.map { |w| trouser_size(w.to_s, w * 2.54, women, opening, roomy, inseam:) }
      elsif (letters = names.map { letter_of(it) }.compact.uniq).size >= 2
        letters.sort_by { ALL_LETTERS.index(it) }.map do |letter|
          waist = women ? DressCut::LETTERS.fetch(letter)[1] + 2 : MEN_WAIST.fetch(letter)
          trouser_size(letter, waist, women, opening, roomy, inseam:)
        end
      else
        (28..40).step(2).map { |w| trouser_size(w.to_s, w * 2.54, false, opening, roomy, inseam:) }
      end
    sizes = as_photographed_legs(sizes, product[:bottom_shape]) if product[:bottom_shape]
    ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: [])
  end

  # The shop photo shows how wide the legs are: one leg's flat width at the thigh and the hem, as a share of
  # the waist's flat width, is its round over the waist's round. Only within what pants are made like.
  # Only when the photo's crotch is where a crotch is (a fifth to a half of the way down): wide legs laid
  # flat touch each other almost to the hem, so the gap between them, and the thigh, are found far too low.
  # A leg isn't made narrower at the hem than a third of its thigh, nor shorts narrower than their thigh.
  def as_photographed_legs(sizes, shape)
    return sizes unless shape[:rise]&.between?(0.18, 0.5)

    sizes.map do |size|
      thigh = (shape[:thigh] * size["waist"]).clamp(size["seat"] * 0.5, size["seat"] * 0.75).round(1)
      shorts = size["inseam"] < 40
      opening = (shape[:hem] * size["waist"]).clamp(shorts ? thigh * 0.9 : [ 18, thigh * 0.35 ].max, 80).round(1)
      size.merge("leg_opening" => opening, "thigh" => [ thigh, opening ].max)
    end
  end

  # The waist (cm) men's pants in each letter size are made for.
  MEN_WAIST = { "XXS" => 66, "XS" => 71, "S" => 76, "M" => 81, "L" => 86, "XL" => 94, "XXL" => 102, "XXXL" => 109, "4XL" => 117 }.freeze
  # [leg opening around (cm), extra room at the seat and thigh (cm)] by how the listing says the leg is cut.
  TROUSER_LEGS = [
    # Leggings and tights stretch over the body, made smaller than it.
    [ /leggings?|\btights\b/i, [ 21, -12 ] ],
    [ /joggers?|sweatpants?|track ?pants?/i, [ 26, 6 ] ],
    [ /wide[- ]leg|palazzo|flared?|barrel|balloon/i, [ 58, 10 ] ],
    [ /boot ?cut/i, [ 46, 2 ] ],
    [ /skinny/i, [ 28, -6 ] ],
    [ /slim|tapered/i, [ 34, -2 ] ],
    [ /straight/i, [ 42, 2 ] ]
  ].freeze

  def trouser_size(name, waist, women, opening, roomy, inseam: nil)
    seat = waist + (women ? 26 : 20) + roomy
    thigh = (seat * (women ? 0.58 : 0.6)).round(1)
    { "name" => name, "waist" => waist.round(1), "seat" => seat.round(1), "thigh" => thigh,
      "inseam" => (inseam || (women ? 76.0 : 81.0)).to_f, "leg_opening" => (inseam ? [ opening, thigh * 0.95 ].max : opening).to_f.round(1) }
  end

  # A skirt's usual measurements in each of its shop's women's sizes: its waist and hips (by its cut) and its
  # length (mini to maxi).
  SKIRT_LENGTHS = { "mini" => 40, "knee" => 56, "midi" => 74, "maxi" => 96 }.freeze

  def usual_skirts(product)
    cut = DressCut.read(product)
    letters = Array(product[:sizes]).map { letter_of(it) }.compact.uniq
    letters = %w[XS S M L XL] if letters.size < 2
    sizes = letters.sort_by { ALL_LETTERS.index(it) }.map do |letter|
      _, waist, hips = DressCut::LETTERS.fetch(letter)
      ease = cut[:stretch] ? -2 : { "fitted" => 2, "slim" => 3, "relaxed" => 8, "flared" => 6 }.fetch(cut[:fit], 3)
      { "name" => letter, "waist" => (waist + [ ease, 2 ].min).round(1), "seat" => (hips + ease).round(1),
        "length" => (SKIRT_LENGTHS.fetch(cut[:length], 56) + (ALL_LETTERS.index(letter) - 3)).to_f }
    end
    ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: [])
  end

  # A pair of shorts' inseam (cm): the one its name gives ('2.5"', "7 inch"), or the usual (a women's
  # about 10 cm, a men's 18).
  def shorts_inseam(product)
    inches = product.values_at(:name, :description).join(" ")[/(\d+(?:\.\d+)?)\s*(?:"|”|''|-?inch|in\b)(?:\s*inseam)?/i, 1]&.to_f
    return (inches * 2.54).round(1) if inches&.between?(1.5, 14)

    product[:women] ? 10.0 : 18.0
  end

  # Every letter size's usual measurements, when the shop has no chart: a guide, marked as guessed.
  # product: its listing, for whether it's a women's (smaller and shorter) and how it says it fits ("Oversized
  # fit", "Cropped", "Cap sleeves"); its shop's letter sizes (XXS to 4XL) are the ones given.
  def usual_sizes(kind, style, product = {})
    return if kind == "trousers"

    # A top's own style ("tee"), else its kind's: a coat, whose name gives no top style, is a coat (cut long),
    # not the tee a top that names nothing is taken for.
    key = kind == "top" && USUAL.key?(style) ? style : usual_key(kind, style)
    key = "#{key}_women" if product[:women] && USUAL.key?("#{key}_women")
    base, step = USUAL.fetch(key)
    letters = Array(product[:sizes]).map { letter_of(it) }.compact.uniq
    numbered = letters.size < 2 && brand_numbers(product[:sizes])
    letters = numbered ? numbered.keys : USUAL_SIZES if letters.size < 2
    sizes = letters.sort_by { ALL_LETTERS.index(it) }.map do |letter|
      n = ALL_LETTERS.index(letter) - 1   # XS is the base
      chest, shoulders, sleeve, length = base.zip(step).map { |b, d| (b + d * n).round(1) }
      { "name" => numbered ? "#{letter} (#{numbered[letter]})" : letter, "chest" => chest, "waist" => nil,
        "shoulders" => shoulders, "sleeve" => sleeve, "length" => length }
    end
    sizes = cut_as_listed(sizes, product, kind) if product[:description]
    ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: [ "waist" ])
  end

  # The usual sizes for a listing with no chart: a top's or a jacket's, or pants by waist size or letter.
  def usual_for(kind, style, product)
    kind == "trousers" ? usual_trousers(product) : usual_sizes(kind, style, product)
  end

  ALL_LETTERS = %w[XXS XS S M L XL XXL XXXL 4XL].freeze
  # Japanese and some European brands number their sizes 0 (or 1) upward: 0 is an XS, 1 an S, 2 an M.
  # { "XS" => "0", "S" => "1", ... } for the numbers a shop sells, when it sells at least three of 0 to 6.
  BRAND_SIZE_LETTERS = %w[XS S M L XL XXL XXXL].freeze

  def brand_numbers(names)
    numbers = Array(names).filter_map { it.to_s.strip[/\A[0-6]\z/]&.to_i }.uniq.sort
    return unless numbers.size >= 3

    numbers.to_h { [ BRAND_SIZE_LETTERS[it], it.to_s ] }
  end
  def letter_of(name)
    label = name.to_s.upcase.strip[/\A(4XL|XXXXL|XXXL|3XL|XXL|2XL|XL|L|M|S|XS|XXS|2XS)\b/, 1] or return
    { "XXXXL" => "4XL", "3XL" => "XXXL", "2XL" => "XXL", "2XS" => "XXS" }.fetch(label, label)
  end

  # How a listing says a top is cut, on its usual sizes: roomier, cropped, close or with short cap sleeves.
  FIT_WORDS = [
    [ /oversized|boxy|loose fit|baggy/i, { chest: 10, length: 2, shoulders: 4 } ],
    [ /relaxed/i, { chest: 4, shoulders: 1 } ],
    [ /dropped shoulders?/i, { shoulders: 3 } ],
    [ /slim fit|fitted|baby tee|mini tee|shrunken|body[- ]?con|second[- ]skin/i, { chest: -6, length: -3, shoulders: -2 } ],
    [ /crop(?:ped)?\b/i, { length_share: 0.75 } ],
    [ /cap sleeves?/i, { sleeve_share: 0.55 } ]
  ].freeze

  def cut_as_listed(sizes, product, kind)
    return sizes unless kind == "top"

    words = product.values_at(:name, :description).join(" ")
    change = FIT_WORDS.select { |pattern, _| words.match?(pattern) }.map(&:last)
    change = as_photographed(change, product, words)
    return sizes if change.empty?

    sizes.map do |size|
      chest = size["chest"] + change.sum { it[:chest].to_i }
      shoulders = size["shoulders"] + change.sum { it[:shoulders].to_i }
      length = (size["length"] + change.sum { it[:length].to_i }) * change.filter_map { it[:length_share] }.reduce(1, :*)
      sleeve = size["sleeve"] * (size["sleeve"] < 30 ? change.filter_map { it[:sleeve_share] }.reduce(1, :*) : 1)
      size.merge("chest" => chest.round(1), "shoulders" => shoulders.round(1), "length" => length.round(1), "sleeve" => sleeve.round(1))
    end
  end

  # What the shop photo shows overrules the listing's words, which are often the same for every top a
  # brand sells. A top whose arms are sewn in high (its armpit about half its width below the shoulders) is
  # cut close to the body, however "relaxed" its listing says it is: a women's one is a baby tee, short and
  # snug. One whose armpit is three quarters of its width down has dropped shoulders and room. A tee whose
  # sleeves barely leave the shoulder has short ones.
  BABY_TEE = { chest: -4, length: -8, shoulders: -3 }.freeze
  ROOMY_TOP = { chest: 4, shoulders: 3 }.freeze
  SHORT_SLEEVES = { sleeve_share: 0.75 }.freeze
  ROOMY_WORDS = FIT_WORDS.first(3).map(&:last).freeze

  def as_photographed(change, product, words)
    shape = product[:shape] or return change
    sewn = sleeves_sewn(shape)
    change -= ROOMY_WORDS if sewn == :high
    change += [ BABY_TEE ] if baby_tee?(product, words)
    change += [ ROOMY_TOP ] if sewn == :low && (change & ROOMY_WORDS).empty?
    change += [ SHORT_SLEEVES ] if shape[:sleeve] && shape[:sleeve] < 0.75 && shape[:sleeve_down].to_f < 0.45 && words !~ /cap sleeves?/i
    change
  end

  # Where a photographed top's arms are sewn in: :high (close-cut), :low (dropped shoulders) or nil.
  def sleeves_sewn(shape)
    armpit, waist, length = shape.to_h.values_at(:armpit, :waist, :length)
    depth = armpit && length && armpit * length   # shoulders to armpit, over the chest's width
    return unless depth

    return :high if depth < 0.62 && waist.to_f < 1.05
    :low if depth >= 0.72
  end

  # A women's tee whose photo shows it cut close, with no words saying how close: a baby tee, made snug
  # and short.
  def baby_tee?(product, words = product.values_at(:name, :description).join(" "))
    product[:women] && product[:shape] && sleeves_sewn(product[:shape]) == :high && !words.match?(FIT_WORDS[3].first)
  end

  # The shape the browser read off the shop photo ({ "length", "waist", "hem", "sleeve", "sleeveDown",
  # "armpit" }, each a share of the front's width or length), checked: nil unless every part is a
  # plausible number.
  def photo_shape(shape)
    return unless shape.is_a?(Hash)

    read = { armpit: shape["armpit"], waist: shape["waist"], sleeve: shape["sleeve"], sleeve_down: shape["sleeveDown"],
             length: shape["length"] }
    return if read.values.any? { !(it.nil? || (it.is_a?(Numeric) && it.finite? && it.between?(0, 5))) }

    read.compact.presence
  end

  # The pants' shape the browser read off the shop photo ({ "thigh", "hem", "rise", "length" }: one leg's
  # width at the thigh and the hem, over the waist's width), checked: nil unless plausible, and for a skirt.
  def photo_bottom_shape(shape)
    return unless shape.is_a?(Hash) && shape["skirt"] != true

    read = { thigh: shape["thigh"], hem: shape["hem"], rise: shape["rise"], length: shape["length"] }
    return if read.values.any? { !(it.is_a?(Numeric) && it.finite? && it.between?(0.05, 6)) }

    read
  end

  # A women's listing: its shop tags it so ("wmns", "womens") or files it there, or its name says so.
  def women?(product, url)
    tags = Array(product[:tags]).map(&:downcase)
    return true if tags.intersect?(%w[wmns womens women woman ladies])
    return false if tags.intersect?(%w[mens men man])

    [ product[:name], product[:category], url ].join(" ").match?(/\bwom[ae]n'?s?\b|\bwmns\b|ladies/i)
  end

  # A chart read from size names alone (a conversion table gives only the chest) with each letter size's usual
  # shoulders, sleeve and length filled in, so the garment is drawn at about its size; and each size named as
  # the shop names it when it has its own ("M (2)").
  def with_usual(chart, kind, style, names = {}, product = {})
    return chart unless chart.kind == "sizes" && kind != "trousers"

    usual = usual_sizes(kind, style, product).sizes.index_by { it["name"] }
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
    "tee_women" => [ [ 84, 37, 15, 59 ], [ 5, 1.5, 0.5, 1.5 ] ],
    "top_women" => [ [ 86, 37, 58, 60 ], [ 5, 1.5, 1, 1.5 ] ],
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
    return "tee" if %w[tee polo tank shortshirt].include?(style)
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
    # Not the colour after the name: Willy Chavarria's "Track Jacket - Peacoat" is a jacket, not a pea coat.
    words = [ product[:name].to_s.sub(/\s+[-–]\s+[^-–]+\z/, ""), product[:category] ].join(" ")
    # The shop's own category and tags say first what something is: a sneaker is shoes, whatever its name says.
    sorted = [ product[:category], *Array(product[:tags]).grep(/\A(?!mens\z|wmns\z|womens\z)/i) ].compact.join(" ")
    # The category alone first: Teatora's "Wallet Short", filed under Shorts, is shorts, not a wallet.
    not_fitted = NOT_FITTED.find { |_, pattern| product[:category].to_s.match?(pattern) }
    not_fitted ||= NOT_FITTED.find { |_, pattern| sorted.match?(pattern) || words.match?(pattern) && !words.match?(Regexp.union(DRESSES, TOPS, JACKETS, TROUSERS)) } unless product[:category].to_s.match?(Regexp.union(DRESSES, TOPS, JACKETS, TROUSERS))
    if not_fitted
      raise Error.new("not_supported", "Fitroom can't try on #{not_fitted.first} yet. It works with tops, dresses, jackets, coats and pants.")
    end
    # A "Maxi Coat" is a coat, not a dress (a "Trench Dress" is still a dress).
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS) && !words.match?(/\bdress\b/i)
    # A "maxi skirt" is a skirt, not a dress.
    return "top" if words.match?(DRESSES) && !words.match?(/skirts?\b|skort/i)
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS)
    # A cardigan is worn open over a top, as a jacket is.
    return "jacket" if words.match?(/cardigan/i)
    # So is a knit that zips all the way down ("Crochet Cable Zip Track"), but not a half-zip pullover.
    return "jacket" if words.match?(/\bzip\b|zip[- ]up|full[- ]zip/i) && words.match?(/sweater|knit|crochet|cable|track/i) && !words.match?(/half[- ]zip|quarter[- ]zip|1\/4|hood/i)
    # Pants named for their cloth ("Suiting Trouser") are pants, not a suit's jacket.
    return "trousers" if product[:name].to_s.match?(/\b(?:trousers?|pants?|jeans?|shorts?(?![- ]?sleeve)|skirts?)\s*(?:[-–].*)?\z/i) || product[:category].to_s.match?(TROUSERS)
    return "jacket" if words.match?(JACKETS)
    return "jacket" if words.match?(/hoodie|hooded/i) && product[:description].to_s.match?(HOODED_OUTERWEAR)
    return "trousers" if words.match?(TROUSERS)
    return "top" if words.match?(TOPS)
    # A shop's page that names nothing else is most often a jacket (a "Hudson"); a Shopify listing says what it is.
    return "jacket" unless words.match?(UNSUPPORTED) || product[:sorted]

    raise Error.new("not_supported", "Fitroom can't try this on yet. It works with tops, dresses, jackets, coats and pants.")
  end

  def dress?(kind, product) = kind == "top" && top_style_of(product) == "dress" && !product.values_at(:name, :category).join(" ").match?(/skirts?\b|skort/i)

  # How pants are made, for drawing them: jeans, joggers (and sweatpants, track pants), leggings (and
  # tights), shorts, or trousers (anything else: chinos, cargo pants, suit trousers).
  BOTTOM_STYLES = [
    [ "skirt", /skirts?\b|skort/i ],
    [ "leggings", /leggings?|\btights\b/i ],
    [ "shorts", /\bshorts?\b(?![- ]?sleeve)/i ],
    [ "joggers", /joggers?|sweatpants?|track ?pants?|\bsweats\b/i ],
    [ "jeans", /jeans?\b|denim/i ]
  ].freeze

  def bottom_style_of(product)
    product.values_at(:name, :category).each do |words|
      found = BOTTOM_STYLES.find { |_, pattern| words.to_s.match?(pattern) }&.first
      return found if found
    end
    "trousers"
  end

  # A Shopify product's size names, from its "Size" option (or its variants' names).
  def shop_sizes(data)
    option = Array(data["options"]).find { it.is_a?(Hash) && it["name"].to_s.match?(/size/i) }
    names = option ? Array(option["values"]) : Array(data["variants"]).map { it.is_a?(Hash) ? it["title"].to_s.split(" / ").first : nil }
    names.compact.map(&:to_s).map(&:strip).reject(&:empty?).uniq.first(30)
  end

  def garment(product, chart, kind:, source_url:)
    chart = plausible(chart, kind)
    style = kind == "top" ? top_style_of(product) : kind == "trousers" ? bottom_style_of(product) : nil
    # Shorts' "inseam" past 40 cm is their whole length from the waist (Armani's charts): less the rise.
    if style == "shorts"
      sizes = chart.sizes.map { it["inseam"].to_f > 40 ? it.merge("inseam" => (it["inseam"] - (it["rise"] || (product[:women] ? 26 : 30))).round(1)) : it }
      chart = chart.with(sizes:)
    end
    # A sweater with short sleeves (a knit tee, a mock neck) is drawn with short sleeves.
    style = "shortknit" if style == "sweater" && short_sleeved?(product, chart)
    chart = tee_sleeves(chart) if %w[tee polo shortshirt shortknit].include?(style)
    # A tank top has no sleeves, and its straps sit in from the shoulders: neither is measured.
    if style == "tank"
      chart = chart.with(sizes: chart.sizes.map { it.merge("sleeve" => nil, "shoulders" => nil) }, missing: chart.missing - %w[sleeve shoulders])
    end
    # A skirt's cut, read as a dress's is (its length, how it flares, its cloth).
    skirt_cut = style == "skirt" ? DressCut.read(product).slice(:length, :fit, :stretch, :fabric, :printed, :details) : nil
    skirt_cut[:fit] = "pleated" if skirt_cut && product.values_at(:name, :description).join(" ").match?(/pleat/i)
    # Pull-on pants: an elastic or drawcord waist, gathered in, which stretches to fit.
    skirt_cut = { elastic: true } if kind == "trousers" && !%w[skirt joggers leggings].include?(style) && product.values_at(:name, :description).join(" ").match?(ELASTIC_WAIST)
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
      **(product[:women] ? { women: true } : {}),
      **(kind == "top" && product.values_at(:name, :description).join(" ").match?(/crop(?:ped)?\b/i) ? { cropped: true } : {}),
      **(kind == "top" && chart.kind == "sizes" && baby_tee?(product) ? { snug: true } : {}),
      **(skirt_cut ? { cut: skirt_cut } : {}),
      **(kind == "top" && product[:shape] && sleeves_sewn(product[:shape]) == :low ? { dropped: true } : {}),
      chart: chart.as_json
    }
  end

  def dress_garment(product, chart, cut, source_url)
    {
      name: product[:name].presence || "Dress", brand: product[:brand], color_name: product[:color],
      color: color_hex(product.values_at(:color, :description, :name)), fabric: cut[:fabric], style: "dress",
      cut:, **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:, garment: "top", women: true, chart: chart.as_json
    }
  end

  def fabric_of(product, kind = "jacket")
    shell = product[:fabric].to_s.split(/[;,]?\s*lining/i).first   # "100% Cashmere; Lining 55% Silk, 45% Cotton"
    # What it's made of says it best ("EB Denim" makes cotton tees); else its name and description.
    name = product[:name].to_s.delete_prefix(product[:brand].to_s)
    words = [ name, *product.values_at(:category, :description) ].join(" ")
    # A blend ("80% Wool / 20% Nylon") is its main fibre.
    # (Shops that give no material field often list it in the description: "80% Polyester / 13% Wool".)
    shell = main_fibre(shell) || (shell.blank? && main_fibre(product[:description])) || shell
    found = [ shell, words ].find { |text| FABRICS.any? { |_, pattern| text.to_s.match?(pattern) } }
    fabric = FABRICS.find { |_, pattern| found.to_s.match?(pattern) }&.first || (kind == "top" ? "cotton" : "wool")
    # Denim is a cotton cloth: a "Denim Jacket" made of "100% Cotton" is denim.
    return "denim" if fabric == "cotton" && [ name, product[:category] ].join(" ").match?(FABRICS.to_h.fetch("denim"))

    fabric
  end

  # The largest share of a blend that's a cloth Fitroom knows: "Wool" in "80% Wool / 20% Nylon". Nil for a
  # material with no shares given.
  def main_fibre(material)
    parts = material.to_s.scan(/(\d+(?:\.\d+)?)\s*%\s*([A-Za-z][A-Za-z -]*)/)
    return if parts.empty?

    main = parts.max_by { it[0].to_f }.last
    return main if FABRICS.any? { |_, pattern| main.match?(pattern) }
    # Polyamide is nylon; viscose, lyocell, modal, cupro and the matte synthetics hang and look like cotton
    # here (none is a shiny shell, as the nylon in "76% Lyocell / 22% Nylon" would make it).
    return "nylon" if main.match?(/polyamide/i)
    "cotton" if main.match?(/lyocell|tencel|modal|viscose|rayon|cupro|polyester|acrylic|elastane|spandex|flax/i)
  end

  # What a chart can't mean, left out (and then estimated, as when a chart doesn't give it): a shop's typo
  # ("LEG OPENING 1.25" for every size) would otherwise be drawn as a leg three centimetres round.
  PLAUSIBLE = { "leg_opening" => 12..120, "thigh" => 30..150, "seat" => 50..200, "waist" => 40..200, "inseam" => 5..120,
                "rise" => 12..60, "chest" => 50..220, "shoulders" => 25..80, "sleeve" => 5..100, "length" => 25..160 }.freeze
  def plausible(chart, kind)
    sizes = chart.sizes.map do |size|
      size.to_h { |key, value| [ key, value.is_a?(Numeric) && PLAUSIBLE[key] && !PLAUSIBLE[key].cover?(value) ? nil : value ] }
    end
    sizes == chart.sizes ? chart : chart.with(sizes:)
  end

  # Whether a sweater has short sleeves: its name says so, or every sleeve on its chart is short.
  def short_sleeved?(product, chart)
    return true if product.values_at(:name, :description).join(" ").match?(/short[- ]?sleeve|\bs\/s\b/i)

    sleeves = chart.sizes.filter_map { it["sleeve"] }
    sleeves.any? && sleeves.all? { it < Fit::SHORT_SLEEVE }
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
    # The name first: a "Trucker Jacket" whose description mentions a zip pocket is still a trucker.
    named = product.values_at(:name, :category).join(" ")
    found = STYLES.find { |_, pattern| named.match?(pattern) }&.first
    return found if found
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
