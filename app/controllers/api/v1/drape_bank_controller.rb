module Api
  module V1
    # Saves a drape bank entry (see app/javascript/lib/garments/drape_bank.js) under public/drapes/ and lists it
    # in public/drapes/index.json. For building the bank on a development machine only: the files are
    # committed and served as static files; in production this says no.
    class DrapeBankController < BaseController
      DIR = Rails.root.join("public/drapes")

      def create
        return head :not_found unless Rails.env.development?

        entry = params.require(:entry).permit!.to_h
        name = params[:name].to_s.gsub(/[^a-z0-9_-]/i, "-").presence || "entry"
        file = "#{name}.json"
        DIR.mkpath
        DIR.join(file).write(JSON.generate(entry))
        index = JSON.parse(DIR.join("index.json").read) rescue []
        index.reject! { it["file"] == file }
        index << { "file" => file, "style" => entry["style"], "bodyType" => entry["bodyType"], "panels" => entry["panels"], "measures" => entry["measures"], "name" => entry.dig("item", "name") }
        DIR.join("index.json").write(JSON.pretty_generate(index))
        render json: { file:, entries: index.size }
      end
    end
  end
end
