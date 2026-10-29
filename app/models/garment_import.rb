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
    # (A bodysuit is a top that fastens below: it's worn tucked into the pants or skirt, see garment.)
    [ "unitards", /unitard|catsuit/i ],
    [ "accessories", /accessor/i ]
  ].freeze
  # Dresses (a "dress shirt" or "dress pants" isn't one), drawn as a top cut long.
  # A shirt dress, sweater dress or slip dress named in one word ("Shirtdress") is one too.
  DRESSES = /\b(?:dress(?:es)?(?!\s*(?:shirts?|pants|trousers|shoes?|socks|coats?|jackets?|boots?)\b)|(?:shirt|sweater|slip|tee|knit|tank|polo|wrap)dress(?:es)?|gowns?|maxi|midi|sundress|frock|kaftan|caftan)\b/i
  # (Not a "bodysuit" or a "catsuit".)
  JACKETS = /jacket|blazer|(?<!body|cat)suit|coat|sport ?coat|tuxedo|dinner|overshirt|shacket/i
  # T-shirts, shirts, polos, sweatshirts, hoodies and knitwear: worn on the body, under a jacket.
  TOPS = /t-?shirt|\btees?\b|shirt|polo|henley|tank\b|sweatshirt|crewneck|hoodie|hooded|sweater|jumper|cardigan|pullover|knit\b|\bjerseys?\b|\btop\b|bodysuit|quarter[- ]?zip|half[- ]?zip|1\/4[- ]?zip/i
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
    [ "shirt", /shirts?\b/i ],
    # A quarter zip that's none of these (not a "Quarter-Zip Shirt" or a knit one) is a sweatshirt with a zip.
    [ "sweatshirt", /quarter[- ]?zip|half[- ]?zip|1\/4[- ]?zip/i ]
  ].freeze
  TROUSERS = /trouser|pants?\b|jeans?\b|chinos?\b|slacks|leggings?\b|\btights\b|joggers?\b|sweatpants?|track ?pants?|\bshorts?\b(?![- ]?sleeve)|skirts?\b|skort/i
  # Worn over tailoring and cut long; fitted with more room and no "right" length.
  COATS = /overcoat|topcoat|top coat|car coat|trench|peacoat|pea coat|parka|duffle|\bcoat\b/i
  NOT_COATS = /sport ?coat|(?<!body|cat)suit|blazer|tuxedo/i
  # A "hoodie" that's insulated is outerwear (Canada Goose calls jackets hoodies), and so is one that zips up
  # with a hood, unless it's knitwear (a sweater hoodie with a zip is a knit top, worn as a hoodie is).
  INSULATED = /\bdown\b|downproof|puffer|quilted|insulated|padded|parka|windbreaker|shell/i
  HOODED_OUTERWEAR = Regexp.union(INSULATED, /zip(?:per)? closure|two-way zip/i)
  # A puffer (a down or padded jacket, coat or vest, quilted into baffles): drawn lofted, standing off the
  # body, its baffles puffed. Not "button-down", nor a shell that's only "padded at the shoulders".
  PUFFER = /puffer|nuptse|\bdown[- ](?:filled|fill|jacket|parka|coat|vest|insulat\w*)|(?:goose|duck) down|down (?:and|&) feather|fill[- ]power|quilted|baffle|\binsulated\b|\bpadded (?:jacket|coat|vest|parka)/i
  # Knitwear: a sweater, a cardigan, anything knitted. Drawn as a knit (ribbed, matte) whatever its fibre.
  KNITWEAR = /sweater|jumper|cardigan|\bknit(?:ted|wear)?\b|crochet|cable[- ]knit|rib[- ]?knit|merino|cashmere/i
  # A top made to sit close: a shrunken or baby fit, a fitted or slim cut. (Not "fitted cuffs" or a
  # "fitted hem", which most sweatshirts have.)
  FITTED_TOP = /shrunken|\bbaby (?:tee|t-?shirt|rib|fit)|\bslim\b|\bfitted\b(?!\s*(?:cuffs?|hems?|waist(?:band)?|sleeves?|neck))|body[- ]?con|second[- ]skin|form[- ]fitting|skin[- ]?tight/i
  # Kiwi Sizing's chart API, which many Shopify shops load their size charts from (see Page#kiwi_sizing).
  KIWI_SIZING = "https://app.kiwisizing.com/api/getSizingChart"

  # How a jacket looks, so the 3D view draws the right one: tailored (blazers, suit and sport jackets),
  # shirt (button-front denim, trucker and work jackets), bomber, or zip (most other outerwear). First match wins.
  STYLES = [
    [ "cardigan", /cardigan/i ],
    [ "tailored", /blazer|(?<!body|cat)suit|sport ?coat|tuxedo|dinner jacket|smoking jacket|lapel/i ],
    [ "bomber", /bomber|varsity|letterman|flight jacket|ma-1|baseball jacket|harrington|aviator|blouson/i ],
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
    "indigo" => "#2b3f66", "neutrals" => "#b9ad98", "stone" => "#b8b0a0", "red" => "#7a2a2a",
    # The rest of what shops call their colours (the photo's own colour replaces these once it's read; until
    # then a "Yellow Moss" cardigan shouldn't show navy).
    "yellow" => "#d8bf3a", "mustard" => "#c49a2c", "gold" => "#c8a14a", "lemon" => "#e6d86a", "orange" => "#d8722e",
    "rust" => "#9a4a2a", "terracotta" => "#b0603e", "peach" => "#e8b296", "coral" => "#e07a64", "pink" => "#e3a3b4",
    "rose" => "#c98b93", "blush" => "#e2b8b0", "fuchsia" => "#c2307a", "magenta" => "#b0306e", "purple" => "#5c3a7a",
    "plum" => "#5a2e48", "lilac" => "#b9a2cf", "lavender" => "#b7a8d6", "violet" => "#6a4c9c", "mauve" => "#a5838f",
    "maroon" => "#5a1c24", "sage" => "#a5ab8e", "moss" => "#7a7a3e", "mint" => "#b8dcc4", "lime" => "#a8c64a",
    "forest" => "#2f4a35", "emerald" => "#2a6a4c", "teal" => "#2b6b6e", "turquoise" => "#3aa8a8", "aqua" => "#7ccdd0",
    "sky" => "#9cc3e4", "cobalt" => "#2a4aa8", "royal" => "#2a44a0", "taupe" => "#8a7e72", "sand" => "#cdb894",
    "oatmeal" => "#d8ccb4", "oat" => "#d8ccb4", "bone" => "#e3dccb", "ecru" => "#e2d9c2", "silver" => "#b8bcc2",
    "chocolate" => "#4a2f22", "espresso" => "#3a2a22", "mocha" => "#6a4c3a", "cognac" => "#8a4a26", "slate" => "#5a6270",
    "graphite" => "#45484e", "pewter" => "#7c7f84", "onyx" => "#1c1d20", "heather" => "#9a9ca1", "seal" => "#6e6a60"
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
  # One-piece outfits: drawn and fitted as a top tucked into shorts (a romper) or pants (a jumpsuit), one cloth.
  ONE_PIECES = /romper|jumpsuit|playsuit|boiler ?suit|coveralls?|overalls?\b|dungarees|flight suit/i
  # Worn but not fitted: drawn on the mannequin from the listing's colour and photo, in the size picked.
  ACCESSORIES = %w[shoes socks belt].freeze
  ACCESSORY_GROUPS = { "shoes" => "shoes", "socks" => "socks", "belt" => "belts" }.freeze
  WORN_ON = {
    "shoes" => /sneakers?|\bshoes?\b|\bboots?\b|footwear|loafers?|sandals?|slides?\b|mules?\b|clogs?|trainers?|derby|oxfords?\b|brogues?|moccasins?|\b\d{3}v?\d?\b|runners?|low top|high top/i,
    "socks" => /\bsocks?\b/i,
    "belt" => /\bbelts?\b/i
  }.freeze
  # How a shoe is drawn: a boot (up past the ankle), a loafer (cut low, a thin sole), a sandal (a sole and a
  # strap), or a sneaker (a thick sole, laced to the ankle). First match wins.
  SHOE_STYLES = [
    [ "hightop", /high[- ]?tops?|\bhi\b/i ],
    [ "sneaker", /sneakers?|trainers?|runners?|running shoes?/i ],
    [ "boot", /\bboots?\b|chelsea|chukka|combat|hiking/i ],
    [ "sandal", /sandals?|slides?\b|mules?\b|clogs?|flip[- ]?flops?|slippers?/i ],
    [ "loafer", /loafers?|moccasins?|penny|derby|oxfords?\b|brogues?|monk strap|dress shoes?|ballet|flats?\b|pumps?\b|heels?\b/i ]
  ].freeze
  SOCK_STYLES = [ [ "knee", /knee|over[- ]the[- ]calf|\bhigh\b/i ], [ "ankle", /ankle|no[- ]show|low[- ]cut|quarter|trainer socks?/i ] ].freeze
  ELASTIC_WAIST = /elastic(?:ated|ised|ized)?\s+(?:waist|waistband)|drawcord|drawstring|pull[- ]on/i
  BROWSER_PHOTO = %r{\Adata:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+\z}
  # Bump when what an import returns changes, so cached imports from before aren't served.
  FORMAT = 28

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
    return accessory(product.merge(sizes: page.size_names), kind, source_url) if ACCESSORIES.include?(kind)
    if kind == "onepiece"
      sized = product.merge(sizes: page.size_names, women: women?(product, source_url))
      return one_piece(sized, source_url) { |part, part_kind| usual_for(part_kind, top_style_of(part), part) }
    end

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
    return accessory(product, kind, url) if ACCESSORIES.include?(kind)

    style = usual_key(kind, top_style_of(product), product)
    sizing = given ? given["sizing"] : kiwi_answer(
      "shop" => shop, "product" => data["id"].to_s, "title" => data["title"], "tags" => Array(data["tags"]).join(",").split(/,\s*/).join(","),
      "type" => data["product_type"], "vendor" => data["vendor"])
    return one_piece(product, url) { |part, part_kind| read_kiwi(sizing, part_kind) || usual_for(part_kind, top_style_of(part), part) } if kind == "onepiece"
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
    european = european_waists(names) unless women
    inseam = bottom_style_of(product) == "shorts" ? shorts_inseam(product) : nil
    sizes =
      if european
        european.map { |name, w| trouser_size(name, w * 2.54, women, opening, roomy, inseam:) }
      elsif waists.size >= 2
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

  # Men's pants numbered the European way, not by waist inches: French sizes (38 to 46 and on: none under 36,
  # and none odd, as waist sizes have) are the waist in inches plus 10; Italian ones (from 44, running past
  # 50) plus 16. { "44" => 34, ... } (waist inches), or nil for waist sizes.
  def european_waists(names)
    numbers = Array(names).filter_map { it.to_s.strip[/\A\d{2}\z/]&.to_i }.uniq.sort
    return if numbers.size < 2 || numbers.min < 36 || numbers.any?(&:odd?)

    less = numbers.min >= 42 && numbers.max > 50 ? 16 : 10
    numbers.to_h { [ it.to_s, it - less ] }
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
    "jacket_women" => [ [ 91, 37.5, 56, 57 ], [ 5, 1.5, 0.5, 1.5 ] ],
    "coat" => [ [ 104, 44, 62, 92 ], [ 6, 2, 1, 2 ] ],
    "coat_women" => [ [ 100, 37.5, 56, 96 ], [ 5, 1.5, 0.5, 1.5 ] ],
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

  # Shoes, socks or a belt: their look (a shoe's style, a belt's buckle), colour and cloth, and the shop's sizes
  # to pick from. Nothing is measured: they're drawn on the mannequin as they look.
  def accessory(product, kind, source_url)
    words = product.values_at(:name, :category, :description).join(" ")
    named = product.values_at(:name, :category).join(" ")
    style = case kind
            when "shoes" then SHOE_STYLES.find { |_, pattern| named.match?(pattern) }&.first || "sneaker"
            when "socks" then SOCK_STYLES.find { |_, pattern| named.match?(pattern) }&.first || "crew"
            else "belt"
            end
    fabric = case words
             when /suede|nubuck/i then "suede"
             when /leather/i then "leather"
             when /canvas|nylon|webbing|mesh|knit/i then "canvas"
             else kind == "socks" ? "knit" : kind == "belt" ? "leather" : "canvas"
             end
    names = Array(product[:sizes]).map(&:to_s).reject { it.match?(/\Adefault title\z/i) }.presence || [ "One size" ]
    {
      name: product[:name].presence || kind.capitalize,
      brand: product[:brand],
      color_name: product[:color],
      color: color_hex(product.values_at(:color, :description, :name)),
      fabric:,
      style:,
      **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:,
      garment: kind,
      **(kind == "belt" ? { buckle: words.match?(/gold|brass/i) ? "gold" : "silver" } : {}),
      **(product[:women] ? { women: true } : {}),
      chart: { sizes: names.first(30).map { { "name" => it } }, unit: "cm", kind: "sizes", missing: [] }
    }
  end

  # A romper or a jumpsuit as its two halves, each fitted as its own kind: a top (a tank on straps, else a
  # tee or a long-sleeve top, by its sleeves) and shorts or pants, with its colour and cloth. Yields each
  # half's listing and kind for its chart.
  def one_piece(product, source_url)
    cut = DressCut.read(product)
    words = product.values_at(:name, :category, :description).join(" ")
    top_style = { "long" => "Long Sleeve Tee", "short" => "Tee" }.fetch(cut[:sleeves], "Tank")
    shorts = words.match?(/romper|playsuit|short/i) && !words.match?(/jumpsuit|boiler|coverall|overall|dungaree|flight suit/i)
    name = product[:name].to_s.sub(/\s+[-–]\s+[^-–]+\z/, "")
    top = product.merge(name: "#{name} #{top_style}", category: top_style, description: product[:description].to_s.gsub(ONE_PIECES, ""))
    bottom = product.merge(name: "#{name} #{shorts ? "Shorts" : "Pants"}", category: shorts ? "Shorts" : "Pants", description: product[:description].to_s.gsub(ONE_PIECES, ""))
    parts = { top: garment(top, yield(top, "top"), kind: "top", source_url:), trousers: garment(bottom, yield(bottom, "trousers"), kind: "trousers", source_url:) }
    parts.each_value { it.merge!(name: product[:name], color_name: product[:color], one_piece: true) }
    {
      name: product[:name], brand: product[:brand], color_name: product[:color], color: parts[:top][:color],
      fabric: parts[:top][:fabric], garment: "onepiece", style: shorts ? "romper" : "jumpsuit",
      **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:, **(product[:women] ? { women: true } : {}), parts:
    }
  end

  # Top, jacket, coat or trousers, from the product's name and category.
  def kind_of(product)
    # Not the colour after the name: Willy Chavarria's "Track Jacket - Peacoat" is a jacket, not a pea coat.
    words = [ product[:name].to_s.sub(/\s+[-–]\s+[^-–]+\z/, ""), product[:category] ].join(" ")
    # The shop's own category and tags say first what something is: a sneaker is shoes, whatever its name says.
    # (Not a tag that's the product's own name, as Kith tags every product: "Tie-front Cardigan ... Vest" isn't a tie.)
    tags = Array(product[:tags]).grep(/\A(?!mens\z|wmns\z|womens\z)/i).reject { it.to_s.include?(" - ") || it.to_s.casecmp?(product[:name].to_s) }
    sorted = [ product[:category], *tags ].compact.join(" ")
    # The category alone first: Teatora's "Wallet Short", filed under Shorts, is shorts, not a wallet.
    not_fitted = NOT_FITTED.find { |_, pattern| product[:category].to_s.match?(pattern) }
    not_fitted ||= NOT_FITTED.find { |_, pattern| sorted.match?(pattern) || words.match?(pattern) && !words.match?(Regexp.union(DRESSES, TOPS, JACKETS, TROUSERS)) } unless product[:category].to_s.match?(Regexp.union(DRESSES, TOPS, JACKETS, TROUSERS))
    # Shoes, socks and belts are drawn (on the feet, on the legs, round the waist), with no fit to check.
    if not_fitted && (worn = WORN_ON.find { |kind, pattern| not_fitted.first == ACCESSORY_GROUPS[kind] && words.match?(pattern) && !words.match?(/\bbags?\b|backpack|wallet/i) }&.first)
      return worn
    end
    if not_fitted
      raise Error.new("not_supported", "Fitroom can't try on #{not_fitted.first} yet. It works with tops, dresses, jackets, coats and pants.")
    end
    # A romper or jumpsuit: a top and shorts or pants made as one piece.
    return "onepiece" if words.match?(ONE_PIECES)
    # A "Maxi Coat" is a coat, not a dress (a "Trench Dress" is still a dress).
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS) && !words.match?(/\bdress\b/i)
    # A "maxi skirt" is a skirt, not a dress.
    return "top" if words.match?(DRESSES) && !words.match?(/skirts?\b|skort/i)
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS)
    # A sweater vest (knitted, sleeveless) is worn over a shirt or a tee, as a jacket is, and drawn as a tank
    # (see garment); a padded or down vest is outerwear.
    return "jacket" if vest?(product)
    # A cardigan is worn open over a top, as a jacket is.
    return "jacket" if words.match?(/cardigan/i)
    # So is a knit that zips all the way down ("Crochet Cable Zip Track"), but not a half-zip pullover.
    return "jacket" if words.match?(/\bzip\b|zip[- ]up|full[- ]zip/i) && words.match?(/sweater|knit|crochet|cable|track/i) && !words.match?(/half[- ]zip|quarter[- ]zip|1\/4|hood/i)
    # Pants named for their cloth ("Suiting Trouser") are pants, not a suit's jacket.
    return "trousers" if product[:name].to_s.match?(/\b(?:trousers?|pants?|jeans?|shorts?(?![- ]?sleeve)|skirts?)\s*(?:[-–].*)?\z/i) || product[:category].to_s.match?(TROUSERS)
    return "jacket" if words.match?(JACKETS)
    if words.match?(/hoodie|hooded/i) && product[:description].to_s.match?(HOODED_OUTERWEAR)
      # A knit hoodie that zips is still a knit top; an insulated one is a jacket whatever it's made of.
      return "jacket" if product[:description].to_s.match?(INSULATED) || !knitwear?(product)
    end
    return "trousers" if words.match?(TROUSERS)
    return "top" if words.match?(TOPS)
    # A shop's page that names nothing else is most often a jacket (a "Hudson"); a Shopify listing says what it is.
    return "jacket" unless words.match?(UNSUPPORTED) || product[:sorted]

    raise Error.new("not_supported", "Fitroom can't try this on yet. It works with tops, dresses, jackets, coats and pants.")
  end

  def vest?(product) = product.values_at(:name, :category).join(" ").match?(/\bvests?\b/i) && !product.values_at(:name, :description).join(" ").match?(INSULATED)

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
    chart = shoulder_sleeves(plausible(chart, kind), product) unless kind == "trousers"
    style = kind == "top" ? top_style_of(product) : kind == "trousers" ? bottom_style_of(product) : kind == "jacket" && vest?(product) ? "tank" : nil
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
    # Pants: pull-on (an elastic or drawcord waist, gathered in, which stretches to fit), how loose the shop
    # says they're cut, and whether they come unhemmed.
    skirt_cut = bottoms_cut(product, style, chart) if kind == "trousers" && style != "skirt"
    if style == "dress"
      cut = DressCut.read(product)
      chart = chart.with(missing: chart.missing - DressCut.not_needed(cut))
      return dress_garment(product, chart, cut, source_url)
    end
    # A top's cut, when its listing says it sits close or is made oversized (see top_cut); a jacket's, when
    # it's oversized or made to end at the waist (see jacket_cut).
    fit_cut = kind == "top" ? top_cut(product) : kind == "jacket" ? jacket_cut(product) : nil
    # A bodysuit fastens below, so it's always worn tucked in, and it's cut to sit close and stretch on.
    bodysuit = kind == "top" && product.values_at(:name, :category).join(" ").match?(/bodysuit/i)
    fit_cut = { fit: "fitted", stretch: true } if bodysuit && fit_cut&.dig(:fit) != "fitted"
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
      **(%w[top jacket].include?(kind) && product.values_at(:name, :description).join(" ").match?(/crop(?:ped)?\b/i) ? { cropped: true } : {}),
      **(kind == "top" && chart.kind == "sizes" && baby_tee?(product) ? { snug: true } : {}),
      **(skirt_cut ? { cut: skirt_cut } : fit_cut ? { cut: fit_cut } : {}),
      **(kind == "top" && product[:shape] && sleeves_sewn(product[:shape]) == :low ? { dropped: true } : {}),
      **(style == "hoodie" && zipped?(product) ? { zip: true } : {}),
      **(bodysuit ? { bodysuit: true } : {}),
      **(%w[jacket coat].include?(kind) && product.values_at(:name, :description).join(" ").match?(PUFFER) ? { puffer: true } : {}),
      chart: chart.as_json
    }
  end

  # Whether a listing is knitwear (a sweater, a cardigan, a knit hoodie), by its name, category and description.
  def knitwear?(product) = product.values_at(:name, :category, :description).join(" ").match?(KNITWEAR)

  # How a top is cut, when its listing says it sits close: { fit: "fitted", stretch: true/false }. stretch: the
  # cloth gives (a knit, a rib, elastane), so the top is made about the size of the body, or smaller, and
  # stretches on; the fit engine then allows it no room (see Fit#check_top), and the 3D view cuts it close.
  # Nil for a top that says nothing about its fit (the usual).
  def top_cut(product)
    words = product.values_at(:name, :description).join(" ")
    return oversized?(product, words) ? { fit: "oversized" } : nil unless words.match?(FITTED_TOP)

    { fit: "fitted", stretch: knitwear?(product) || words.match?(DressCut::STRETCH) }
  end

  # A top or jacket the shop says is made big (the fit engine then judges it by the room it's made with, see
  # Fit#design), unless its photo shows it cut close.
  OVERSIZED = /oversized|\bboxy\b|loose[- ]fit|relaxed[- ]fit|drop(?:ped)?[- ]shoulders?/i
  def oversized?(product, words = product.values_at(:name, :description).join(" "))
    words.match?(OVERSIZED) && !(product[:shape] && sleeves_sewn(product[:shape]) == :high)
  end

  # A jacket's cut: { fit: "oversized" } (see oversized?), { ends: "waist" } for one made to end at the waist
  # (a track jacket, a blouson or bomber: its length is then where it ends, not right or wrong). Nil for neither.
  WAIST_LENGTH = /\btrack\b|blouson|bomber|varsity|letterman|harrington|aviator|\bma-1\b|crop(?:ped)?\b/i
  def jacket_cut(product)
    cut = { **(oversized?(product) ? { fit: "oversized" } : {}), **(product[:name].to_s.match?(WAIST_LENGTH) ? { ends: "waist" } : {}) }
    cut.presence
  end

  # How pants are made, as the fit engine and the 3D view read it: { elastic: true } for pull-on pants
  # (joggers and leggings are already), { fit: "loose" } or "slim" by the shop's words, { hem: "unfinished" }
  # for pants sold long, to be hemmed (see unfinished_hem). Nil for none of these.
  LOOSE_BOTTOMS = /\b(?:baggy|wide(?:[- ]leg)?(?![- ]?(?:waist)?band)|relaxed|loose|oversized|pleat(?:s|ed)?|balloon|barrel)\b/i
  SLIM_BOTTOMS = /\b(?:slim|skinny|tapered)\b/i
  def bottoms_cut(product, style, chart)
    words = product.values_at(:name, :description).join(" ")
    loose, slim = words.match?(LOOSE_BOTTOMS), words.match?(SLIM_BOTTOMS)
    cut = {}
    cut[:elastic] = true if !%w[joggers leggings].include?(style) && words.match?(ELASTIC_WAIST)
    cut[:fit] = loose ? "loose" : "slim" if style != "leggings" && loose != slim
    cut[:hem] = "unfinished" if !%w[shorts leggings].include?(style) && unfinished_hem?(chart, words, product[:women])
    cut.presence
  end

  # Pants sold unhemmed, for a tailor to finish to the wearer: the listing says so, or every size has the
  # same inseam, far longer (12 cm) than a usual leg's. A raw hem is only a cut edge (frayed jeans) unless
  # the leg is long too.
  UNHEMMED = /unhemmed|un-hemmed|unfinished (?:hem|length|leg)|hem (?:is )?left unfinished|to be hemmed|hemmed to (?:order|length|your)/i
  UNHEMMED_PAST = 12
  def unfinished_hem?(chart, words, women)
    leg = women ? 76 : 81
    inseams = chart.sizes.map { it["inseam"] }
    long = inseams.all? && inseams.size >= 2 && inseams.min > leg + UNHEMMED_PAST && inseams.max - inseams.min <= 2
    long || words.match?(UNHEMMED) || (words.match?(/raw[- ]hem/i) && inseams.compact.any? && inseams.compact.min > leg + 6)
  end

  # A hoodie that zips all the way down the front (drawn with a zip; a half-zip pullover isn't).
  def zipped?(product, words = product.values_at(:name, :description).join(" "))
    words.match?(/full[- ]zip|zip[- ]up|zip(?:per)? (?:closure|front|hoodie|hoody|sweatshirt)|zip[- ]?thr(?:ough|u)|two-way zip|\bzipped\b/i) && !words.match?(/half[- ]zip|quarter[- ]zip|1\/4[- ]zip/i)
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
    # Knitwear is a knit whatever it's spun from (a cotton sweater hoodie, a wool cardigan): ribbed and matte,
    # never a woven cloth or a shell. Silk and leather keep their look.
    return "knit" if kind != "trousers" && knitwear?(product) && !%w[silk leather].include?(fabric)

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
    return chart if chart.sleeve_from
    sizes = chart.sizes.map do |size|
      next size unless size["sleeve"] && size["sleeve"] > Fit::SHORT_SLEEVE

      size.merge("sleeve" => from_shoulder(size))
    end
    chart.with(sizes:)
  end

  # Charts measure a sleeve from the shoulder seam, or from the centre of the back of the neck (across half
  # the shoulders first), and say which only sometimes. Fitroom keeps the sleeve from the shoulder seam:
  # converted here, once, when the chart says it runs from the centre back (sleeve_from "centre_back", see
  # ChartReader) or when its sleeves are too long to be from the shoulder ("centre_back_guessed"). A sleeve
  # from the shoulder runs at most about 10 cm past the usual arm (extra-long sleeves that cover the hand:
  # Kith's shrunken knit hoodie, 65.7 cm on a women's 58 cm arm, is one); from the centre back it's the arm
  # plus half the shoulders, 18 to 24 cm past it. Judged on the chart's middle size, so every size is read
  # the same way.
  USUAL_ARM = { women: 58, men: 65 }.freeze
  SHOULDER_SLEEVE_PAST_ARM = 10
  WOMEN_SHOULDERS = 42   # a chart whose middle size's shoulders are under this is cut for women
  def shoulder_sleeves(chart, product)
    return chart if chart.sleeve_from && chart.sleeve_from != "centre_back"

    sleeves = chart.sizes.filter_map { it["sleeve"] }.sort
    return chart if sleeves.empty?

    from = chart.sleeve_from
    shoulders = chart.sizes.filter_map { it["shoulders"] }.sort
    women = product[:women] || (shoulders.any? && shoulders[shoulders.size / 2] < WOMEN_SHOULDERS)
    from ||= "centre_back_guessed" if sleeves[sleeves.size / 2] > USUAL_ARM.fetch(women ? :women : :men) + SHOULDER_SLEEVE_PAST_ARM &&
                                      !long_in_photo?(chart, product[:shape])
    return chart unless from

    chart.with(sizes: chart.sizes.map { it["sleeve"] ? it.merge("sleeve" => from_shoulder(it)) : it }, sleeve_from: from)
  end

  # Whether the shop photo shows sleeves as long as the chart's, read from the shoulder seam: past the
  # threshold above, a sleeve is either from the centre back or made extra long (one that covers the hand,
  # or bunches at the wrist), and only the photo tells. The photo gives the sleeve's reach and the body's
  # length, each over the chest's width (see photo_shape); the middle size's sleeve over its length, read
  # either way, is compared with that, and the nearer reading wins. Kith's Camilla Plunge Shirt: 70 cm
  # sleeves on a 56 cm body, which the photo shows hanging well past the hem (a reach about 1.45 times
  # the length), so from the shoulder (1.26), not the centre back (0.90).
  def long_in_photo?(chart, shape)
    reach, length = shape.to_h.values_at(:sleeve, :length)
    return false unless reach && length&.positive?

    size = chart.sizes.select { it["sleeve"] && it["length"] }.then { it[it.size / 2] } or return false
    seen = reach / length
    (size["sleeve"] / size["length"] - seen).abs < (from_shoulder(size) / size["length"] - seen).abs
  end

  # A size's sleeve from the shoulder seam, when the chart gives it from the centre back: less half the
  # shoulders (a man's usual 46 cm when the chart doesn't give them).
  def from_shoulder(size) = (size["sleeve"] - (size["shoulders"] || 46) / 2.0).round(2)

  def top_style_of(product)
    style = product.values_at(:name, :category).each do |words|
      found = TOP_STYLES.find { |_, pattern| words.to_s.match?(pattern) }&.first
      break found if found
    end
    style = "tee" unless style.is_a?(String)
    # A henley the shop files under short-sleeve ones ("Short Sleeve Henleys") is a tee with buttons.
    return "tee" if style == "longsleeve" && product[:category].to_s.match?(/short[- ]?sleeve/i) && !product[:name].to_s.match?(/long[- ]?sleeve|\bl\/s\b/i)
    # A top on straps (a bodysuit or a cami named for neither) is a tank.
    return "tank" if style == "tee" && product[:description].to_s.match?(/sleeveless|(?:shoulder|spaghetti|thin|wide|adjustable) straps?|\bcami(?:sole)?\b/i)
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

  # The first of the texts (the product's colour, its description, its name) that names a colour, and the
  # colour it names first: "White / Brown" is a white garment with brown on it.
  def color_hex(texts)
    texts.compact.each do |text|
      found = COLORS.filter_map { |name, hex| (at = text =~ /\b#{name}\b/i) && [ at, -name.length, hex ] }.min
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
