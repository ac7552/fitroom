module Api
  module V1
    # Reads a garment from a pasted product link ({ "url": ... }) or a pasted size chart ({ "text": ... }).
    # Nothing about the person asking is kept.
    class GarmentImportsController < BaseController
      def create
        garment =
          if params[:url].present? then GarmentImport.from_url(params[:url])
          elsif params[:text].present? then GarmentImport.from_text(params[:text].to_s.first(20_000), garment: params[:garment])
          else return render(json: { error: "invalid", message: "Send a url or the text of a size chart." }, status: :unprocessable_entity)
          end
        render json: { garment: }
      rescue GarmentImport::Error => e
        render json: { error: e.code, message: e.message }, status: :unprocessable_entity
      end
    end
  end
end
