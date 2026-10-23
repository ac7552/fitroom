# A maker's size chart: the finished measurements of each size, in centimetres.
# Charts describe garments, never the person using the app, so they're the only data Fitroom keeps.
class SizeChart
  DIR = Rails.root.join("config/size_charts")
  MEASUREMENTS = Fit::SIZE_MEASUREMENTS

  class NotFound < StandardError; end

  attr_reader :key, :name, :garment, :source, :sizes, :style, :fabric

  def self.find(key)
    path = DIR.join("#{key}.yml")
    raise NotFound, "no size chart named #{key}" unless key.to_s.match?(/\A[a-z0-9_]+\z/) && path.exist?

    new(key, YAML.safe_load_file(path))
  end

  def self.all
    DIR.glob("*.yml").sort.map { |path| find(path.basename(".yml").to_s) }
  end

  def initialize(key, data)
    @key = key
    @name = data.fetch("name")
    @garment = data.fetch("garment")
    @source = data.fetch("source")
    @sizes = data.fetch("sizes").map { |size| size.slice("name", *MEASUREMENTS) }
    # How the 3D view draws it, when the chart says (see GarmentImport): its style, cloth and colour.
    @style = data["style"]
    @fabric = data["fabric"]
    @color = data["color"]
    @color_name = data["color_name"]
    @cut = data["cut"]&.transform_keys(&:to_sym)
  end

  def summary
    { key:, name:, garment:, source: }
  end

  # The same shape a GarmentImport returns, so clients treat built-in and imported jackets alike.
  def as_garment
    {
      name:, brand: nil, color_name: @color_name || "Navy", color: @color || GarmentImport::COLORS["navy"], source_url: nil, garment:,
      **({ style:, fabric:, cut: @cut }.compact),
      chart: { sizes:, unit: "cm", kind: "garment", missing: MEASUREMENTS.reject { |m| sizes.any? { it[m] } } }
    }
  end

  def as_json(*)
    summary.merge(sizes:)
  end
end
