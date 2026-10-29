class PagesController < ApplicationController
  def home
    @garment = SizeChart.find("sample_t_shirt").as_garment
    # The sample T-shirt and dress, for the examples to try (the women's body swaps the one for the other).
    @dress = SizeChart.find("sample_dress").as_garment
  end
end
