require "test_helper"

class ChartReaderTest < ActiveSupport::TestCase
  def read(rows, **options) = GarmentImport::ChartReader.read(rows, **options)

  test "a chart's sleeve is left as the shop gives it, and where it's measured from isn't guessed at" do
    chart = read([ %w[Size Chest Shoulders Sleeve Length], %w[M 54 46 63 70], %w[L 57 48 64 72] ], context: "garment measurements in cm")

    assert_nil chart.sleeve_from
    assert_equal [ 63.0, 64.0 ], chart.sizes.map { it["sleeve"] }
    assert_equal({ sizes: chart.sizes, unit: "cm", kind: "garment", missing: [ "waist" ] }, chart.as_json)
  end

  test "a sleeve column that says it runs from the centre back is marked so, whatever its length" do
    [ "Sleeve (from center back)", "CB Sleeve", "Sleeve from CB", "Centre back sleeve", "Sleeve length (C.B. to cuff)", "Sleeve from nape" ].each do |label|
      chart = read([ [ "Size", "Chest", "Shoulders", label, "Length" ], %w[M 54 46 44 70], %w[L 57 48 45 72] ], context: "cm")
      assert_equal "centre_back", chart.sleeve_from, label
      assert_equal 44.0, chart.sizes.first["sleeve"], "#{label}: the numbers are left for the import to convert"
    end
  end

  test "the words round a chart can say its sleeves run from the centre back, but a centre back length doesn't" do
    rows = [ %w[Size Chest Shoulders Sleeve Length], %w[M 54 46 83 70], %w[L 57 48 84 72] ]

    assert_equal "centre_back", read(rows, context: "Measurements in cm. Sleeves are measured from the centre back neck to the cuff.").sleeve_from
    assert_equal "centre_back", read(rows, context: "cm; center back to cuff sleeve measurement").sleeve_from
    assert_nil read(rows, context: "cm. Length is the centre back length, collar seam to hem.").sleeve_from
    assert_nil read([ %w[Size Chest Shoulders Sleeve], %w[M 54 46 63], %w[L 57 48 64] ], context: "Centre back length not given. cm").sleeve_from
  end
end
