class GarmentImport
  # How a dress is cut, read from its listing's name, category and description (shops describe dresses in a
  # few set phrases: "strapless", "thin straps", "form-fitting", "mini length", "75% nylon / 25% elastane"),
  # and the usual measurements of each women's size when the listing gives no chart.
  #
  # A cut: { sleeves:, neckline:, length:, fit:, stretch:, fabric:, printed:, details: }
  #   sleeves   "strapless", "one_shoulder", "halter", "thin_straps", "straps", "none" (sleeveless), "short" or
  #             "long"
  #   neckline  "straight", "scoop", "plunge", "round" or "high"
  #   length    "mini", "knee", "midi" or "maxi"
  #   fit       "fitted", "slim", "relaxed" or "flared"
  #   hem_flare true when only the hem flares out ("flared hem", mermaid, trumpet): the body keeps its fit
  #   waist_flare true when the skirt widens all the way from the waist (an A-line or fit and flare, as its
  #             photo shows): it's cut flaring from the waist, not the hips
  #   shape     the shape its photo showed (widths over the chest's, heights over the length; see
  #             GarmentImport#photo_dress_shape): what the 3D view cuts it to
  #   collar    true for a shirt dress's collar ("classic collar", "point collar"): drawn with it and buttons
  #   stretch   true when the cloth stretches (elastane, spandex, jersey), so it's made smaller than the body
  #   fabric    the cloth as the 3D view draws it: "stretch", "jersey", "leather", "silk", "structured"
  #             (suiting, scuba, ponte, a boned bodice: stiff, so it skims the body and holds a flare out) or
  #             "cotton". Read by what most of it is: 8% silk doesn't make a silk dress, nor 5% polyurethane
  #             (an elastane) a leather one
  #   printed   true when the listing says the cloth is printed or patterned (only then is a print read off
  #             the photo; a dress's ties and pleats aren't a print)
  #   flounce   true for a gathered strip at the hem ("ruffled hem", "tiered", "flounce"): drawn on the hem
  #   slit      "side" (one, up the wearer's left) or "sides" (both) for a slit up the side seam; a front or
  #             back slit isn't drawn
  #   belt      "buckle" for a belt at the waist, "tie" for a tie belt or a sash: drawn round the waist
  #   details   what the 3D view doesn't draw ("tie", "cut-outs", "draping" ...), to say so
  module DressCut
    SLEEVES = [
      [ "strapless", /strapless|bandeau|\btube (?:dress|top)|off[- ]the[- ]shoulders?|off[- ]shoulder|corset bodice/i ],
      [ "one_shoulder", /one[- ]shoulder|single[- ]shoulder|asymmetric(?:al)? (?:neck|shoulder)/i ],
      [ "halter", /halter/i ],
      [ "long", /long[- ]sleeves?|\bl\/s\b|full[- ]length sleeves?|bishop sleeves?|raglan sleeves?|batwing|dolman|kimono sleeves?|\b[ck]aftan\b/i ],
      [ "short", /short[- ]sleeves?|cap sleeves?|puff sleeves?|t-?shirt dress|tee dress|flutter sleeves?|polo dress/i ],
      # Sleeves the listing only mentions in passing ("raw sleeve cuffs", "cold shoulder") are long ones.
      [ "long", /sleeve cuffs?|cold[- ]shoulder|cut[- ]?outs? (?:on|at) the shoulders?/i ],
      [ "thin_straps", /spaghetti|thin straps?|skinny straps?|narrow straps?|slip dress|\bslip\b|cami\b|camisole|adjustable straps?/i ],
      [ "straps", /wide straps?|\bstraps?\b|racer ?back|tank dress|\btank\b|square neck/i ],
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
    # A flare only at the hem (the body keeps its fit down to it), or on the sleeves: neither makes the dress
    # an A-line, so they're left out of reading its fit.
    HEM_FLARE = /flared? hem|flare (?:at|from) the (?:hem|knee)|mermaid|trumpet|fishtail/i
    SLEEVE_FLARE = /(?:flared?|bell|trumpet|wide) (?:sleeves?|cuffs?)/i
    SHIRT_COLLAR = /(?:classic|shirt|point|spread|button[- ]down|camp|pointed|polo) collar|\bcollared\b|\bpolo dress|(?<![\w-])shirt ?dress/i
    STRETCH = /elastane|spandex|lycra|stretch|jersey|ribbed|rib[- ]knit|\bknit(?:ted)?\b/i
    # Cloths that hold their shape: stiff to bend, whether they stretch or not.
    STRUCTURED = /suiting|scuba|ponte|neoprene|bonded|\bbon(?:ing|ed)\b|corset|structured|tweed|boucl[eé]|\bcrepe\b(?! de chine)/i
    # A hem with a strip gathered onto it: drawn as the body's shape, with the strip on (not as a flare).
    FLOUNCE = /ruffled? hem|ruffle (?:at|on) the hem|flounce|tiered|tiers\b|peplum hem/i
    # Slits up the side seams (both, or one), and a belt at the waist ("belt loops" aren't one).
    SIDE_SLITS = /side slits|slits (?:at|on|up) (?:the|both) sides|split sides|side splits/i
    SIDE_SLIT = /side slit|side split|slit (?:at|on|up) the side|thigh[- ]high slit|leg slit|high slit/i
    BELT = /\bbelt(?:ed)?\b(?! loops?)/i
    # (A "self-tie closure on the back" isn't a belt, nor a sash draped to the hip.)
    TIE_BELT = /tie belt|self[- ]tie belt|belt that ties|waist tie|ties? at the waist|sash (?:belt|at the waist|round the waist|around the waist)/i
    PRINTED = /print|pattern|floral|graphic|logo|stripe|check|plaid|gingham|polka|leopard|zebra|paisley|motif|parquet|camo|tie[- ]dye/i
    DETAILS = [
      [ "belt", /\bbelt(?:ed)?\b(?! loops?)/i ], [ "tie", /self[- ]tie|\btie\b|sash|bow\b/i ], [ "scarf", /scarf/i ],
      [ "cut-outs", /cut[- ]?outs?|open back|keyhole/i ], [ "ruffles", /ruffle|frill/i ], [ "sheer panels", /sheer/i ],
      [ "slit", /\bslit\b/i ], [ "draping", /drap(?:ed|ing)/i ], [ "uneven hem", /asymmetric(?:al)? hem|high[- ]low/i ],
      [ "faux fur", /faux fur|shearling/i ]
    ].freeze

    module_function

    # Where a dress is cut out ("cut-outs on the shoulder", "open back", "keyhole"), where it's see-through
    # ("sheer sleeves"; "semi sheer" alone means all of it), and where a scarf is attached ("on the side").
    CUTOUT_PLACES = { "shoulders" => /shoulders?/i, "back" => /back/i, "front" => /front|chest|bust|neck/i, "sides" => /sides?/i, "waist" => /waist|hips?|midriff/i }.freeze
    SHEER_PLACES = { "sleeves" => /sleeves?/i, "back" => /back/i, "sides" => /sides?|panels?/i, "skirt" => /skirt|hem|overlay/i }.freeze

    def cutouts(words)
      places = words.scan(/cut[- ]?outs?\s+(?:on|at|along|to|across)\s+(?:the\s+)?(\w+)/i).flatten.filter_map { |w| CUTOUT_PLACES.find { |_, p| w.match?(p) }&.first }
      places << "back" if words.match?(/open[- ]back|backless|low[- ]back|cut[- ]?out back/i)
      places << "front" if words.match?(/keyhole/i)
      places << "waist" if places.empty? && words.match?(/cut[- ]?outs?/i)
      places.uniq
    end

    # (Mesh inside it, a lining or a shelf bra's, doesn't make a dress see-through.)
    MESH_INSIDE = /(?:lined|lining)\s+(?:\w+\s+){0,3}(?:power\s+)?mesh|(?:power\s+)?mesh\s+(?:lining|lined|panels?|inserts?|bra)|power mesh/i
    def sheer(words)
      words = words.gsub(MESH_INSIDE, " ")
      return unless words.match?(/sheer|\bmesh\b|tulle/i)

      place = words[/sheer\s+(\w+)/i, 1]
      [ SHEER_PLACES.find { |_, p| place.to_s.match?(p) }&.first || "all", words.match?(/semi[- ]?sheer/i) ? "semi" : "sheer" ]
    end

    # product: { name:, category:, description:, fabric: }
    def read(product)
      name = product.values_at(:name, :category).join(" ")
      words = [ name, product[:description], product[:fabric] ].join(" ")
      first = ->(rules, text) { rules.find { |_, pattern| text.to_s.match?(pattern) }&.first }
      named_sleeves = first.(SLEEVES, name) || first.(SLEEVES, words)
      sleeves = named_sleeves || "none"
      shares = fibre_shares(product[:fabric].presence || product[:description])
      stretch = words.match?(STRETCH) || STRETCHY.sum { shares[it].to_f } >= 3
      cut = {
        sleeves:,
        neckline: first.(NECKLINES, words) || { "strapless" => "straight", "thin_straps" => "scoop", "straps" => "scoop",
                                                "one_shoulder" => "straight" }.fetch(sleeves, "round"),
        # Its own name first, then its description: a "Midi Skirt" Kith files under Maxi Skirts is a midi, and
        # so is a dress filed there whose description says "Mini length".
        length: first.(LENGTHS, product[:name]) || product[:description].to_s[/\b(mini|midi|maxi|knee)[- ]length\b/i, 1]&.downcase || first.(LENGTHS, name) ||
                first.(LENGTHS, words) || "knee",
        fit: first.(FITS, words.gsub(HEM_FLARE, " ").gsub(SLEEVE_FLARE, " ")) || (stretch ? "fitted" : "slim"),
        hem_flare: words.match?(HEM_FLARE),
        collar: words.match?(SHIRT_COLLAR),
        stretch:,
        fabric: fabric(words, stretch, shares),
        printed: words.match?(PRINTED),
        cutouts: cutouts(words),
        sheer: sheer(words)&.first,
        sheer_kind: sheer(words)&.last,
        scarf: words.match?(/scarf/i) ? (words.match?(/scarf\s+(?:on|at)\s+the\s+side|side scarf/i) ? "side" : "neck") : nil,
        flounce: words.match?(FLOUNCE),
        slit: if words.match?(SIDE_SLITS) then "sides" elsif words.match?(SIDE_SLIT) then "side" end,
        belt: if words.match?(TIE_BELT) then "tie" elsif words.match?(BELT) then "buckle" end
      }
      # What the 3D view doesn't draw (cut-outs, sheer parts and scarves it does; a flounce, a side slit and a
      # belt too: ruffles elsewhere, a front slit and a tie that isn't a belt it doesn't).
      drawn = %w[cut-outs sheer\ panels scarf]
      drawn << "ruffles" if cut[:flounce] && !words.gsub(FLOUNCE, " ").match?(/ruffle|frill/i)
      drawn << "slit" if cut[:slit]
      drawn << "belt" if cut[:belt]
      drawn << "tie" if cut[:belt] == "tie" && !words.gsub(TIE_BELT, " ").match?(DETAILS.to_h.fetch("tie"))
      cut[:details] = DETAILS.filter_map { |detail, pattern| detail if words.match?(pattern) && !drawn.include?(detail) }
      shape = product[:dress_shape]
      shape ? with_photo(cut, shape, words, named_sleeves) : cut
    end

    # The cut, its shape from its photo where the photo is clear (the words still give its cloth, its back and
    # what's on it). The Desma's "Form-fitting silhouette" flares from its waist in its photo; a Dalters
    # whose words never say "sleeves" has them in its photo; a halter's straps meet at the neck.
    def with_photo(cut, shape, words, named_sleeves)
      cut = cut.dup
      # (Not over sleeves the words name: a "short sleeve" polo dress's collar is narrow at the top too.)
      if shape[:halter] && !%w[strapless one_shoulder long short].include?(named_sleeves) then cut[:sleeves] = "halter"
      elsif shape[:strapless] && named_sleeves.nil? then cut[:sleeves] = "strapless"
      elsif shape[:sleeves] && (named_sleeves.nil? || cut[:sleeves] == "none") then cut[:sleeves] = shape[:sleeves]
      end
      return cut unless shape[:hem] && shape[:waist]

      flounce = words.match?(FLOUNCE)
      hem = flounce ? [ shape[:hips] || shape[:hem], shape[:hem] ].min : shape[:hem]
      case flounce ? nil : shape[:flare_from]
      when "waist"
        if hem >= 1.2
          cut[:fit] = "flared"
          cut[:waist_flare] = true
        end
      when "hips" then cut[:fit] = "flared" if hem >= 1.3
      when "knee" then cut[:hem_flare] = true
      else
        # Straight in its photo, whatever the words say about a flare.
        cut[:fit] = cut[:stretch] ? "fitted" : "slim" if cut[:fit] == "flared" && hem < 1.15
      end
      cut[:shape] = { waist: shape[:waist], waist_at: shape[:waist_at], hips: shape[:hips], hem: hem.round(3),
                      neck_depth: shape[:neck_depth], neck_width: shape[:neck_width] }.compact
      cut
    end

    # A material line's fibres and their shares ("77% Viscose / 15% Nylon / 8% Silk" is { "viscose" => 77,
    # "nylon" => 15, "silk" => 8 }), from its first part only: a contrast cloth, a lining or a trim after it
    # isn't what most of the garment is.
    FIBRES = { "elastane" => /elastane|spandex|lycra/i, "polyurethane" => /polyurethane|\bpu\b/i, "silk" => /silk/i,
               "viscose" => /viscose|rayon|modal|lyocell|tencel|cupro/i, "nylon" => /nylon|polyamide/i, "polyester" => /polyester/i,
               "cotton" => /cotton/i, "wool" => /wool|cashmere|merino|alpaca|mohair/i, "linen" => /linen/i, "acrylic" => /acrylic/i }.freeze
    STRETCHY = %w[elastane polyurethane].freeze

    def fibre_shares(text)
      main = text.to_s.split(/\b(?:contrast|lining|trim|body 2|rib(?:bing)?|panel|embroidery|pocketing)\b/i).first.to_s
      main.scan(/(\d{1,3}(?:\.\d+)?)\s*%\s*([a-z][a-z ]*)/i).each_with_object({}) do |(share, fibre), out|
        key = FIBRES.find { |_, pattern| fibre.match?(pattern) }&.first or next
        out[key] = out[key].to_f + share.to_f
      end
    end

    def fabric(words, stretch, shares = {})
      leather = words.match?(/leather|vinyl|latex|pleather/i) || shares["polyurethane"].to_f >= 50 ||
                (shares.empty? && words.match?(/\bpu\b|polyurethane/i))
      return "leather" if leather
      return "structured" if words.match?(STRUCTURED)
      return "silk" if words.match?(/satin|chiffon|charmeuse|organza|georgette|crepe de chine/i)
      return "silk" if shares.any? ? shares["silk"].to_f >= 30 : words.match?(/silk/i)
      # Smooth, slippery cloths that hang like silk: a nylon slip, a sequinned or viscose dress.
      return "silk" if !stretch && words.match?(/\bnylon\b|viscose|rayon|cupro|lyocell|tencel|modal|sequin|slip dress/i)
      return "stretch" if stretch && !words.match?(/\bknit(?:ted)?\b|jersey|ribbed|rib[- ]knit/i)
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
      "fitted" => [ 3, 3, 4 ], "slim" => [ 6, 6, 6 ], "relaxed" => [ 14, 16, 14 ], "flared" => [ 6, 6, 14 ]
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
