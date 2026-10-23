require "test_helper"

class SizeChartTest < ActiveSupport::TestCase
  test "every chart has every measurement for every size (a top's chest and length at least)" do
    SizeChart.all.each do |chart|
      assert chart.sizes.any?, "#{chart.key} has no sizes"
      needed = chart.garment == "top" ? %w[chest length] : SizeChart::MEASUREMENTS
      chart.sizes.each do |size|
        needed.each do |m|
          assert size[m].is_a?(Numeric) && size[m].positive?, "#{chart.key} #{size['name']} is missing #{m}"
        end
      end
    end
  end

  test "chest grows with the size number" do
    chart = SizeChart.find("sample_suit_jacket")
    regulars = chart.sizes.select { |s| s["name"].end_with?("R") }
    assert_equal regulars.sort_by { |s| s["name"].to_i }, regulars.sort_by { |s| s["chest"] }
  end

  test "rejects chart names that aren't plain words" do
    assert_raises(SizeChart::NotFound) { SizeChart.find("../secrets") }
  end
end
