module Api
  module V1
    # The studio look (see StudioLook): post the photo, its depth and its outline as PNG data: URLs, get the
    # repainted photo back in the same reply. Nothing is kept.
    class StudioLooksController < BaseController
      def create
        response.headers["Cache-Control"] = "no-store"
        return render(json: { error: "unavailable", message: "The studio look isn't set up on this server." }, status: :service_unavailable) unless StudioLook.available?

        image = StudioLook.call(photo: params[:photo], depth: params[:depth], mask: params[:mask], outfit: params[:outfit])
        if image
          render json: { image: }
        else
          render json: { error: "shape_changed", message: "The studio look changed the fit, so here's our own photo." }, status: :unprocessable_entity
        end
      rescue StudioLook::Invalid
        render json: { error: "invalid", message: "That photo couldn't be read." }, status: :unprocessable_entity
      rescue StudioLook::Error => e
        Rails.logger.error("[studio look] #{e.message}")
        render json: { error: "failed", message: "The studio look didn't work this time. Try again." }, status: :bad_gateway
      end
    end
  end
end
