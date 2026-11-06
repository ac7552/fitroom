# Fit for footwear. Everything in centimetres.
#
# A shoe fits by its last: the length inside it, and its width at the ball. Shops give sizes on a scale (US,
# UK, EU, or centimetres on some Japanese and running-shoe charts), and sometimes a width (D, 2E, N, W). The
# scales are fixed lengths (a US men's size is a third of an inch, a UK size the same with a different start,
# an EU size two thirds of a centimetre); what varies by brand is how much shorter the inside of the shoe is
# than the scale says, which the brands' own charts show (Nike runs about half a size shorter than New
# Balance at the same number). BRAND_OFFSETS has what's published; others take the scale as it is.
#
# The verdict for a size: toe room (the last's length less the foot's, which should be about a thumb's
# width, TOE_ROOM), and width at the ball against the last's width for the width code. Styles differ: a
# boot or a running shoe is cut with a little more room, a loafer or a pump must hold the heel, so less.
#
# Nothing here keeps the measurements it's given.
module Fit
  module Shoes
    # What to ask for.
    MEASUREMENTS = [
      { key: "foot", label: "Foot length", help: "Heel to the longest toe, standing on the foot.", range: 15..35, usual: 21..31,
        how: "standing on a sheet of paper, heel against a wall, mark the longest toe and measure to the wall" },
      { key: "ball", label: "Foot width", help: "Across the widest part of the foot, at the ball.", range: 6..14, usual: 8..11.5, optional: true,
        how: "standing, across the widest part of the foot where the toes join it" }
    ].freeze

    # Scales: internal length of the shoe in cm for a size number. US and UK sizes are a third of an inch
    # apart (0.8467 cm); EU sizes two thirds of a centimetre. The starts are the usual last tables: a US
    # men's 9 is a 27 cm foot, a US women's 9 is a 25.5 cm (women's numbering runs about 1.5 ahead of
    # men's), a UK 8 is a 27 cm, an EU 42 a 27 cm.
    THIRD_INCH = 2.54 / 3
    SCALES = {
      "us_m" => ->(n) { 27.0 + (n - 9) * THIRD_INCH },
      "us_w" => ->(n) { 25.5 + (n - 9) * THIRD_INCH },
      "uk" => ->(n) { 27.0 + (n - 8) * THIRD_INCH },
      "eu" => ->(n) { 27.0 + (n - 42) * (2.0 / 3) },
      "cm" => ->(n) { n.to_f },
      "mm" => ->(n) { n / 10.0 }
    }.freeze

    # How much shorter than the scale a brand's lasts run (cm), from the brands' published size-to-foot
    # tables. Positive: the brand says a given size is for a shorter foot than the plain scale (it runs
    # small). Nike's chart puts a US men's 9 at 27 cm, adidas at 27 cm, New Balance at 27 cm, Converse
    # (which runs long) at 27.5 for a 9; their lasts differ more than their charts admit, which fit guides
    # say in words ("runs half a size small"): these offsets are those words.
    BRAND_OFFSETS = {
      /nike|jordan/i => 0.4,
      /converse/i => -0.5,
      /vans/i => 0.0,
      /adidas|yeezy/i => 0.2,
      /new balance/i => 0.0,
      /asics/i => 0.3,
      /salomon/i => 0.3,
      /hoka/i => 0.0,
      /on running|\bon\b cloud/i => 0.2,
      /dr\.? ?martens/i => -0.6,
      /birkenstock/i => 0.0,
      /clarks/i => 0.0,
      /timberland/i => -0.3,
      /ugg/i => -0.4
    }.freeze

    # Width at the ball of the last (cm) for a US men's 9 (27 cm) by width code, from the Brannock scale: a
    # D is 9.6 cm, each step a quarter inch narrower or wider. Scaled with the length (a bigger shoe is wider
    # in proportion, about 0.35 cm a size). Women's codes: B is medium.
    WIDTHS = { "4A" => 8.3, "3A" => 8.6, "2A" => 8.9, "A" => 9.2, "B" => 9.4, "C" => 9.5, "D" => 9.6, "E" => 9.9, "2E" => 10.3, "3E" => 10.6, "4E" => 10.9, "6E" => 11.5 }.freeze
    WIDTH_WORDS = { /extra[- ]wide|\b4E\b|\bEEEE\b|\bXW\b/i => "4E", /\bwide\b|\bW\b|\b2E\b|\bEE\b/i => "2E", /\bnarrow\b|\bN\b/i => "B", /\bmedium\b|\bregular\b|\bstandard\b|\bD\b|\bM\b/i => "D" }.freeze
    WIDTH_PER_CM = 0.35 / THIRD_INCH   # cm of width per cm of length, along a size run

    # Toe room (cm, the last's length less the foot's) that fits, by style: a running shoe needs a thumb's
    # width, a boot a little more (thick socks, the foot sliding on a slope), a dress shoe, a loafer or a
    # pump less (they're meant to hold the foot, and a long loafer slips at the heel).
    TOE_ROOM = {
      "sneaker" => 1.0..1.8, "hightop" => 1.0..1.8, "runner" => 1.2..2.0,
      "boot" => 1.2..2.2, "loafer" => 0.6..1.3, "heel" => 0.4..1.1, "sandal" => 0.3..1.2, "flat" => 0.5..1.2
    }.freeze
    DEFAULT_TOE_ROOM = 0.8..1.6
    # Width: the last may be this much narrower than the foot (the upper gives, more in knit and canvas than
    # in leather) or this much wider, and fit.
    WIDTH_EASE = { "leather" => -0.3..0.8, "suede" => -0.4..0.8, "canvas" => -0.6..0.9, "knit" => -0.9..1.0, "mesh" => -0.8..1.0 }.freeze
    DEFAULT_WIDTH_EASE = -0.5..0.9

    # Penalty per cm off, and how much a half size either way costs against one that fits.
    WEIGHT = { toe: 3.0, width: 2.0 }.freeze

    # As Fit's: a shoe can't be altered, so a check is fixable only when it's good, and a size fits or is a
    # compromise.
    Check = Struct.new(:part, :label, :ease, :status, :penalty, :note, keyword_init: true) do
      def fixable? = status == "good"
      def fix = nil
      def good = nil
    end
    Result = Struct.new(:size, :checks, :penalty, keyword_init: true) do
      def verdict = checks.all? { |c| c.status == "good" } ? "fits" : "compromise"
    end

    module_function

    # A size name ("9", "9.5", "US 9", "EU 42.5", "UK 8", "27 cm", "9 Wide", "9.5 (2E)") on a chart whose
    # scale is `scale` ("us_m", "us_w", "uk", "eu", "cm"), as { number, scale, width } or nil when it isn't
    # a size. A name that says its own scale ("EU 42") overrides the chart's.
    def parse_size(name, scale = "us_m")
      text = name.to_s.strip
      found = text.match(/\b(US|UK|EU|EUR|JP|CM|MM)\b\s*[:\-]?\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:\b(US|UK|EU|EUR|JP|CM|MM)\b)?/i)
      return nil unless found

      number = Float((found[2] || found[3]).tr(",", "."))
      said = (found[1] || found[4]).to_s.upcase
      own = { "UK" => "uk", "EU" => "eu", "EUR" => "eu", "JP" => "cm", "CM" => "cm", "MM" => "mm" }[said]
      # (The width from the rest of the name: "9 Wide", "9.5 (2E)", "10 W", "W" in "US W 8" meaning women's left alone.)
      rest = text.sub(found[0], " ")
      # (A leading W or M is the chart's gender, see scale_for, not a width.)
      rest = rest.sub(/\A\s*[WM]\b/i, " ")
      width = WIDTH_WORDS.find { |pattern, _| rest.match?(pattern) }&.last
      { number:, scale: own || scale, width: }
    end

    # The length inside the shoe for a parsed size (cm), for a brand.
    def last_length(size, brand = nil)
      scale = SCALES.fetch(size[:scale], SCALES["us_m"])
      offset = BRAND_OFFSETS.find { |pattern, _| brand.to_s.match?(pattern) }&.last || 0.0
      scale.call(size[:number]) - offset
    end

    # The width at the ball of the last (cm): by the width code (D when none), scaled with the length.
    def last_width(size, length, width_code = nil)
      code = width_code || size[:width] || (size[:scale] == "us_w" ? "B" : "D")
      base = WIDTHS.fetch(code, WIDTHS["D"])
      base + (length - 27.0) * WIDTH_PER_CM
    end

    # Every size, best first. foot: { "foot" => cm, "ball" => cm or nil }; sizes: [{ "name" }]; options:
    # scale (the chart's), brand, style (SHOE_STYLES'), fabric, width (a width code the listing gives).
    def rank(foot, sizes, scale: "us_m", brand: nil, style: nil, fabric: nil, width: nil)
      results = sizes.filter_map do |size|
        parsed = parse_size(size["name"], scale)
        next unless parsed

        check(foot, size["name"], parsed, brand:, style:, fabric:, width:)
      end
      results.sort_by(&:penalty)
    end

    def check(foot, name, parsed, brand: nil, style: nil, fabric: nil, width: nil)
      length = last_length(parsed, brand)
      room = length - foot["foot"].to_f
      want = TOE_ROOM.fetch(style.to_s, DEFAULT_TOE_ROOM)
      toe = range_check(:toe, "Length", room, want, WEIGHT[:toe],
        tight: "Toes touch the end", loose: "Heel will slip", fits: "About #{room.round(1)} cm in front of the toes")
      checks = [ toe ]
      if foot["ball"]
        ease = last_width(parsed, length, width) - foot["ball"].to_f
        want_w = WIDTH_EASE.fetch(fabric.to_s, DEFAULT_WIDTH_EASE)
        checks << range_check(:width, "Width", ease, want_w, WEIGHT[:width],
          tight: "Narrow across the ball", loose: "Roomy across the ball", fits: "Right across the ball")
      end
      # (Of two sizes that fit, the snugger: a tenth of a point per cm of room, which never outweighs a fault.)
      Result.new(size: name, checks:, penalty: (checks.sum(&:penalty) + (toe.status == "good" ? room * 0.1 : 0)).round(2))
    end

    def range_check(part, label, ease, want, weight, tight:, loose:, fits:)
      status, off = if ease < want.min then [ "tight", want.min - ease ]
                    elsif ease > want.max then [ "loose", ease - want.max ]
                    else [ "good", 0.0 ]
                    end
      note = status == "good" ? fits : status == "tight" ? tight : loose
      Check.new(part: part.to_s, label:, ease: ease.round(2), status:, penalty: (off * weight).round(2), note:)
    end

    # The scale a chart's size names are on, from the names and the listing: "EU 42" says EU; plain numbers
    # 35 to 50 are EU, 20 to 32 with a decimal are cm, 3 to 16 are US (women's when the listing is women's).
    def scale_for(names, women: false)
      sample = names.map(&:to_s)
      # Every size led by W (or M) is a women's (men's) chart, not a width.
      women = true if sample.size > 1 && sample.all? { |n| n.match?(/\A\s*W\b/i) }
      return "eu" if sample.any? { |n| n.match?(/\bEU\b|\bEUR\b/i) }
      return "uk" if sample.any? { |n| n.match?(/\bUK\b/i) }
      return "cm" if sample.any? { |n| n.match?(/\bcm\b|\bJP\b/i) }

      numbers = sample.filter_map { |n| n[/\d+(?:[.,]\d+)?/]&.tr(",", ".")&.then { |v| Float(v, exception: false) } }
      return women ? "us_w" : "us_m" if numbers.empty?

      median = numbers.sort[numbers.size / 2]
      if median >= 33 then "eu"
      elsif median >= 20 then "cm"
      else women ? "us_w" : "us_m"
      end
    end

    # Measurements outside the usual range, with how to measure again (as Fit.warnings).
    def warnings(foot)
      MEASUREMENTS.filter_map do |m|
        value = foot[m[:key]]
        next if value.nil? || m[:usual].cover?(value)

        way = value > m[:usual].max ? "larger" : "smaller"
        { measurement: m[:key], message: "#{m[:label]} of #{value} cm is #{way} than most. Check it: measure #{m[:how]}." }
      end
    end
  end
end
