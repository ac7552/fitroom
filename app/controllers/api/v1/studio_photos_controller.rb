module Api
  module V1
    # Photoreal renders of what's on screen (see StudioPhoto). Start one with a snapshot of the stage,
    # poll its status, then fetch each image once ("draped", and "exact" when try-on ran); nothing is
    # kept after that.
    class StudioPhotosController < BaseController
      def create
        id, exact = StudioPhoto.start(params.permit!.to_h.deep_symbolize_keys)
        render json: {
          id:, exact:, exact_available: StudioPhoto.exact_available?,
          status_url: api_v1_studio_photo_path(id),
          image_url: image_api_v1_studio_photo_path(id),
          exact_image_url: (image_api_v1_studio_photo_path(id, variant: "exact") if exact)
        }.compact, status: :accepted
      rescue StudioPhoto::Unavailable
        render json: { error: "unavailable", message: "Studio photos need Blender, which isn't installed on this server." },
               status: :service_unavailable
      rescue StudioPhoto::Invalid => e
        render json: { error: "invalid", errors: e.errors }, status: :unprocessable_entity
      end

      def show
        status = StudioPhoto.status(params[:id])
        return render(json: { error: "not_found" }, status: :not_found) unless status

        response.headers["Cache-Control"] = "no-store"
        render json: status
      end

      def image
        png = StudioPhoto.take_image(params[:id], params[:variant] == "exact" ? "exact" : "draped")
        return render(json: { error: "not_found" }, status: :not_found) unless png

        response.headers["Cache-Control"] = "no-store"
        send_data png, type: "image/png", disposition: "inline", filename: "fitroom-studio.png"
      end
    end
  end
end
