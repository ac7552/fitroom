class GarmentImport
  # Turns a size chart table (rows of cell text, from a web page or pasted) into finished garment
  # measurements per size, in centimetres, for a jacket or coat (chest, waist, shoulders, sleeve, length) or
  # trousers (waist, seat, thigh, inseam, leg opening).
  #
  # Shops write charts many ways: sizes as rows or as columns, inches or cm, "pit to pit" half widths,
  # ranges like "38-40", and either the garment's own measurements or the body it's meant to fit. This
  # works out which, and converts body charts to estimated garment measurements.
  class ChartReader
    # For each kind of garment: its columns (checked in order, so "Sleeve length" is a sleeve and "Inside leg"
    # an inseam), the one a chart must have, the believable range for it in cm, and the ease a regular cut
    # adds to a body chart's numbers.
    SCHEMES = {
      "jacket" => {
        columns: {
          "chest" => /chest|bust|pit|p2p/i,
          "waist" => /waist/i,
          "shoulders" => /shoulder/i,
          "sleeve" => /sleeve|\barm\b/i,
          "length" => /length|back|nape/i
        },
        key: "chest", plausible: 70..180, inches_below: 70,
        body_to_garment: { "chest" => 11, "waist" => 12.5, "shoulders" => 0.75, "sleeve" => -1.5 }
      },
      "trousers" => {
        columns: {
          "waist" => /waist/i,
          "seat" => /seat|hip/i,
          "thigh" => /thigh/i,
          "inseam" => /inseam|inside leg|inner leg|leg length/i,
          "leg_opening" => /opening|hem|bottom|ankle|cuff/i
        },
        key: "waist", plausible: 55..160, inches_below: 52,
        body_to_garment: { "waist" => 2.5, "seat" => 6 }
      }
    }.freeze
    HALF = /pit|p2p|half|flat|across/i
    BODY_WORDS = /body measure|to fit|fits chest|fits waist|your (?:chest|waist|measure)|body size/i
    GARMENT_WORDS = /garment|finished|laid flat|product measure|item measure|flat measure/i

    Chart = Data.define(:sizes, :unit, :kind, :missing) do
      def as_json(*) = { sizes:, unit:, kind:, missing: }
    end

    def self.measures(garment) = SCHEMES.fetch(scheme_for(garment))[:columns].keys
    def self.scheme_for(garment) = garment.to_s == "trousers" ? "trousers" : "jacket"

    def self.read(rows, context: "", single: false, garment: "jacket") = new(rows, context, single:, garment:).read

    # single: the table is one item's own measurements (a resale listing), so one size is enough and
    # the numbers are the garment's. garment: "jacket", "coat" or "trousers".
    def initialize(rows, context, single: false, garment: "jacket")
      @single = single
      @scheme = SCHEMES.fetch(self.class.scheme_for(garment))
      @columns = @scheme[:columns]
      @key = @scheme[:key]
      @rows = rows.map { |row| row.map { it.to_s.squish } }.reject { |row| row.all?(&:blank?) }
      @context = context.to_s
    end

    # Returns a Chart, or nil if the table isn't a size chart for this kind of garment.
    def read
      table = oriented
      return conversion unless table

      header, *body = table
      columns = map_columns(header)
      return unless columns.key?(@key) && body.size >= (@single ? 1 : 2)

      unit = detect_unit(header, columns, body)
      raw = body.filter_map { |row| raw_size(row, columns) }
      return if raw.size < (@single ? 1 : 2)

      kind = @single ? "garment" : detect_kind(raw, unit)
      sizes = raw.map { |size| to_garment_cm(size, unit, kind) }
      return unless sizes.all? { |s| s[@key]&.between?(@scheme[:plausible].min, @scheme[:plausible].max) }

      Chart.new(sizes:, unit:, kind:, missing: @columns.keys - columns.keys)
    end

    private

    # Sizes as rows, with measurements across the top. Transposes charts written the other way round.
    def oriented
      return if @rows.size < 2

      width = @rows.map(&:size).max
      rows = @rows.map { |row| row + [ "" ] * (width - row.size) }
      return rows if measurement_labels(rows.first) >= 2
      return rows.transpose if measurement_labels(rows.map(&:first)) >= 2

      nil
    end

    def measurement_labels(cells) = cells.count { |cell| @columns.values.any? { it.match?(cell) } }

    def map_columns(header)
      columns = {}
      order = @columns.keys.sort_by { %w[sleeve inseam].include?(it) ? 0 : 1 }
      header.each_with_index do |label, index|
        next if index.zero?

        key = order.find { @columns[it].match?(label) }
        next if key.nil? || columns.key?(key)

        columns[key] = { index:, half: %w[chest waist seat thigh leg_opening].include?(key) && HALF.match?(label), label: }
      end
      columns
    end

    def raw_size(row, columns)
      name = row.first.to_s.truncate(20, omission: "")
      return if name.blank? || @columns.values.any? { it.match?(name) }

      values = columns.to_h { |key, col| [ key, number(row[col[:index]]).then { |n| n && col[:half] ? n * 2 : n } ] }
      return if values[@key].nil?

      { "name" => name, **values }
    end

    # "38", "38.5", "38,5", "38 ½", "38 1/2", "38-40" (the middle), "97cm".
    def number(text)
      text = text.to_s.tr(",", ".").gsub(/[½¼¾]/, "½" => ".5", "¼" => ".25", "¾" => ".75")
      text = text.gsub(%r{(\d+)\s+(\d)/(\d)}) { (Regexp.last_match(1).to_i + Regexp.last_match(2).to_f / Regexp.last_match(3).to_i).to_s }
      text = text.gsub(/(\d)\s+\.(\d)/, '\1.\2')
      if (range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/))
        return (range[1].to_f + range[2].to_f) / 2
      end

      text[/\d+(?:\.\d+)?/]&.to_f
    end

    def detect_unit(header, columns, body)
      labels = header.join(" ")
      values = body.flatten.join(" ")
      return "cm" if values.match?(/\d\s*cm\b/i)
      return "in" if values.match?(/\d\s*(?:"|”|in\b|inch)/i)
      return "cm" if labels.match?(/\bcm\b|centim/i)
      return "in" if labels.match?(/\binch|\(in\)|\bin\.|"/i)
      return "cm" if @context.match?(/\bcm\b|centim/i) && !@context.match?(/\binch/i)
      return "in" if @context.match?(/\binch/i) && !@context.match?(/\bcm\b/i)

      typical = body.filter_map { number(it[columns[@key][:index]]) }.sort[body.size / 2].to_f
      limit = @scheme[:inches_below] / (columns[@key][:half] ? 2.0 : 1)
      typical > limit ? "cm" : "in"
    end

    # Body charts usually give the chest (or waist) a garment is meant for, which matches its size number:
    # a US 40 jacket fits a 40 in chest, an EU 50 a 100 cm chest, a 32 trouser a 32 in waist.
    def detect_kind(sizes, unit)
      return "body" if @context.match?(BODY_WORDS)
      return "garment" if @context.match?(GARMENT_WORDS)

      matches = sizes.count do |size|
        label = size["name"][/\d+/]&.to_i
        next false unless label

        cm = to_cm(size[@key], unit)
        (cm - label * 2.54).abs <= 2.6 || (@key == "chest" && (cm - label * 2).abs <= 4)
      end
      matches >= sizes.size / 2.0 ? "body" : "garment"
    end

    def to_garment_cm(size, unit, kind)
      out = @columns.keys.each_with_object({ "name" => size["name"] }) do |key, sizes|
        cm = size[key] && to_cm(size[key], unit)
        cm += @scheme[:body_to_garment].fetch(key, 0) if cm && kind == "body"
        sizes[key] = cm&.round(2)
      end
      from_shoulder_seam(out)
    end

    # No sleeve is longer than 76 cm (30 in) from the shoulder seam; longer ones were measured from the
    # back of the neck, as resale shops and raglan sleeves often are. Take off half the shoulders.
    CENTRE_BACK_SLEEVE = 76

    def from_shoulder_seam(size)
      return size unless size["sleeve"] && size["sleeve"] > CENTRE_BACK_SLEEVE

      size.merge("sleeve" => (size["sleeve"] - (size["shoulders"] || 46) / 2.0).round(2))
    end

    def to_cm(value, unit) = unit == "in" ? value * 2.54 : value

    # A size conversion chart (S, M, L against US, UK, EU or IT sizes) has no measurements, but a men's US or
    # UK jacket size is the chest it fits in inches, and an Italian or French one is half of it in cm. Read
    # as a body chart of chests: kind "sizes".
    SIZE_SYSTEMS = [ [ /\A(US|UK)\b/i, 2.54 ], [ /\A(IT|FR)\b/i, 2.0 ] ].freeze

    def conversion
      return if @single || @key != "chest" || @rows.size < 3

      header, *body = @rows
      SIZE_SYSTEMS.each do |system, cm_per_size|
        column = header.index { it.match?(system) }
        next unless column&.positive?

        sizes = body.filter_map do |row|
          number = number(row[column]) or next
          chest = number * cm_per_size
          next unless chest.between?(76, 142)

          name = [ row.first, "#{header[column]} #{row[column]}" ].uniq.join(" / ").truncate(20, omission: "")
          to_garment_cm({ "name" => name, "chest" => chest }, "cm", "body")
        end
        return Chart.new(sizes:, unit: "in", kind: "sizes", missing: @columns.keys - [ "chest" ]) if sizes.size >= 3
      end
      nil
    end
  end
end
