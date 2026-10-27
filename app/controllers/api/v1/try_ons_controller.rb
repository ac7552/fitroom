module Api
  module V1
    # The AI picture: the page's own photo of the outfit with the shops' photos painted on (see TryOn.dress),
    # made as a job (TryOnJob) so no request waits on a GPU. The page sends the picture, the figure's outline
    # and each garment's shop photo and gets a job id at once; it then asks how the job is doing until the
    # new picture and its checks come back, or cancels it (Stop). Nothing is kept.
    class TryOnsController < BaseController
      before_action { response.headers["Cache-Control"] = "no-store" }

      def create
        unless TryOn.available?
          return render(json: { error: "unavailable", message: "The AI picture needs the try-on service set up on the server." },
                        status: :service_unavailable)
        end

        given = params.permit(:photo, :outline, items: %i[kind photo])
        job = TryOnJob.start(photo: given[:photo], outline: given[:outline], items: Array(given[:items]).map(&:to_h))
        render json: { job: }, status: :accepted
      rescue TryOn::Invalid => e
        render json: { error: "invalid", field: e.message }, status: :unprocessable_entity
      rescue TryOnJob::Busy
        render json: { error: "busy", message: "The AI is busy with other pictures. Try again in a minute." }, status: :too_many_requests
      end

      # {status: starting | painting | done | failed | cancelled, seconds, layer, layers}, and once done the
      # picture (null when every garment was refused) and its checks. A done job is handed over once.
      def show
        state = TryOnJob.status(params[:id].to_s)
        return render(json: { error: "not_found" }, status: :not_found) unless state

        render json: state
      end

      # Stop: the job ends here and its call on the service is cancelled.
      def destroy
        return render(json: { error: "not_found" }, status: :not_found) unless TryOnJob.cancel(params[:id].to_s)

        render json: { status: "cancelled" }
      end

      # Someone added clothes with a shop photo: wake the service's GPU now, so it's up when they ask.
      def warm
        render json: { warming: TryOn.warm.present? }, status: :accepted
      end
    end
  end
end
