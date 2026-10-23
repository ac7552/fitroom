class PagesController < ApplicationController
  def home
    @garment = SizeChart.find("sample_t_shirt").as_garment
    # What the women's mannequin wears to start with, in place of the T-shirt.
    @dress = SizeChart.find("sample_dress").as_garment
  end
end
