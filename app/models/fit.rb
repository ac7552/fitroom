# Fit math for tops (T-shirts, shirts, sweatshirts), jackets, coats and trousers. Everything is in centimetres.
#
# Ease is the garment's measurement minus the body's. A jacket needs some ease to move in; how much
# depends on the cut. Parts a tailor can change (sleeves, waist) cost little when they're off; parts
# they can't (shoulders, chest, length) cost a lot.
#
# Nothing here keeps the measurements it's given: they come in with a request and are gone after it.
module Fit
  CUTS = {
    "slim"    => { label: "Slim",    chest: 6..10,  waist: 6..11 },
    "regular" => { label: "Regular", chest: 9..13,  waist: 10..15 },
    "classic" => { label: "Classic", chest: 12..17, waist: 14..20 }
  }.freeze

  # What to ask for: the range of answers the API accepts, the range most adults fall in (outside it, the
  # page asks whether it was measured right), and how to measure it. Hips and inseam are only needed for
  # trousers.
  MEASUREMENTS = [
    { key: "chest",     label: "Chest",     help: "Around the fullest part, under the arms.",        range: 60..200, usual: 80..135,
      how: "around the fullest part of the chest, under the arms, with the tape level" },
    { key: "waist",     label: "Waist",     help: "Around your middle, at the navel.",               range: 50..200, usual: 60..130,
      how: "around your middle at the navel, tape snug but not tight" },
    { key: "shoulders", label: "Shoulders", help: "Across the back, shoulder bone to shoulder bone.", range: 30..70, usual: 38..54,
      how: "straight across the back from one shoulder bone to the other, not around the arms" },
    { key: "arm",       label: "Arm",       help: "Shoulder bone to wrist bone, arm relaxed.",        range: 40..90, usual: 52..72,
      how: "from the shoulder bone to the wrist bone with the arm hanging" },
    { key: "height",    label: "Height",    help: "Standing, without shoes.",                         range: 130..230, usual: 150..205,
      how: "standing straight against a wall, without shoes" },
    { key: "hips",      label: "Hips",      help: "Around the fullest part of the seat. For trousers.", range: 60..200, usual: 82..135,
      optional: true, how: "around the fullest part of the seat, feet together" },
    { key: "inseam",    label: "Inseam",    help: "Crotch to floor, inside the leg. For trousers.",    range: 50..110, usual: 66..92,
      optional: true, how: "from the crotch down the inside of the leg to the floor, without shoes" }
  ].freeze

  # What a size chart gives for each size: finished garment measurements in centimetres.
  SIZE_MEASUREMENTS = %w[chest waist shoulders sleeve length].freeze
  TROUSER_MEASUREMENTS = %w[waist seat thigh inseam leg_opening].freeze

  # Leggings stretch over the body: made a little smaller than it, at the waist and the seat.
  LEGGINGS_WAIST_EASE = -12..1
  LEGGINGS_SEAT_EASE = { "slim" => -16..-4, "regular" => -14..-2, "classic" => -10..1 }.freeze
  # An elastic waist (joggers, sweatpants, pull-on pants) is made smaller than the body and stretches on, by
  # about 8% of the body's waist (some 6 to 7 cm); past that it's tight, and a tailor can't let it out. It
  # may be up to 6 cm bigger than the body, gathered in by its cord. Within that, the size that stretches
  # a little under halfway (a size's relaxed waist is made for the smallest body it fits) wins a tie.
  ELASTIC_STRETCH = 0.08
  ELASTIC_ROOM = 6
  ELASTIC_AIM = 0.4   # of the stretch
  ELASTIC_TIE = 0.1   # penalty per cm from the aim
  # The cloth under an elastic waist is gathered in, so pull-on pants are made this much fuller over the
  # seat than tailored ones, as their cut.
  GATHERED_SEAT = 8
  # The knee is about this share of the way down from the crotch to the floor.
  KNEE_SHARE = 0.47

  # Where a skirt ends, from the waist down: the knee is about this far below it, a little under a third of
  # the height (or the inseam's share, when given).
  def skirt_length(length, inseam, height)
    knee = inseam ? inseam * (1 - KNEE_SHARE) + height.to_f * 0.13 : height.to_f * 0.32
    above = (knee - length).round
    note = above >= 3 ? "Ends about #{above} cm above the knee" : above <= -3 ? "Ends about #{-above} cm below the knee" : "Ends at the knee"
    note = "Ends near the ankle" if length > knee + 25
    Check.new(part: "length", label: "Length", ease: (length - knee).round(1), status: "good", fix: nil, penalty: 0, note:)
  end

  # Where shorts end: above or at the knee, said in centimetres.
  def shorts_length(inseam, leg)
    above = (leg * KNEE_SHARE - inseam).round
    note = above >= 2 ? "Ends about #{above} cm above the knee" : above <= -2 ? "Ends about #{-above} cm below the knee" : "Ends at the knee"
    Check.new(part: "inseam", label: "Length", ease: (inseam - leg * KNEE_SHARE).round(1), status: "good", fix: nil, penalty: 0, note:)
  end

  # Trousers sit at the waist with a little room, need more over the seat (by cut), and break just above
  # the shoe: about 3 cm shorter than the inseam measured to the floor.
  TROUSER_WAIST_EASE = 0..3
  SEAT_EASE = { "slim" => 3..7, "regular" => 6..10, "classic" => 9..14 }.freeze
  # Pants made loose on purpose (baggy, wide-leg, pleated: the shop's words, see GarmentImport#bottoms_cut):
  # 20 cm or more over the seat is how they're meant to be, so the waist picks the size.
  LOOSE_SEAT_EASE = 8..34
  HEM_ABOVE_FLOOR = 3
  HEM_TOLERANCE = 1.5
  LEG_OPENINGS = [ [ 38, "a slim, tapered leg" ], [ 44, "a straight leg" ], [ Float::INFINITY, "a wide leg" ] ].freeze

  # Rules of thumb a tailor would use.
  SHOULDER_EASE = -0.75..1.5    # seam sits on the shoulder bone or just past it, give or take a tape measure's error
  SLEEVE_ABOVE_WRIST = 1.5      # sleeve ends ~1.5 cm above the wrist bone, showing shirt cuff
  SLEEVE_TOLERANCE = 1
  LENGTH_PER_HEIGHT = 0.43      # jacket back length is about 43% of height
  LENGTH_TOLERANCE = 2
  ALTERATIONS = {
    waist:  { loose: [ "take_in_waist", "Take in the waist", 5 ], tight: [ "let_out_waist", "Let out the waist", 2.5 ] },
    trouser_waist: { loose: [ "take_in_waist", "Take in the waist", 5 ], tight: [ "let_out_waist", "Let out the waist", 3 ] },
    # Through the centre back seam, which trousers are made with extra in for this.
    seat: { loose: [ "take_in_seat", "Take in the seat", 6 ] },
    inseam: { long: [ "shorten_hem", "Take up the hem", 15 ], short: [ "lengthen_hem", "Let down the hem", 4 ] },
    sleeve: { long: [ "shorten_sleeves", "Shorten the sleeves", 5 ], short: [ "lengthen_sleeves", "Lengthen the sleeves", 3 ] }
  }.freeze

  # A coat goes over a jacket, so it needs this much more room in the chest and waist. Its length is a
  # matter of style, so Fitroom says where it ends rather than calling it right or wrong.
  COAT_EXTRA_EASE = 7
  NECK_BASE_PER_HEIGHT = 0.835   # the collar seam sits at about 83.5% of height
  HEMLINES = [
    [ 0.47, "at the hip" ], [ 0.40, "at the seat" ], [ 0.34, "mid-thigh" ], [ 0.29, "just above the knee" ],
    [ 0.25, "at the knee" ], [ 0.19, "below the knee" ], [ 0.12, "mid-calf" ], [ 0.07, "low on the calf" ],
    [ 0.0, "at the ankle" ]
  ].freeze

  # Tops are worn closer or looser than tailoring, and how much is mostly style: these are the usual
  # ranges. Their shoulder seam may drop past the shoulder bone; their length is checked against where a
  # top usually ends (about 41% of height from the collar seam), with more leeway than a jacket's.
  TOP_CUTS = {
    "slim"    => { chest: 4..9,   waist: 4..10 },
    "regular" => { chest: 8..15,  waist: 8..18 },
    "classic" => { chest: 14..26, waist: 14..30 }
  }.freeze
  # A dress sits closer than a T-shirt.
  DRESS_CUTS = {
    "slim"    => { chest: 2..6,  waist: 2..7 },
    "regular" => { chest: 4..9,  waist: 4..11 },
    "classic" => { chest: 7..14, waist: 8..16 }
  }.freeze
  # A women's top sits closer than a men's.
  WOMEN_TOP_CUTS = {
    "slim"    => { chest: 0..6,   waist: 0..8 },
    "regular" => { chest: 3..10,  waist: 4..14 },
    "classic" => { chest: 8..18,  waist: 10..24 }
  }.freeze
  # A baby tee's stretchy knit is made about the size of the body, or a little smaller.
  SNUG_TOP_CUTS = {
    "slim"    => { chest: -7..1, waist: -6..4 },
    "regular" => { chest: -5..4, waist: -4..8 },
    "classic" => { chest: -2..8, waist: 0..12 }
  }.freeze
  SNUG_SHORT = 10   # and may end this much higher than a women's top usually does
  SNUG_SHOULDER_EASE = -5..3   # its shoulder seams sit a little in from the shoulder
  # A fitted knit (a "shrunken" sweater hoodie, a ribbed top): made a little smaller than the body, and
  # stretches on. Its chest as a share of the body's, by how close it's worn (regular: about -8 to +2 cm on
  # a 90 cm chest, aiming at about -4); the size nearest the aim wins a tie. Its shoulder seams sit on the
  # bone or up to 2 cm inside it; it may end at the waist (see SNUG_SHORT).
  FITTED_KNIT_SHARE = { "slim" => -0.12..-0.02, "regular" => -0.09..0.02, "classic" => -0.05..0.05 }.freeze
  FITTED_KNIT_AIM = { "slim" => -0.08, "regular" => -0.05, "classic" => -0.01 }.freeze
  FITTED_KNIT_SHOULDER_EASE = -2..2
  FITTED_KNIT_TIE = 0.2   # penalty per cm from the aim
  TOP_SHOULDER_EASE = -1..5
  TOP_LENGTH_PER_HEIGHT = 0.41
  TOP_LENGTH_TOLERANCE = 4
  # A women's top usually ends higher, at the top of the hip.
  WOMEN_TOP_LENGTH_PER_HEIGHT = 0.36
  SHORT_SLEEVE = 40   # a sleeve shorter than this (cm, from the shoulder seam) is a short sleeve

  # Penalty per centimetre outside the target, plus a flat cost when no tailor can fix it.
  WEIGHT = { shoulders: 4, chest: 3, length: 2, waist: 1, sleeve: 0.5, trouser_waist: 2, elastic_waist: 2, seat: 2, stretch_seat: 2,
             inseam: 0.4, hips: 2 }.freeze
  UNFIXABLE = 6

  Fix = Data.define(:action, :text, :amount)
  # status is "unknown" when the size chart doesn't give that measurement; ease is nil then.
  # note describes a measurement that has no right answer, such as where a coat's hem falls.
  # good is the range of ease that fits for the cut chosen (cm), so a result can show where this size falls in
  # it; nil when a check has no such range (a hem that only says where it ends).
  Check = Data.define(:part, :label, :ease, :status, :fix, :penalty, :note, :good) do
    def initialize(part:, label:, ease:, status:, fix:, penalty:, note: nil, good: nil) = super
    def fixable? = %w[good unknown].include?(status) || !fix.nil?
  end
  Result = Data.define(:size, :checks, :penalty) do
    # "fits" as it comes, "alter" with a tailor's help, or "compromise" when something can't be fixed.
    def verdict
      return "compromise" unless checks.all?(&:fixable?)
      checks.any?(&:fix) ? "alter" : "fits"
    end
  end

  module_function
  # Defined above, next to their numbers.
  module_function :skirt_length, :shorts_length

  # A women's jacket usually ends higher, at the top of the hip.
  WOMEN_JACKET_LENGTH_PER_HEIGHT = 0.37
  # Where a jacket made to end at the waist (cropped, a bomber, a track jacket) ends, by its length as a
  # share of the height: [share, words], the first it's under.
  WAIST_HEMLINES = [ [ 0.27, "Cropped. It ends above your waist." ], [ 0.32, "Made short. It ends at your waist." ],
                     [ 0.38, "Made short. It ends at the top of your hips." ], [ Float::INFINITY, "It ends at your hips." ] ].freeze

  # design: how its sizes are cut (see design), for a jacket. style: how it looks ("bomber"). details: { "women",
  # "cropped", "ends" => "waist" (made to end at the waist: a track jacket, a blouson) }.
  def check_size(body, size, cut = "regular", garment = "jacket", design = {}, style: nil, details: {})
    ranges = CUTS.fetch(cut)
    coat = garment == "coat"
    ranges = ranges.transform_values { it.is_a?(Range) ? (it.min + COAT_EXTRA_EASE)..(it.max + COAT_EXTRA_EASE) : it } if coat
    roomy, dropped = coat ? [ nil, false ] : design.to_h.values_at(:roomy, :dropped)
    women = flag?(details, "women")
    short_by_design = !coat && (flag?(details, "cropped") || details["ends"].to_s == "waist" || style == "bomber")
    checks = [
      given(size, "shoulders", "Shoulders") do |shoulders|
        next check(:shoulders, "Shoulders", shoulders - body["shoulders"], "good").with(note: "The shoulder seam is made to sit down the arm.") if dropped

        range_check(:shoulders, "Shoulders", shoulders - body["shoulders"], SHOULDER_EASE)
      end,
      given(size, "chest", "Chest") { roomy ? roomy_chest(it - body["chest"], roomy, cut) : range_check(:chest, "Chest", it - body["chest"], ranges[:chest]) },
      given(size, "waist", "Waist") { range_check(:waist, "Waist", it - body["waist"], roomy ? (ranges[:waist].min + roomy)..(ranges[:waist].max + roomy) : ranges[:waist]) },
      given(size, "sleeve", "Sleeves") { sleeve_check(it - (body["arm"] - SLEEVE_ABOVE_WRIST)) },
      given(size, "length", "Length") do |length|
        next coat_length(length, body["height"]) if coat

        diff = length - body["height"] * (women ? WOMEN_JACKET_LENGTH_PER_HEIGHT : LENGTH_PER_HEIGHT)
        next waist_length(length, diff, body["height"]) if short_by_design && diff.negative?
        if (roomy || dropped) && diff.negative? && diff >= -BOXY_SHORT
          next check(:length, "Length", diff, "good").with(note: "Made short and boxy. It ends at your hips.")
        end

        length_check(diff)
      end
    ]
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # A jacket made to end at the waist: where it ends, not right or wrong.
  def waist_length(length, diff, height)
    note = WAIST_HEMLINES.find { |share, _| length < height * share }.last
    Check.new(part: "length", label: "Length", ease: diff.round(2), status: "good", fix: nil, penalty: 0, note:)
  end

  # A chest made roomy on purpose (see design): judged against the room it's made with, the size nearest it
  # first.
  def roomy_chest(ease, roomy, cut)
    aim = roomy + ROOMY_CUT.fetch(cut)
    found = range_check(:chest, "Chest", ease, (aim + ROOMY_EASE.min)..(aim + ROOMY_EASE.max))
    found = found.with(penalty: (found.penalty + (ease - aim).abs * 0.05).round(2))
    found.status == "good" ? found.with(note: "Made to be big and loose. On you, it's loose the way it should be.") : found
  end

  def flag?(details, key) = [ true, "true" ].include?(details.to_h[key])

  # style: "shorts" (their length is where they end, not right or wrong), "leggings" (stretch, made smaller
  # than the body), or another (trousers, jeans, joggers).
  # details: { "elastic" => pull-on (an elastic or drawcord waist), "fit" => "loose" or "slim" (how the shop
  # says the pants are cut), "hem" => "unfinished" (sold long, to be hemmed) }.
  def check_trousers(body, size, cut = "regular", style: nil, details: {})
    stretch = style == "leggings"
    # Joggers, and pull-on pants with an elastic or drawcord waist.
    elastic = style == "joggers" || flag?(details, "elastic")
    made = style == "skirt" || stretch ? nil : details["fit"].to_s
    checks = [
      given(size, "waist", "Waist") do |waist|
        next range_check(:trouser_waist, "Waist", waist - body["waist"], stretch ? LEGGINGS_WAIST_EASE : TROUSER_WAIST_EASE, shown_as: "waist") unless elastic

        elastic_waist(waist - body["waist"], body["waist"])
      end,
      given(size, "seat", "Seat") do |seat|
        next needs(:seat, "Seat", "hips") unless body["hips"]
        next stretch_seat(seat - body["hips"], cut) if stretch

        range = made == "loose" ? LOOSE_SEAT_EASE : SEAT_EASE.fetch(made == "slim" ? "slim" : cut)
        range = range.min..(range.max + GATHERED_SEAT) if elastic && made != "loose"
        found = range_check(:seat, "Seat", seat - body["hips"], range)
        next found.with(note: "Cut loose over the seat, as it's meant to be") if found.status == "good" && made == "loose" && seat - body["hips"] > SEAT_EASE["classic"].max

        found
      end,
      (style == "skirt" ? given(size, "length", "Length") { skirt_length(it, body["inseam"], body["height"]) } : nil),
      (style == "skirt" ? nil : given(size, "inseam", "Length") do |inseam|
        next needs(:inseam, "Length", "inseam") unless body["inseam"]
        next shorts_length(inseam, body["inseam"]) if style == "shorts"
        next unhemmed(inseam, body["inseam"]) if details["hem"].to_s == "unfinished"

        hem_check(inseam - (body["inseam"] - HEM_ABOVE_FLOOR))
      end),
      (style == "skirt" ? nil : given(size, "leg_opening", "Leg") do |opening|
        leg = LEG_OPENINGS.find { |limit, _| opening < limit }.last
        Check.new(part: "leg_opening", label: "Leg", ease: nil, status: "good", fix: nil, penalty: 0, note: "Cut with #{leg}")
      end)
    ].compact
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # An elastic waist against the body's: within its stretch (see ELASTIC_STRETCH), the size nearest the aim
  # first.
  def elastic_waist(ease, waist)
    stretch = (waist * ELASTIC_STRETCH).round(1)
    found = range_check(:elastic_waist, "Waist", ease, -stretch..ELASTIC_ROOM, shown_as: "waist")
    found = found.with(penalty: (found.penalty + (ease + stretch * ELASTIC_AIM).abs * ELASTIC_TIE).round(2))
    found.status == "good" && ease.negative? ? found.with(note: "The elastic waist stretches to fit") : found
  end

  # Leggings' seat: made smaller than the body, it stretches on.
  def stretch_seat(ease, cut)
    found = range_check(:stretch_seat, "Seat", ease, LEGGINGS_SEAT_EASE.fetch(cut), shown_as: "seat")
    found.status == "good" ? found.with(note: "Stretches to fit close to the body") : found
  end

  # Pants sold long, to be hemmed to the wearer (see GarmentImport#unfinished_hem): their length is a note,
  # not a fault.
  def unhemmed(inseam, leg)
    hem = (leg - HEM_ABOVE_FLOOR).round
    Check.new(part: "inseam", label: "Length", ease: (inseam - hem).round(2), status: "good", fix: nil, penalty: 0,
              note: "Comes unhemmed. Have it hemmed to about #{hem} cm.")
  end

  # A stretch dress is made smaller than the body and stretches onto it: its chest, waist and hips as a share
  # of the body's, by how close it's worn.
  STRETCH_SHARE = { "slim" => -0.12..-0.03, "regular" => -0.09..0.01, "classic" => -0.05..0.05 }.freeze
  DRESS_HIPS = { "slim" => 2..6, "regular" => 3..10, "classic" => 6..16 }.freeze
  NO_SLEEVES = { "none" => "Sleeveless", "straps" => "Straps, no sleeves", "thin_straps" => "Thin straps, no sleeves",
                 "strapless" => "Strapless", "one_shoulder" => "One shoulder" }.freeze
  STRAPLESS_TOP = 18   # cm: a strapless dress's length is measured from its top edge, this far below the shoulder

  # A dress: bust, waist and hips (it sits on all three), sleeves and shoulders only when it has sleeves, and
  # its length as where it ends. A stretch dress may be smaller than the body; a flared one free at the hips.
  def check_dress(body, size, cut = "regular", details = {})
    stretch = details["stretch"] == true || details["stretch"].to_s == "true"
    sleeves = details["sleeves"].to_s
    flared = details["fit"].to_s == "flared"
    ranges = DRESS_CUTS.fetch(cut)
    around = lambda do |rule, label, value, own, plain|
      next needs(rule, label, rule.to_s) unless own

      range = if stretch then STRETCH_SHARE.fetch(cut).then { (own * it.min)..(own * it.max) }
              else plain
              end
      found = range_check(rule, label, value - own, range)
      stretch && found.status == "good" && value < own ? found.with(note: "Stretches to fit close to the body") : found
    end
    checks = [
      given(size, "chest", "Bust") { around.(:chest, "Bust", it, body["chest"], ranges[:chest]) },
      given(size, "waist", "Waist") { flared && !stretch ? range_check(:waist, "Waist", it - body["waist"], ranges[:waist]) : around.(:waist, "Waist", it, body["waist"], ranges[:waist]) },
      size["hips"] ? given(size, "hips", "Hips") { around.(:hips, "Hips", it, body["hips"], flared ? 2..80 : DRESS_HIPS.fetch(cut)) } : nil,
      *(NO_SLEEVES.key?(sleeves) ? [ Check.new(part: "sleeve", label: "Sleeves", ease: nil, status: "good", fix: nil, penalty: 0, note: NO_SLEEVES[sleeves]) ] : [
        given(size, "shoulders", "Shoulders") { range_check(:shoulders, "Shoulders", it - body["shoulders"], TOP_SHOULDER_EASE) },
        given(size, "sleeve", "Sleeves") do |sleeve|
          next Check.new(part: "sleeve", label: "Sleeves", ease: nil, status: "good", fix: nil, penalty: 0, note: "Short sleeves") if sleeve < SHORT_SLEEVE

          sleeve_check(sleeve - body["arm"])
        end
      ]),
      given(size, "length", "Length") { coat_length(it + (sleeves == "strapless" ? STRAPLESS_TOP : 0), body["height"]) }
    ].compact
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # Some tops are made roomy on purpose (oversized, boxy), often with a dropped shoulder: the seam sits
  # down the arm. Their chart is much bigger than the body each size is for, so they're judged against
  # how they're meant to be worn. The usual body for each letter size: [chest, shoulders] in cm.
  LETTER_BODY = { "XXS" => [ 81, 40 ], "XS" => [ 86, 41 ], "S" => [ 91, 43 ], "M" => [ 97, 45 ], "L" => [ 104, 47 ], "XL" => [ 112, 49 ],
                  "XXL" => [ 120, 51 ], "XXXL" => [ 128, 53 ] }.freeze
  # A women's (bust as GarmentImport::DressCut::LETTERS has it).
  WOMEN_LETTER_BODY = { "XXS" => [ 78, 36 ], "XS" => [ 82, 37 ], "S" => [ 87, 38 ], "M" => [ 92, 39.5 ], "L" => [ 98, 41 ],
                        "XL" => [ 104, 42.5 ], "XXL" => [ 110, 44 ], "XXXL" => [ 116, 45.5 ] }.freeze
  # Italian and French men's sizes (44 to 60) are half the chest they're made for, in cm; the shoulders
  # grow about 1 cm a size from 45 cm at a 48.
  NUMBERED = /\A(4[2-9]|5\d|6[0-2])\b/
  # This much more chest than its size's usual body (cm): made roomy. About a classic cut's most room (a men's
  # top's 26 cm, a women's 18); or any more than a regular cut's when the shop says it's oversized.
  ROOMY = 25
  ROOMY_WOMEN = 18
  OVERSIZED = { men: 15, women: 10 }.freeze
  DROPPED = 8         # this much wider shoulders than its size's usual body: a dropped shoulder
  ROOMY_CUT = { "slim" => -6, "regular" => 0, "classic" => 6 }.freeze   # Snug sizes down, Loose sizes up
  ROOMY_EASE = -5..7  # around the room it's made with
  BOXY_SHORT = 10     # a roomy top may be cut this much shorter than usual (boxy)

  # How a top's or a jacket's sizes are cut: { roomy: the extra chest it's made with (cm), or nil; dropped:
  # true/false }, from each size's chart against the body that size is for (a men's or women's letter size,
  # or an Italian number). details: "dropped" (its shop photo shows dropped shoulders, whatever its chart's
  # numbers say), "women", "fit" => "oversized" (the shop says it's oversized or boxy).
  def design(sizes, details = {})
    women = flag?(details, "women")
    # (Numbers that stop below 50 are more likely a shirt's collar.)
    italian = sizes.any? { it["name"].to_s.strip.match?(/\A(5\d|6[0-2])\b/) }
    known = sizes.filter_map { |size| (body = size_body(size["name"], women, numbered: italian)) && [ size, body ] }
    chest = known.filter_map { |size, (c, _)| size["chest"] && size["chest"] - c }.sort
    shoulders = known.filter_map { |size, (_, s)| size["shoulders"] && size["shoulders"] - s }.sort
    middle = chest[chest.size / 2]
    said = details.to_h["fit"].to_s == "oversized"
    roomy = middle && (middle >= (women ? ROOMY_WOMEN : ROOMY) || (said && middle > OVERSIZED.fetch(women ? :women : :men))) ? middle : nil
    { roomy:, dropped: flag?(details, "dropped") || (shoulders.any? && shoulders[shoulders.size / 2] >= DROPPED) }
  end

  # The usual body [chest, shoulders] a size is made for, from its name; nil when the name isn't a size
  # Fitroom knows.
  def size_body(name, women = false, numbered: true)
    label = name.to_s.upcase.strip
    letter = label[/\A(XXXL|3XL|XXL|2XL|XL|XXS|2XS|XS|S|M|L)\b/, 1]&.sub("3XL", "XXXL")&.sub("2XL", "XXL")&.sub("2XS", "XXS")
    return (women ? WOMEN_LETTER_BODY : LETTER_BODY)[letter] if letter
    return if women || !numbered || !(n = label[NUMBERED, 1])

    [ n.to_i * 2, 45 + (n.to_i - 48) / 2.0 ]
  end

  # A T-shirt, shirt, sweatshirt or other top. Short sleeves end on the upper arm, so they aren't checked
  # against the arm. design: how its sizes are cut (see design).
  # details: { "women" => a women's top (it ends higher), "cropped" => made to end above the waist,
  # "snug" => a baby tee (see SNUG_TOP_CUTS), "fit" => "fitted" with "stretch" => true: a fitted knit, made
  # the size of the body or smaller (see FITTED_KNIT_SHARE) }.
  def check_top(body, size, cut = "regular", design = {}, style: nil, details: {})
    women = details["women"] == true || details["women"].to_s == "true"
    cropped = details["cropped"] == true || details["cropped"].to_s == "true"
    snug = details["snug"] == true || details["snug"].to_s == "true"
    roomy, dropped = design.values_at(:roomy, :dropped)
    # A chart made roomy says more than a listing's "fitted" (a zip hoodie with "fitted cuffs" and a slim rib).
    knit = !roomy && details["fit"].to_s == "fitted" && (details["stretch"] == true || details["stretch"].to_s == "true")
    snug ||= knit
    ranges = (style == "dress" ? DRESS_CUTS : snug ? SNUG_TOP_CUTS : women ? WOMEN_TOP_CUTS : TOP_CUTS).fetch(cut)
    checks = [
      given(size, "shoulders", "Shoulders") do |shoulders|
        next check(:shoulders, "Shoulders", shoulders - body["shoulders"], "good").with(note: "The shoulder seam is made to sit down the arm.") if dropped

        range_check(:shoulders, "Shoulders", shoulders - body["shoulders"], knit ? FITTED_KNIT_SHOULDER_EASE : snug ? SNUG_SHOULDER_EASE : TOP_SHOULDER_EASE)
      end,
      given(size, "chest", "Chest") do |chest|
        if knit
          # A fitted knit stretches on: its chest a share of the body's, the size nearest the aim first.
          share = FITTED_KNIT_SHARE.fetch(cut)
          found = range_check(:chest, "Chest", chest - body["chest"], (body["chest"] * share.min)..(body["chest"] * share.max))
          found = found.with(penalty: (found.penalty + (chest - body["chest"] * (1 + FITTED_KNIT_AIM.fetch(cut))).abs * FITTED_KNIT_TIE).round(2))
          next found.status == "good" && chest < body["chest"] ? found.with(note: "A fitted knit: it stretches to fit close to the body.") : found
        end
        roomy ? roomy_chest(chest - body["chest"], roomy, cut) : range_check(:chest, "Chest", chest - body["chest"], ranges[:chest])
      end,
      given(size, "waist", "Waist") { range_check(:waist, "Waist", it - body["waist"], roomy ? (ranges[:waist].min + roomy)..(ranges[:waist].max + roomy) : ranges[:waist]) },
      given(size, "sleeve", "Sleeves") do |sleeve|
        next Check.new(part: "sleeve", label: "Sleeves", ease: nil, status: "good", fix: nil, penalty: 0, note: "Short sleeves") if sleeve < SHORT_SLEEVE

        # Long sleeves end at the wrist bone. A dropped shoulder's sleeve starts down the arm.
        start = dropped && size["shoulders"] ? (size["shoulders"] - body["shoulders"]) / 2.0 : 0
        sleeve_check(sleeve + start - body["arm"])
      end,
      given(size, "length", "Length") do |length|
        next coat_length(length, body["height"]) if style == "dress"
        diff = length - body["height"] * (women ? WOMEN_TOP_LENGTH_PER_HEIGHT : TOP_LENGTH_PER_HEIGHT)
        next check(:length, "Length", diff, "good").with(note: "Cropped. It's made to end above your waist.") if cropped
        if snug && diff.between?(-SNUG_SHORT, TOP_LENGTH_TOLERANCE)
          next check(:length, "Length", diff, "good").with(note: knit ? "Made short, to end near your waist." : "A baby tee: made short, to end near your waist.")
        end
        good = -TOP_LENGTH_TOLERANCE..TOP_LENGTH_TOLERANCE
        next check(:length, "Length", diff, "good", good:) if diff.abs <= TOP_LENGTH_TOLERANCE
        if (roomy || dropped) && diff.negative? && diff >= -BOXY_SHORT
          next check(:length, "Length", diff, "good").with(note: "Made short and boxy. It ends at your hips.")
        end

        check(:length, "Length", diff, diff.positive? ? "long" : "short", nil, (diff.abs - TOP_LENGTH_TOLERANCE) * WEIGHT[:length], good:)
      end
    ]
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # Every size, best first.
  # style: how a top is cut, when it changes what fits ("dress": its length is where it ends, not right or wrong).
  # details: a dress's cut ({ "stretch", "sleeves", "fit" }, see GarmentImport::DressCut), or how a top, jacket
  # or pants are made (see check_top, check_size, check_trousers).
  def rank(body, sizes, cut = "regular", garment = "jacket", style: nil, details: {})
    cuts = nil
    results = sizes.map do |size|
      case garment
      when "trousers" then check_trousers(body, size, cut, style:, details: details.to_h)
      when "top" then style == "dress" ? check_dress(body, size, cut, details.to_h) : check_top(body, size, cut, cuts ||= design(sizes, details.to_h), style:, details: details.to_h)
      when "jacket" then check_size(body, size, cut, garment, cuts ||= design(sizes, details.to_h), style:, details: details.to_h)
      else check_size(body, size, cut, garment, style:, details: details.to_h)
      end
    end
    results.sort_by(&:penalty)
  end

  # Measurements outside the range most adults fall in, with how to measure them again.
  def warnings(body)
    MEASUREMENTS.filter_map do |m|
      value = body[m[:key]]
      next if value.nil? || m[:usual].cover?(value)

      way = value > m[:usual].max ? "larger" : "smaller"
      { part: m[:key], message: "#{m[:label]} looks #{way} than most people's. Check it: measure #{m[:how]}." }
    end
  end

  def needs(part, label, measurement)
    Check.new(part: part.to_s, label:, ease: nil, status: "unknown", fix: nil, penalty: 0,
              note: "Add your #{measurement} to check this")
  end

  def hem_check(diff)
    good = -HEM_TOLERANCE..HEM_TOLERANCE
    return check(:inseam, "Length", diff, "good", good:) if diff.abs <= HEM_TOLERANCE

    altered(:inseam, "Length", diff, diff.positive? ? "long" : "short", diff.abs - HEM_TOLERANCE, good:)
  end

  def coat_length(length, height)
    hem = (height * NECK_BASE_PER_HEIGHT - length) / height
    where = HEMLINES.find { |share, _| hem >= share }&.last || HEMLINES.last.last
    Check.new(part: "length", label: "Length", ease: (length - height * LENGTH_PER_HEIGHT).round(2), status: "good",
              fix: nil, penalty: 0, note: "Ends #{where}")
  end

  def given(size, part, label)
    value = size[part]
    return Check.new(part:, label:, ease: nil, status: "unknown", fix: nil, penalty: 0) if value.nil?

    yield value
  end

  # rule: which weight and alterations apply; shown_as: the part name the API reports, when it differs.
  def range_check(rule, label, ease, range, shown_as: nil)
    return check(shown_as || rule, label, ease, "good", good: range) if range.cover?(ease)

    status = ease < range.min ? "tight" : "loose"
    off = ease < range.min ? range.min - ease : ease - range.max
    altered(rule, label, ease, status, off, shown_as:, good: range)
  end

  def sleeve_check(diff)
    good = -SLEEVE_TOLERANCE..SLEEVE_TOLERANCE
    return check(:sleeve, "Sleeves", diff, "good", good:) if diff.abs <= SLEEVE_TOLERANCE

    altered(:sleeve, "Sleeves", diff, diff.positive? ? "long" : "short", diff.abs, good:)
  end

  def length_check(diff)
    good = -LENGTH_TOLERANCE..LENGTH_TOLERANCE
    return check(:length, "Length", diff, "good", good:) if diff.abs <= LENGTH_TOLERANCE

    altered(:length, "Length", diff, diff.positive? ? "long" : "short", diff.abs - LENGTH_TOLERANCE, good:)
  end

  def altered(rule, label, ease, status, off, shown_as: nil, good: nil)
    action, text, limit = ALTERATIONS.dig(rule, status.to_sym)
    if action && off <= limit
      check(shown_as || rule, label, ease, status, Fix.new(action:, text:, amount: off.round(2)), off * WEIGHT[rule], good:)
    else
      check(shown_as || rule, label, ease, status, nil, off * WEIGHT[rule] + UNFIXABLE, good:)
    end
  end

  def check(part, label, ease, status, fix = nil, penalty = 0, good: nil)
    Check.new(part: part.to_s, label:, ease: ease.round(2), status:, fix:, penalty: penalty.round(2), good:)
  end
end
