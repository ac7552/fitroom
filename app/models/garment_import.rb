# Turns a pasted product link, or a pasted size chart, into a garment Fitroom can fit (a jacket, coat or
# trousers): what it is, its
# colour, and its finished measurements per size. It reads the shop's page once when asked and keeps
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

  UNSUPPORTED = /shorts?\b|shirt|tee\b|t-shirt|polo|dress|skirt|shoe|sneaker|boot|knit|sweater|hoodie|sock|tie\b|belt/i
  JACKETS = /jacket|blazer|suit|coat|sport ?coat|tuxedo|dinner/i
  TROUSERS = /trouser|pants?\b|jeans?\b|chinos?\b|slacks/i
  # Worn over tailoring and cut long; fitted with more room and no "right" length.
  COATS = /overcoat|topcoat|top coat|car coat|trench|peacoat|pea coat|parka|duffle|\bcoat\b/i
  NOT_COATS = /sport ?coat|suit|blazer|tuxedo/i

  # How a jacket looks, so the 3D view draws the right one: tailored (blazers, suit and sport jackets),
  # shirt (button-front denim, trucker and work jackets), bomber, or zip (most other outerwear). First match wins.
  STYLES = [
    [ "tailored", /blazer|suit|sport ?coat|tuxedo|dinner jacket|smoking jacket|lapel/i ],
    [ "bomber", /bomber|varsity|letterman|flight jacket|ma-1|baseball jacket|harrington/i ],
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

  def self.from_url(url)
    Rails.cache.fetch([ "garment_import", FORMAT, Digest::SHA256.hexdigest(url.to_s.strip) ], expires_in: 1.hour) do
      new.from_page(Fetcher.get(url), source_url: url.to_s.strip).then { with_photo(it) }
    end
  rescue Fetcher::Error => e
    raise Error.new("fetch_failed", e.message)
  end

  KINDS = %w[jacket coat trousers].freeze
  # Bump when what an import returns changes, so cached imports from before aren't served.
  FORMAT = 3

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

  # garment: what a pasted chart is for ("jacket", "coat" or "trousers"); a link works it out from the page.
  def self.from_text(text, garment: "jacket") = new.from_text(text, garment:)

  def from_page(html, source_url:)
    page = Page.new(html)
    product = page.product
    kind = kind_of(product)

    # The table that gives the most measurements wins; a resale listing's own measurements come next.
    chart = page.tables.filter_map { ChartReader.read(it.rows, context: it.context, garment: kind) }.min_by { it.missing.size }
    chart ||= page.item_measurements&.then { ChartReader.read(it, context: "item measurements", single: true, garment: kind) }
    unless chart
      raise Error.new("no_size_chart", "Couldn't find a size chart on that page. Many shops load it in a pop-up: " \
                                       "copy the chart from there and paste it instead.")
    end

    garment(product, chart, kind:, source_url:)
  end

  def from_text(text, garment: "jacket")
    kind = KINDS.include?(garment.to_s) ? garment.to_s : "jacket"
    rows = text.to_s.lines.map { |line| split_line(line) }.reject { |row| row.all?(&:blank?) }
    chart = ChartReader.read(rows, context: text.to_s, garment: kind)
    raise Error.new("no_size_chart", "Couldn't read that as a size chart. Copy the whole table, header row included.") unless chart

    name = { "jacket" => "Pasted jacket chart", "coat" => "Pasted coat chart", "trousers" => "Pasted trousers chart" }[kind]
    garment({ name:, brand: nil, color: nil, category: nil, description: nil }, chart, kind:, source_url: nil)
  end

  private

  # Jacket, coat or trousers, from the product's name and category.
  def kind_of(product)
    words = product.values_at(:name, :category).join(" ")
    return "coat" if words.match?(COATS) && !words.match?(NOT_COATS)
    return "jacket" if words.match?(JACKETS)
    return "trousers" if words.match?(TROUSERS)
    return "jacket" unless words.match?(UNSUPPORTED)

    raise Error.new("not_supported", "Fitroom fits jackets, coats and trousers so far, and this looks like something else.")
  end

  def garment(product, chart, kind:, source_url:)
    {
      name: product[:name].presence || "Jacket",
      brand: product[:brand],
      color_name: product[:color],
      color: color_hex(product.values_at(:color, :description, :name)),
      fabric: fabric_of(product),
      **(kind == "jacket" ? { style: style_of(product, source_url) } : {}),
      **(product[:image] ? { image_url: product[:image] } : {}),
      source_url:,
      garment: kind,
      chart: chart.as_json
    }
  end

  def fabric_of(product)
    shell = product[:fabric].to_s.split(/[;,]?\s*lining/i).first   # "100% Cashmere; Lining 55% Silk, 45% Cotton"
    words = [ *product.values_at(:name, :category, :description), shell ].join(" ")
    FABRICS.find { |_, pattern| words.match?(pattern) }&.first || "wool"
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
