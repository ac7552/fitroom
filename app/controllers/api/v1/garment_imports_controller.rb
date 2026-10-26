module Api
  module V1
    # Reads a garment from a pasted product link ({ "url": ... }, with "shop_data" when the person's browser
    # read a Shopify shop's product for it), a pasted size chart ({ "text": ... }), or what the page read from
    # a person's own photo ({ "photo_kind", "photo_style" }; the photo itself stays on their device).
    # Nothing about the person asking is kept.
    class GarmentImportsController < BaseController
      # A photo this big is more than any shop's product shot.
      PROXY_IMAGE_BYTES = 8_000_000
      # Raster images only: an SVG served from here could carry a script on this origin.
      PROXY_IMAGE_TYPES = %r{\Aimage/(?!svg)[a-z0-9.+-]+\z}

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

      # GET /api/v1/garment_imports/image?url=...: a shop's product photo passed through this server, so the
      # page can read its pixels when the shop's image server won't let a browser (no CORS header). The same
      # checks as reading a page: public web addresses only, an image, not too big, not too slow. Kept for an
      # hour by its address, and cacheable by the browser for as long. The address isn't logged beyond
      # Rails' own request line.
      def image
        url = params[:url].to_s
        bytes, type = Rails.cache.fetch("garment_import/image/#{Digest::SHA256.hexdigest(url)}", expires_in: 1.hour) do
          GarmentImport::Fetcher.get_image(url, max_bytes: PROXY_IMAGE_BYTES, types: PROXY_IMAGE_TYPES)
        end
        response.headers["Cache-Control"] = "public, max-age=3600"
        send_data bytes, type:, disposition: "inline"
      rescue GarmentImport::Fetcher::Error => e
        render json: { error: "fetch_failed", message: e.message }, status: :unprocessable_entity
      end
    end
  end
end
