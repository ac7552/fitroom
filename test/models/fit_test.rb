require "test_helper"

class FitTest < ActiveSupport::TestCase
  # A made-up 40R build: 40 in chest, 34 in waist, 5 ft 10 in.
  BODY = { "chest" => 101.6, "waist" => 86.4, "shoulders" => 45.5, "arm" => 65.5, "height" => 178 }.freeze

  setup { @sizes = SizeChart.find("sample_suit_jacket").sizes }

  def size(name) = @sizes.find { |s| s["name"] == name }

  test "a 40R body gets 40R in a regular cut, with nothing to fix" do
    best = Fit.rank(BODY, @sizes, "regular").first
    assert_equal "40R", best.size
    assert_equal "fits", best.verdict
    assert_equal 0, best.penalty
  end

  test "longer arms are a sleeve alteration, not a different size" do
    result = Fit.check_size(BODY.merge("arm" => 68.5), size("40R"))
    sleeve = result.checks.find { |c| c.part == "sleeve" }
    assert_equal "short", sleeve.status
    assert_equal "lengthen_sleeves", sleeve.fix.action
    assert_equal "alter", result.verdict
  end

  test "shoulders that are too narrow can't be fixed" do
    result = Fit.check_size(BODY, size("36R"))
    shoulders = result.checks.find { |c| c.part == "shoulders" }
    assert_equal "tight", shoulders.status
    assert_nil shoulders.fix
    assert_equal "compromise", result.verdict
  end

  test "a slim cut never picks a bigger size than regular" do
    assert_operator Fit.rank(BODY, @sizes, "slim").first.size.to_i, :<=, 40
  end

  test "a waist that's too loose is taken in, up to a limit" do
    roomy = Fit.check_size(BODY.merge("waist" => 81), size("40R"))
    assert_equal "take_in_waist", roomy.checks.find { |c| c.part == "waist" }.fix.action

    far_too_roomy = Fit.check_size(BODY.merge("waist" => 70), size("40R"))
    assert_nil far_too_roomy.checks.find { |c| c.part == "waist" }.fix
  end

  test "a coat gets room for a jacket underneath, and its length is described, not judged" do
    coat = { "name" => "L", "chest" => 101.6 + 18, "waist" => nil, "shoulders" => 46, "sleeve" => 64, "length" => 95 }
    result = Fit.check_size(BODY, coat, "regular", "coat")

    assert_equal "good", result.checks.find { it.part == "chest" }.status
    length = result.checks.find { it.part == "length" }
    assert_equal "good", length.status
    assert_equal "Ends just above the knee", length.note

    as_jacket = Fit.check_size(BODY, coat, "regular", "jacket")
    assert_equal "loose", as_jacket.checks.find { it.part == "chest" }.status
  end
end
