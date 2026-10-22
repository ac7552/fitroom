class PagesController < ApplicationController
  def home
    @garment = SizeChart.find("sample_suit_jacket").as_garment
  end
end
