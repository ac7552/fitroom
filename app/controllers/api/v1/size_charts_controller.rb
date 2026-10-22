module Api
  module V1
    class SizeChartsController < BaseController
      def index
        render json: { size_charts: SizeChart.all.map(&:summary) }
      end

      def show
        render json: SizeChart.find(params[:id])
      end
    end
  end
end
