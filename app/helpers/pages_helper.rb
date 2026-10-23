module PagesHelper
  # The measurements in the order the page asks for them, in short, plain words: what each is called and how
  # to take it. (Fit::MEASUREMENTS keeps the API's own wording.)
  PLAIN_MEASUREMENTS = {
    "height" => { label: "Height", tip: "Stand up straight, with no shoes on." },
    "chest" => { label: "Chest", tip: "Wrap the tape around your chest, under your arms." },
    "waist" => { label: "Waist", tip: "Wrap the tape around your middle, at your belly button." },
    "shoulders" => { label: "Shoulders", tip: "Measure across your back, from one shoulder bone to the other." },
    "arm" => { label: "Arm", tip: "Measure from your shoulder bone down to your wrist." },
    "hips" => { label: "Hips", tip: "Wrap the tape around the widest part of your bottom." },
    "inseam" => { label: "Leg", tip: "Measure from your crotch down to the floor, on the inside of your leg." }
  }.freeze

  def body_parts
    PLAIN_MEASUREMENTS.map { |key, words| Fit::MEASUREMENTS.find { it[:key] == key }.merge(words) }
  end

  # How snug clothes are cut, in the words the page uses for Fit::CUTS.
  FIT_CHOICES = { "slim" => "Snug", "regular" => "Regular", "classic" => "Loose" }.freeze

  def fit_choices = FIT_CHOICES
end
