module Api
  module V1
    # Reads a garment from a pasted product link ({ "url": ... }, with "shop_data" when the person's browser
    # read a Shopify shop's product for it), a pasted size chart ({ "text": ... }), or what the page read from
    # a person's own photo ({ "photo_kind", "photo_style" }; the photo itself stays on their device).
    # Nothing about the person asking is kept.
    class GarmentImportsController < BaseController
      def create
        garment =
          if params[:url].present? then GarmentImport.from_url(params[:url], shop_data: request.request_parameters["shop_data"])
          elsif params[:text].present? then GarmentImport.from_text(params[:text].to_s.first(20_000), garment: params[:garment])
          elsif params[:photo_kind].present? then GarmentImport.from_photo(kind: params[:photo_kind], style: params[:photo_style])
          else return render(json: { error: "invalid", message: "Send a url or the text of a size chart." }, status: :unprocessable_entity)
          end
        render json: { garment: }
      rescue GarmentImport::Error => e
        render json: { error: e.code, message: e.message }, status: :unprocessable_entity
      end
    end
  end
end
