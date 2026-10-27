module Api
  module V1
    # Ranks a garment's sizes (a jacket's, coat's or trousers') against a body: a stored chart (/size_charts/:key/fits) or sizes sent
    # in the request (/fits), such as an imported garment's. The measurements are used for this one
    # response and never kept: there's no model to save them in, they're filtered from the logs, and
    # the response says not to cache it.
    class FitsController < BaseController
      UNITS = { "cm" => 1, "in" => 2.54 }.freeze
      MAX_SIZES = 60

      def create
        chart = SizeChart.find(params[:size_chart_id]) if params[:size_chart_id]
        cut = params.fetch(:cut, "regular").to_s
        garment = params.fetch(:garment, "jacket").to_s
        unit = params.fetch(:unit, "cm").to_s

        errors = {}
        errors[:cut] = "must be one of #{Fit::CUTS.keys.join(', ')}" unless Fit::CUTS.key?(cut)
        errors[:unit] = "must be cm or in" unless UNITS.key?(unit)
        errors[:garment] = "must be one of #{GarmentImport::KINDS.join(', ')}" unless GarmentImport::KINDS.include?(garment)
        body = read_body(UNITS.fetch(unit, 1), errors)
        sizes = chart ? chart.sizes : read_sizes(garment, errors)
        return render(json: { error: "invalid", errors: }, status: :unprocessable_entity) if errors.any?

        response.headers["Cache-Control"] = "no-store"
        details = params[:details].respond_to?(:to_unsafe_h) ? params[:details].to_unsafe_h.slice("stretch", "sleeves", "fit", "women", "cropped", "snug", "dropped", "elastic", "hem", "ends") : {}
        results = Fit.rank(body, sizes, cut, garment, style: params[:style].to_s.presence, details:)
        render json: {
          size_chart: chart&.summary,
          cut:,
          garment:,
          units: "cm",
          best: results.first.size,
          warnings: Fit.warnings(body),
          sizes: results.map { |result| result_json(result) }
        }
      end

      private

      def read_body(scale, errors)
        given = params[:measurements].respond_to?(:[]) ? params[:measurements] : {}
        Fit::MEASUREMENTS.to_h do |m|
          value = Float(given[m[:key]], exception: false)
          cm = value && value * scale
          if cm.nil?
            errors[m[:key]] = "is required" unless m[:optional]
          elsif !m[:range].cover?(cm)
            errors[m[:key]] = "must be between #{m[:range].min} and #{m[:range].max} cm"
          end
          [ m[:key], cm ]
        end
      end

      # Sizes sent with the request, in centimetres. The garment's main measurement (chest, or waist for
      # trousers) is required; the rest can be missing.
      def read_sizes(garment, errors)
        keys = GarmentImport::ChartReader.measures(garment)
        keys += [ "hips" ] if garment == "top"   # a dress's
        required = keys.first
        given = params[:sizes]
        unless given.is_a?(Array) && given.size.between?(1, MAX_SIZES)
          errors[:sizes] = "must be a list of 1 to #{MAX_SIZES} sizes"
          return []
        end

        given.each_with_index.map do |size, index|
          size = size.respond_to?(:[]) ? size : {}
          name = size[:name].to_s.strip.first(20)
          errors[:"sizes.#{index}.name"] = "is required" if name.empty?
          keys.to_h do |key|
            value = size[key].nil? ? nil : Float(size[key], exception: false)
            errors[:"sizes.#{index}.#{key}"] = "must be a number" if value.nil? && !size[key].nil?
            errors[:"sizes.#{index}.#{key}"] = "must be between 5 and 250 cm" if value && !value.between?(5, 250)
            [ key, value ]
          end.merge("name" => name).tap do |out|
            errors[:"sizes.#{index}.#{required}"] ||= "is required" if out[required].nil?
          end
        end
      end

      def result_json(result)
        {
          size: result.size,
          verdict: result.verdict,
          penalty: result.penalty,
          checks: result.checks.map do |check|
            {
              part: check.part,
              label: check.label,
              ease_cm: check.ease,
              status: check.status,
              fixable: check.fixable?,
              note: check.note,
              fix: check.fix && { action: check.fix.action, text: check.fix.text, amount_cm: check.fix.amount }
            }
          end
        }
      end
    end
  end
end
