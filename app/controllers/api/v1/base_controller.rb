module Api
  module V1
    # JSON for the web page and the mobile app. Stateless: no sessions, no cookies, no accounts.
    class BaseController < ActionController::API
      wrap_parameters false

      rescue_from SizeChart::NotFound do |error|
        render json: { error: "not_found", message: error.message }, status: :not_found
      end
    end
  end
end
