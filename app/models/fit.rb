# Fit math for jackets, coats and trousers. Everything is in centimetres.
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

  # Penalty per centimetre outside the target, plus a flat cost when no tailor can fix it.
  WEIGHT = { shoulders: 4, chest: 3, length: 2, waist: 1, sleeve: 0.5, trouser_waist: 2, seat: 2, inseam: 0.4 }.freeze
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

  def check_trousers(body, size, cut = "regular")
    checks = [
      given(size, "waist", "Waist") { range_check(:trouser_waist, "Waist", it - body["waist"], TROUSER_WAIST_EASE, shown_as: "waist") },
      given(size, "seat", "Seat") do |seat|
        next needs(:seat, "Seat", "hips") unless body["hips"]

        range_check(:seat, "Seat", seat - body["hips"], SEAT_EASE.fetch(cut))
      end,
      given(size, "inseam", "Length") do |inseam|
        next needs(:inseam, "Length", "inseam") unless body["inseam"]

        hem_check(inseam - (body["inseam"] - HEM_ABOVE_FLOOR))
      end,
      given(size, "leg_opening", "Leg") do |opening|
        style = LEG_OPENINGS.find { |limit, _| opening < limit }.last
        Check.new(part: "leg_opening", label: "Leg", ease: nil, status: "good", fix: nil, penalty: 0, note: "Cut with #{style}")
      end
    ]
    Result.new(size: size["name"], checks:, penalty: checks.sum(&:penalty).round(2))
  end

  # Every size, best first.
  def rank(body, sizes, cut = "regular", garment = "jacket")
    results = sizes.map do |size|
      garment == "trousers" ? check_trousers(body, size, cut) : check_size(body, size, cut, garment)
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
