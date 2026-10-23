class GarmentImport
  # How a dress is cut, read from its listing's name, category and description (shops describe dresses in a
  # few set phrases: "strapless", "thin straps", "form-fitting", "mini length", "75% nylon / 25% elastane"),
  # and the usual measurements of each women's size when the listing gives no chart.
  #
  # A cut: { sleeves:, neckline:, length:, fit:, stretch:, fabric:, printed:, details: }
  #   sleeves   "strapless", "one_shoulder", "thin_straps", "straps", "none" (sleeveless), "short" or "long"
  #   neckline  "straight", "scoop", "plunge", "round" or "high"
  #   length    "mini", "knee", "midi" or "maxi"
  #   fit       "fitted", "slim", "relaxed" or "flared"
  #   stretch   true when the cloth stretches (elastane, spandex, jersey), so it's made smaller than the body
  #   fabric    the cloth as the 3D view draws it: "stretch", "jersey", "leather", "silk" or "cotton"
  #   printed   true when the listing says the cloth is printed or patterned (only then is a print read off
  #             the photo; a dress's ties and pleats aren't a print)
  #   details   what the 3D view doesn't draw ("belt", "tie", "scarf", "cut-outs" ...), to say so
  module DressCut
    SLEEVES = [
      [ "strapless", /strapless|bandeau|\btube (?:dress|top)|off[- ]the[- ]shoulders?|off[- ]shoulder|corset bodice/i ],
      [ "one_shoulder", /one[- ]shoulder|single[- ]shoulder|asymmetric(?:al)? (?:neck|shoulder)/i ],
      [ "long", /long[- ]sleeves?|\bl\/s\b|full[- ]length sleeves?|bishop sleeves?|raglan sleeves?/i ],
      [ "short", /short[- ]sleeves?|cap sleeves?|puff sleeves?|t-?shirt dress|tee dress|flutter sleeves?/i ],
      [ "thin_straps", /spaghetti|thin straps?|skinny straps?|narrow straps?|slip dress|\bslip\b|cami\b|camisole|adjustable straps?/i ],
      [ "straps", /wide straps?|\bstraps?\b|halter|racer ?back|tank dress|\btank\b|square neck/i ],
      [ "none", /sleeveless/i ]
    ].freeze
    NECKLINES = [
      [ "plunge", /plung|deep[- ]v|v[- ]neck|\bv\b neck|wrap front/i ],
      [ "high", /high[- ]neck|mock[- ]neck|turtle ?neck|funnel neck|halter neck/i ],
      [ "scoop", /scoop|sweetheart|u[- ]neck|cowl/i ],
      [ "straight", /straight neck|square neck|boat ?neck|bateau|straight[- ]across/i ],
      [ "round", /crew ?neck|round neck|jewel neck/i ]
    ].freeze
    LENGTHS = [
      [ "maxi", /maxi|floor[- ]length|full[- ]length|\bgown|ankle[- ]length/i ],
      [ "midi", /midi|tea[- ]length|calf[- ]length|below the knee/i ],
      [ "mini", /\bmini\b|short dress|above the knee|micro/i ],
      [ "knee", /knee[- ]length/i ]
    ].freeze
    FITS = [
      [ "fitted", /form[- ]fitting|bodycon|body[- ]con|figure[- ]hugging|second[- ]skin|fitted|sculpted|corset|boning/i ],
      [ "flared", /a[- ]line|flare|skater|full skirt|tiered|swing|circle skirt|fit[- ]and[- ]flare/i ],
      [ "relaxed", /relaxed|loose|shift dress|oversized|boxy|easy fit/i ],
      [ "slim", /slim/i ]
    ].freeze
    STRETCH = /elastane|spandex|lycra|stretch|jersey|ribbed|rib[- ]knit|\bknit\b/i
    PRINTED = /print|pattern|floral|graphic|logo|stripe|check|plaid|gingham|polka|leopard|zebra|paisley|motif|parquet|camo|tie[- ]dye/i
    DETAILS = [
      [ "belt", /\bbelt/i ], [ "tie", /self[- ]tie|\btie\b|sash|bow\b/i ], [ "scarf", /scarf/i ],
      [ "cut-outs", /cut[- ]?outs?|open back|keyhole/i ], [ "ruffles", /ruffle|frill/i ], [ "sheer panels", /sheer/i ],
      [ "slit", /\bslit\b/i ], [ "draping", /drap(?:ed|ing)/i ], [ "uneven hem", /asymmetric(?:al)? hem|high[- ]low/i ],
      [ "faux fur", /faux fur|shearling/i ]
    ].freeze

    module_function

    # product: { name:, category:, description:, fabric: }
    def read(product)
      name = product.values_at(:name, :category).join(" ")
      words = [ name, product[:description], product[:fabric] ].join(" ")
      first = ->(rules, text) { rules.find { |_, pattern| text.to_s.match?(pattern) }&.first }
      sleeves = first.(SLEEVES, name) || first.(SLEEVES, words) || "none"
      stretch = words.match?(STRETCH)
      {
        sleeves:,
        neckline: first.(NECKLINES, words) || { "strapless" => "straight", "thin_straps" => "scoop", "straps" => "scoop",
                                                "one_shoulder" => "straight" }.fetch(sleeves, "round"),
        length: first.(LENGTHS, name) || first.(LENGTHS, words) || "knee",
        fit: first.(FITS, words) || (stretch ? "fitted" : "slim"),
        stretch:,
        fabric: fabric(words, stretch),
        printed: words.match?(PRINTED),
        details: DETAILS.filter_map { |detail, pattern| detail if words.match?(pattern) }
      }
    end

    def fabric(words, stretch)
      return "leather" if words.match?(/leather|\bpu\b|polyurethane|vinyl|latex/i)
      return "silk" if words.match?(/silk|satin|chiffon|charmeuse|organza|georgette|crepe de chine/i)
      # Smooth, slippery cloths that hang like silk: a nylon slip, a sequinned or viscose dress.
      return "silk" if !stretch && words.match?(/\bnylon\b|viscose|rayon|cupro|sequin/i)
      return "stretch" if stretch && !words.match?(/\bknit\b|jersey|ribbed|rib[- ]knit/i)
      return "jersey" if stretch

      "cotton"
    end

    # The body (cm) each women's size is for: [bust, waist, hips].
    LETTERS = {
      "XXS" => [ 78, 60, 86 ], "XS" => [ 82, 64, 90 ], "S" => [ 87, 69, 95 ], "M" => [ 92, 74, 100 ], "L" => [ 98, 80, 106 ],
      "XL" => [ 104, 86, 112 ], "XXL" => [ 110, 92, 118 ], "XXXL" => [ 116, 98, 124 ], "4XL" => [ 122, 104, 130 ]
    }.freeze
    LETTER_NAMES = { "2XS" => "XXS", "2XL" => "XXL", "3XL" => "XXXL", "XXXXL" => "4XL" }.freeze
    # Some brands number their sizes 0 to 3 (or 4): XS to L (or XL).
    BRAND_NUMBERS = %w[XS S M L XL].freeze

    # A size's body, from its name: a letter size, a US dress size (00 to 24), or a brand's 0-3 number when
    # the sizes run 0 to 3 or 4. Nil when the name isn't any of these.
    def body_for(name, all_names = [])
      label = name.to_s.upcase.strip[/\A(\d?X*[SML]|XX?S|00|\d{1,2})\b/, 1] or return
      label = LETTER_NAMES.fetch(label, label)
      return LETTERS[label] if LETTERS.key?(label)

      numbers = all_names.filter_map { it.to_s.strip[/\A\d{1,2}\z/]&.to_i }
      n = label == "00" ? -2 : label.to_i
      return LETTERS[BRAND_NUMBERS[n]] if numbers.any? && numbers.max <= 4 && label != "00" && n < BRAND_NUMBERS.size

      # US dress sizes: a 0 is for about an 81 cm bust; each size up adds about 1.3 cm, then 1.9 cm from a 10.
      bust_in = n <= 10 ? 32 + n * 0.5 : 37 + (n - 10) * 0.75
      bust = (bust_in * 2.54).round(1)
      [ bust, (bust - 18).round(1), (bust + 8).round(1) ]
    end

    # How much bigger (cm) than the body each fit is made, or for a stretch cloth how much of the body it is.
    EASE = {
      "fitted" => [ 3, 3, 4 ], "slim" => [ 6, 6, 6 ], "relaxed" => [ 14, 16, 14 ], "flared" => [ 6, 6, 30 ]
    }.freeze
    STRETCH_SHARE = 0.95
    # Length from the shoulder's high point (or, strapless, from the top edge) at size M, cm.
    LENGTHS_CM = { "mini" => 80, "knee" => 95, "midi" => 112, "maxi" => 140 }.freeze
    STRAPLESS_TOP = 18   # a strapless dress starts this far below where a strap would

    # Every size's usual garment measurements, named as the shop names them (or XS to XL when it doesn't).
    def usual_sizes(cut, names = [])
      names = names.map(&:to_s).uniq.select { body_for(it, names) }
      names = %w[XS S M L XL] if names.empty?
      ordered = names.sort_by { body_for(it, names)[0] }
      sizes = ordered.each_with_index.map do |name, i|
        bust, waist, hips = body_for(name, names)
        chest, waist_g, hips_g =
          if cut[:stretch] && %w[fitted slim].include?(cut[:fit]) then [ bust, waist, hips ].map { (it * STRETCH_SHARE).round(1) }
          else [ bust, waist, hips ].zip(EASE.fetch(cut[:fit], EASE["slim"])).map { |b, e| (b + e).round(1) }
          end
        step = i - ordered.index { body_for(it, names)[0] >= LETTERS["M"][0] }.to_i
        length = LENGTHS_CM.fetch(cut[:length], 95) + step - (cut[:sleeves] == "strapless" ? STRAPLESS_TOP : 0)
        sleeve = { "long" => 59 + step * 0.5, "short" => 14 + step * 0.3 }[cut[:sleeves]]
        shoulders = %w[long short].include?(cut[:sleeves]) ? (37 + (bust - 92) * 0.2).round(1) : nil
        { "name" => name, "chest" => chest, "waist" => waist_g, "hips" => hips_g, "shoulders" => shoulders,
          "sleeve" => sleeve&.round(1), "length" => length.round(1) }
      end
      missing = %w[shoulders sleeve].select { |part| sizes.all? { it[part].nil? } }
      ChartReader::Chart.new(sizes:, unit: "cm", kind: "sizes", missing: missing - not_needed(cut))
    end

    # What a dress's chart needn't give: sleeves and shoulders when it has none.
    def not_needed(cut)
      %w[short long].include?(cut[:sleeves]) ? [] : %w[sleeve shoulders]
    end
  end
end
