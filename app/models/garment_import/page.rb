class GarmentImport
  # Reads a product page: what the item is (from its schema.org Product data, falling back to the page
  # title), every table on it that could be a size chart, with the text around it for clues, and, for
  # single-item listings (resale shops), the item's own measurements written as "Chest  50.5"" pairs.
  class Page
    Table = Data.define(:rows, :context)
    WORDS = "chest|bust|pit to pit|p2p|shoulders?|waist|sleeves?|sleeve length|length|back length|" \
            "seat|hips?|thigh|inseam|inside leg|rise|leg opening|hem|ankle opening"
    LABEL = /\A(#{WORDS})\z/i
    INLINE = /\A(#{WORDS})\s*[:\-–]\s*(\d.*)\z/i

    def initialize(html)
      @doc = Nokogiri::HTML(html)
    end

    def product
      data = product_json_ld || {}
      name = data["name"].presence || meta("og:title") || @doc.at("title")&.text
      {
        name: name.to_s.squish.truncate(120),
        brand: brand(data["brand"]),
        color: data["color"].to_s.squish.presence,
        category: data["category"].to_s.squish.presence,
        description: data["description"].to_s.squish.truncate(400),
        fabric: labelled("Fabric")&.truncate(80),
        image: Array(data["image"]).map { it.is_a?(Hash) ? it["url"] || it["contentUrl"] : it }.find { it.to_s.start_with?("http") } || meta("og:image")
      }
    end

    def tables
      @doc.css("table").map do |table|
        rows = table.css("tr").map { |tr| tr.css("th, td").map(&:text) }
        Table.new(rows:, context: [ table.at("caption")&.text, heading_before(table), table.text ].compact.join(" ").squish)
      end
    end

    # Shopify shops using the Kiwi Sizing app load their size chart from Kiwi's API after the page opens.
    # The page carries what Kiwi needs to pick the chart: the shop and the product's id, title, tags, type,
    # vendor and collections. Returns them, or nil when the page doesn't use Kiwi.
    def kiwi_sizing
      script = @doc.css("script").map(&:text).select { it.include?("KiwiSizing") }.join("\n")
      shop = script[/KiwiSizing\.shop\s*=\s*"([^"]+)"/, 1]
      fields = %w[product title tags type vendor collections].to_h do |field|
        [ field, script[/^\s*#{field}:\s*"((?:[^"\\]|\\.)*)"/, 1]&.then { JSON.parse(%("#{it}")) rescue it } ]
      end
      return unless shop&.end_with?(".myshopify.com") && fields["product"].to_s.match?(/\A\d+\z/)

      { "shop" => shop, **fields.compact }
    end

    # A link to the shop's size guide on the same site, as an absolute URL, or nil.
    def size_guide_link(page_url)
      base = URI(page_url.to_s)
      guide = /size[\s_-]*(guide|chart)/i
      links = @doc.css("a[href]").select { "#{it.text} #{it['href']}".match?(guide) }
      # Links whose address says size guide first; a "Size guide" button that opens a pop-up goes nowhere.
      links.sort_by { it["href"].match?(guide) ? 0 : 1 }.each do |a|
        url = URI.join(base, a["href"].strip) rescue next
        next unless url.is_a?(URI::HTTP) && url.host == base.host

        url.fragment = nil
        return url.to_s unless url.to_s == base.dup.tap { it.fragment = nil }.to_s
      end
      nil
    rescue URI::InvalidURIError
      nil
    end

    # The size a single-item listing says it is ("Size: M" on resale listings), or nil.
    def stated_size
      label = @doc.css("body *").lazy.map { it.element_children.empty? ? it.text.squish : nil }
                  .find { it&.match?(/\ASize:\s*\S/) }
      label&.delete_prefix("Size:")&.strip&.tr("|", "/")&.squish&.truncate(20, omission: "")
    end

    # A single item's measurements as a one-row table: [["Size", "Chest", ...], ["XXL", "50.5\"", ...]].
    def item_measurements
      pairs = {}
      @doc.css("body *").each do |node|
        next unless node.element_children.empty?

        text = node.text.squish
        if (inline = text.match(INLINE))
          pairs[inline[1].capitalize] ||= inline[2]
        elsif text.match?(LABEL)
          value = (next_content(node) || next_content(node.parent))&.text&.squish
          pairs[text.capitalize] ||= value if value&.match?(/\A\d/)
        end
      end
      return if pairs.size < 2

      [ [ "Size", *pairs.keys ], [ item_size, *pairs.values ] ]
    end

    private

    # The value written beside a label on the page ("Fabric" then "100% wool"), as resale listings do.
    def labelled(label)
      @doc.css("body *").each do |node|
        next unless node.element_children.empty? && node.text.squish.casecmp?(label)

        value = (next_content(node) || next_content(node.parent))&.text&.squish
        return value if value.present? && value.size < 200
      end
      nil
    end

    # The next sibling that holds text, skipping the <style> and <script> tags some sites put in between.
    def next_content(node)
      sibling = node&.next_element
      sibling = sibling.next_element while sibling && %w[style script noscript template].include?(sibling.name)
      sibling
    end

    # "Size: XXL | US44, IT54" on resale listings, else "One size".
    def item_size = stated_size || "One size"

    def product_json_ld
      @doc.css('script[type="application/ld+json"]').each do |script|
        found = find_product(JSON.parse(script.text))
        return found if found
      rescue JSON::ParserError
        next
      end
      nil
    end

    def find_product(node)
      case node
      when Array then node.lazy.filter_map { find_product(it) }.first
      when Hash
        return node if Array(node["@type"]).include?("Product") || Array(node["@type"]).include?("ProductGroup")

        find_product(node["@graph"]) if node["@graph"]
      end
    end

    def brand(value)
      (value.is_a?(Hash) ? value["name"] : value).to_s.squish.presence
    end

    def meta(property)
      @doc.at(%(meta[property="#{property}"]))&.[]("content").presence
    end

    # The nearest heading above the table, which often says "Body measurements" or "Garment measurements".
    def heading_before(table)
      node = table
      12.times do
        node = node.previous_element || node.parent
        break if node.nil? || node.name == "body"
        return node.text if node.name.match?(/\Ah[1-6]\z/) || node.name == "p"
      end
      nil
    end
  end
end
