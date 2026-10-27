module Api
  module V1
    # The AI picture: the page's own photo of the outfit with the shops' photos painted on (see TryOn.dress).
    # The page sends the picture, the figure's outline and each garment's shop photo; the answer is the new
    # picture and the checks it passed or failed. Nothing is kept.
    class TryOnsController < BaseController
      def create
        unless TryOn.available?
          return render(json: { error: "unavailable", message: "The AI picture needs the try-on service set up on the server." },
                        status: :service_unavailable)
        end

        response.headers["Cache-Control"] = "no-store"
        given = params.permit(:photo, :outline, items: %i[kind photo])
        render json: TryOn.dress(photo: given[:photo], outline: given[:outline], items: Array(given[:items]).map(&:to_h))
      rescue TryOn::Invalid => e
        render json: { error: "invalid", field: e.message }, status: :unprocessable_entity
      rescue TryOn::Error, KeyError => e
        Rails.logger.error("[try-on] #{e.class}")
        render json: { error: "failed", message: "The AI picture didn't work this time. Here's our own." }, status: :bad_gateway
      end

      # Someone added clothes with a shop photo: wake the service's GPU now, so it's up when they ask.
      def warm
        render json: { warming: TryOn.warm.present? }, status: :accepted
      end
    end
  end
end
