Rails.application.routes.draw do
  root "pages#home"

  # The web page and the mobile app both use these. See docs/api.md.
  namespace :api do
    namespace :v1 do
      resource :fit_guide, only: :show
      resources :garment_imports, only: :create
      resources :fits, only: :create
      resources :studio_looks, only: :create
      resources :studio_photos, only: %i[create show] do
        get :image, on: :member
      end
      resources :size_charts, only: %i[index show] do
        resources :fits, only: :create
      end
    end
  end

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  get "up" => "rails/health#show", as: :rails_health_check
end
