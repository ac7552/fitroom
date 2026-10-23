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
  TOP_SHOULDER_EASE = -1..5
  TOP_LENGTH_PER_HEIGHT = 0.41
  TOP_LENGTH_TOLERANCE = 4
  # A women's top usually ends higher, at the top of the hip.
  WOMEN_TOP_LENGTH_PER_HEIGHT = 0.36
  SHORT_SLEEVE = 40   # a sleeve shorter than this (cm, from the shoulder seam) is a short sleeve

  # Penalty per centimetre outside the target, plus a flat cost when no tailor can fix it.
  WEIGHT = { shoulders: 4, chest: 3, length: 2, waist: 1, sleeve: 0.5, trouser_waist: 2, seat: 2, inseam: 0.4, hips: 2 }.freeze
  UNFIXABLE = 6

  Fix = Data.define(:action, :text, :amount)
  # status is "unknown" when the size chart doesn't give that measurement; ease is nil then.
  # note describes a measurement that has no right answer, such as where a coat's hem falls.
  Check = Data.define(:part, :label, :ease, :status, :fix, :penalty, :note) do
    def initialize(part:, label:, ease:, status:, fix:, penalty:, note: nil) = super
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

  def check_size(body, size, cut = "regular", garment = "jacket")
    ranges = CUTS.fetch(cut)
    coat = garment == "coat"
    ranges = ranges.transform_values { it.is_a?(Range) ? (it.min + COAT_EXTRA_EASE)..(it.max + COAT_EXTRA_EASE) : it } if coat
    checks = [
      given(size, "shoulders", "Shoulders") { range_check(:shoulders, "Shoulders", it - body["shoulders"], SHOULDER_EASE) },
      given(size, "chest", "Chest") { range_check(:chest, "Chest", it - body["chest"], ranges[:chest]) },
      given(size, "waist", "Waist") { range_check(:waist, "Waist", it - body["waist"], ranges[:waist]) },
      given(size, "sleeve", "Sleeves") { sleeve_check(it - (body["arm"] - SLEEVE_ABOVE_WRIST)) },
      given(size, "length", "Length") do
        coat ? coat_length(it, body["height"]) : length_check(it - body["height"] * LENGTH_PER_HEIGHT)
      end
    ]
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # style: "shorts" (their length is where they end, not right or wrong), "leggings" (stretch, made smaller
  # than the body), or another (trousers, jeans, joggers).
  def check_trousers(body, size, cut = "regular", style: nil)
    stretch = style == "leggings"
    checks = [
      given(size, "waist", "Waist") { range_check(:trouser_waist, "Waist", it - body["waist"], stretch ? LEGGINGS_WAIST_EASE : TROUSER_WAIST_EASE, shown_as: "waist") },
      given(size, "seat", "Seat") do |seat|
        next needs(:seat, "Seat", "hips") unless body["hips"]

        range = stretch ? LEGGINGS_SEAT_EASE.fetch(cut) : SEAT_EASE.fetch(cut)
        found = range_check(:seat, "Seat", seat - body["hips"], range)
        stretch && found.status == "good" ? found.with(note: "Stretches to fit close to the body") : found
      end,
      (style == "skirt" ? given(size, "length", "Length") { skirt_length(it, body["inseam"], body["height"]) } : nil),
      (style == "skirt" ? nil : given(size, "inseam", "Length") do |inseam|
        next needs(:inseam, "Length", "inseam") unless body["inseam"]
        next shorts_length(inseam, body["inseam"]) if style == "shorts"

        hem_check(inseam - (body["inseam"] - HEM_ABOVE_FLOOR))
      end),
      (style == "skirt" ? nil : given(size, "leg_opening", "Leg") do |opening|
        leg = LEG_OPENINGS.find { |limit, _| opening < limit }.last
        Check.new(part: "leg_opening", label: "Leg", ease: nil, status: "good", fix: nil, penalty: 0, note: "Cut with #{leg}")
      end)
    ].compact
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
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
  LETTER_BODY = { "XS" => [ 86, 41 ], "S" => [ 91, 43 ], "M" => [ 97, 45 ], "L" => [ 104, 47 ], "XL" => [ 112, 49 ],
                  "XXL" => [ 120, 51 ], "XXXL" => [ 128, 53 ] }.freeze
  ROOMY = 30          # this much more chest than its size's usual body (cm): made roomy
  DROPPED = 8         # this much wider shoulders than its size's usual body: a dropped shoulder
  ROOMY_CUT = { "slim" => -6, "regular" => 0, "classic" => 6 }.freeze   # Snug sizes down, Loose sizes up
  ROOMY_EASE = -5..7  # around the room it's made with
  BOXY_SHORT = 10     # a roomy top may be cut this much shorter than usual (boxy)

  # How a top's sizes are cut: { roomy: the extra chest it's made with (cm), or nil; dropped: true/false }.
  # details "dropped": its shop photo shows dropped shoulders, whatever its chart's numbers say.
  def design(sizes, details = {})
    known = sizes.filter_map do |size|
      letter = size["name"].to_s.upcase[/\A(XXXL|3XL|XXL|2XL|XL|XS|S|M|L)\b/, 1]&.sub("3XL", "XXXL")&.sub("2XL", "XXL")
      [ size, LETTER_BODY[letter] ] if letter
    end
    chest = known.filter_map { |size, (c, _)| size["chest"] && size["chest"] - c }.sort
    shoulders = known.filter_map { |size, (_, s)| size["shoulders"] && size["shoulders"] - s }.sort
    roomy = chest.any? && chest[chest.size / 2] >= ROOMY ? chest[chest.size / 2] : nil
    photo = details["dropped"] == true || details["dropped"].to_s == "true"
    { roomy:, dropped: photo || (shoulders.any? && shoulders[shoulders.size / 2] >= DROPPED) }
  end

  # A T-shirt, shirt, sweatshirt or other top. Short sleeves end on the upper arm, so they aren't checked
  # against the arm. design: how its sizes are cut (see design).
  # details: { "women" => a women's top (it ends higher), "cropped" => made to end above the waist }.
  def check_top(body, size, cut = "regular", design = {}, style: nil, details: {})
    women = details["women"] == true || details["women"].to_s == "true"
    cropped = details["cropped"] == true || details["cropped"].to_s == "true"
    snug = details["snug"] == true || details["snug"].to_s == "true"
    ranges = (style == "dress" ? DRESS_CUTS : snug ? SNUG_TOP_CUTS : women ? WOMEN_TOP_CUTS : TOP_CUTS).fetch(cut)
    roomy, dropped = design.values_at(:roomy, :dropped)
    checks = [
      given(size, "shoulders", "Shoulders") do |shoulders|
        next check(:shoulders, "Shoulders", shoulders - body["shoulders"], "good").with(note: "The shoulder seam is made to sit down the arm.") if dropped

        range_check(:shoulders, "Shoulders", shoulders - body["shoulders"], snug ? SNUG_SHOULDER_EASE : TOP_SHOULDER_EASE)
      end,
      given(size, "chest", "Chest") do |chest|
        next range_check(:chest, "Chest", chest - body["chest"], ranges[:chest]) unless roomy

        aim = roomy + ROOMY_CUT.fetch(cut)
        found = range_check(:chest, "Chest", chest - body["chest"], (aim + ROOMY_EASE.min)..(aim + ROOMY_EASE.max))
        # The size nearest the room it's made with wins a tie.
        found = found.with(penalty: (found.penalty + (chest - body["chest"] - aim).abs * 0.05).round(2))
        found.status == "good" ? found.with(note: "Made to be big and loose. On you, it's loose the way it should be.") : found
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
          next check(:length, "Length", diff, "good").with(note: "A baby tee: made short, to end near your waist.")
        end
        next check(:length, "Length", diff, "good") if diff.abs <= TOP_LENGTH_TOLERANCE
        if (roomy || dropped) && diff.negative? && diff >= -BOXY_SHORT
          next check(:length, "Length", diff, "good").with(note: "Made short and boxy. It ends at your hips.")
        end

        check(:length, "Length", diff, diff.positive? ? "long" : "short", nil, (diff.abs - TOP_LENGTH_TOLERANCE) * WEIGHT[:length])
      end
    ]
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # Every size, best first.
  # style: how a top is cut, when it changes what fits ("dress": its length is where it ends, not right or wrong).
  # details: a dress's cut ({ "stretch", "sleeves", "fit" }, see GarmentImport::DressCut).
  def rank(body, sizes, cut = "regular", garment = "jacket", style: nil, details: {})
    cuts = nil
    results = sizes.map do |size|
      case garment
      when "trousers" then check_trousers(body, size, cut, style:)
      when "top" then style == "dress" ? check_dress(body, size, cut, details.to_h) : check_top(body, size, cut, cuts ||= design(sizes, details.to_h), style:, details: details.to_h)
      else check_size(body, size, cut, garment)
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
    return check(:inseam, "Length", diff, "good") if diff.abs <= HEM_TOLERANCE

    altered(:inseam, "Length", diff, diff.positive? ? "long" : "short", diff.abs - HEM_TOLERANCE)
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
    return check(shown_as || rule, label, ease, "good") if range.cover?(ease)

    status = ease < range.min ? "tight" : "loose"
    off = ease < range.min ? range.min - ease : ease - range.max
    altered(rule, label, ease, status, off, shown_as:)
  end

  def sleeve_check(diff)
    return check(:sleeve, "Sleeves", diff, "good") if diff.abs <= SLEEVE_TOLERANCE

    altered(:sleeve, "Sleeves", diff, diff.positive? ? "long" : "short", diff.abs)
  end

  def length_check(diff)
    return check(:length, "Length", diff, "good") if diff.abs <= LENGTH_TOLERANCE

    altered(:length, "Length", diff, diff.positive? ? "long" : "short", diff.abs - LENGTH_TOLERANCE)
  end

  def altered(rule, label, ease, status, off, shown_as: nil)
    action, text, limit = ALTERATIONS.dig(rule, status.to_sym)
    if action && off <= limit
      check(shown_as || rule, label, ease, status, Fix.new(action:, text:, amount: off.round(2)), off * WEIGHT[rule])
    else
      check(shown_as || rule, label, ease, status, nil, off * WEIGHT[rule] + UNFIXABLE)
    end
  end

  def check(part, label, ease, status, fix = nil, penalty = 0)
    Check.new(part: part.to_s, label:, ease: ease.round(2), status:, fix:, penalty: penalty.round(2))
  end
end
