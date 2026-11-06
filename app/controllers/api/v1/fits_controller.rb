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
        return create_shoes if params[:garment].to_s == "shoes"

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

      # Shoes: the foot's length (and width) against the sizes' scale (Fit::Shoes). measurements: { foot,
      # ball }; sizes: [{ name }]; scale, brand, style, fabric, width as the listing gives them.
      def create_shoes
        unit = params.fetch(:unit, "cm").to_s
        errors = {}
        errors[:unit] = "must be cm or in" unless UNITS.key?(unit)
        scale = UNITS.fetch(unit, 1)
        given = params[:measurements].respond_to?(:[]) ? params[:measurements] : {}
        foot = Fit::Shoes::MEASUREMENTS.to_h do |m|
          value = Float(given[m[:key]], exception: false)
          cm = value && value * scale
          if cm.nil?
            errors[m[:key]] = "is required" unless m[:optional]
          elsif !m[:range].cover?(cm)
            errors[m[:key]] = "must be between #{m[:range].min} and #{m[:range].max} cm"
          end
          [ m[:key], cm ]
        end
        sizes = params[:sizes]
        errors[:sizes] = "must be a list of 1 to #{MAX_SIZES} sizes" unless sizes.is_a?(Array) && sizes.size.between?(1, MAX_SIZES)
        return render(json: { error: "invalid", errors: }, status: :unprocessable_entity) if errors.any?

        names = sizes.map { |size| (size.respond_to?(:[]) ? size[:name] : size).to_s.strip.first(20) }.reject(&:empty?)
        women = ActiveModel::Type::Boolean.new.cast(params[:women])
        size_scale = Fit::Shoes::SCALES.key?(params[:scale].to_s) ? params[:scale].to_s : Fit::Shoes.scale_for(names, women:)
        response.headers["Cache-Control"] = "no-store"
        results = Fit::Shoes.rank(foot, names.map { { "name" => _1 } }, scale: size_scale, brand: params[:brand].to_s.presence,
                                  style: params[:style].to_s.presence, fabric: params[:fabric].to_s.presence, width: params[:width].to_s.presence)
        if results.empty?
          # No size names that are sizes ("One size"): shown for the look, as before.
          return render(json: { garment: "shoes", units: "cm", scale: size_scale, best: names.first, warnings: [], sizes: names.map { { size: _1, verdict: "fits", penalty: 0, checks: [] } } })
        end
        render json: {
          garment: "shoes", units: "cm", scale: size_scale, best: results.first.size,
          warnings: Fit::Shoes.warnings(foot),
          sizes: results.map { |result| result_json(result) }
        }
      end

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
            # (A micro short's inseam is an inch or two: only an inseam may be under 5 cm.)
            least = key == "inseam" ? 0 : 5
            errors[:"sizes.#{index}.#{key}"] = "must be between #{least} and 250 cm" if value && !value.between?(least, 250)
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
              good_cm: check.good && [ check.good.min.to_f.round(2), check.good.max.to_f.round(2) ],
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
