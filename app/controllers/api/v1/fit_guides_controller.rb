module Api
  module V1
    # What a client needs to build the measurements form: what to ask for, and the cuts to offer.
    class FitGuidesController < BaseController
      def show
        render json: {
          units: "cm",
          measurements: Fit::MEASUREMENTS.map do |m|
            m.slice(:key, :label, :help).merge(optional: m[:optional] || false, min_cm: m[:range].min, max_cm: m[:range].max,
                                               usual_cm: range_json(m[:usual]))
          end,
          cuts: Fit::CUTS.map { |key, cut| { key:, label: cut[:label], chest_ease_cm: range_json(cut[:chest]), waist_ease_cm: range_json(cut[:waist]) } }
        }
      end

      private

      def range_json(range) = { min: range.min, max: range.max }
    end
  end
end
