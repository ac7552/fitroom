require "net/http"

# Paints a shop's garment onto a studio render with FASHN's virtual try-on API, so the photo shows the exact
# item (its collar, pockets, wash) rather than Fitroom's stand-in garment. The fit stays Fitroom's: the
# render underneath is draped to the measured size, and the verdict is the measured one.
#
# Only runs when the server has FASHN_API_KEY and the person ticked the box. Images go inline and come back
# inline: FASHN deletes inline inputs when the request finishes, expires inline outputs after an hour, and
# doesn't train on them (https://docs.fashn.ai/api-overview/data-retention-privacy). Nothing is written here.
class TryOn
  class Error < StandardError; end

  BASE = "https://api.fashn.ai/v1"
  CATEGORIES = { "jacket" => "tops", "coat" => "tops", "trousers" => "bottoms" }.freeze
  TIMEOUT = 150 # seconds

  def self.available? = ENV["FASHN_API_KEY"].present?

  # model_png: the render (PNG bytes). garment: the shop's photo as a data: URL. Returns PNG bytes.
  def self.call(model_png, garment, kind)
    id = post("run", {
      model_name: "tryon-v1.6",
      inputs: {
        model_image: "data:image/png;base64,#{Base64.strict_encode64(model_png)}",
        garment_image: garment,
        category: CATEGORIES.fetch(kind),
        mode: "quality",
        output_format: "png",
        return_base64: true
      }
    }).fetch("id")

    deadline = Time.current + TIMEOUT
    loop do
      raise Error, "try-on took too long" if Time.current > deadline

      sleep 2
      status = get("status/#{id}")
      case status["status"]
      when "completed" then return Base64.decode64(status.fetch("output").first.split(",", 2).last)
      when "failed" then raise Error, "try-on failed"
      end
    end
  end

  def self.post(path, body)
    request(Net::HTTP::Post.new(URI("#{BASE}/#{path}")).tap { it.body = JSON.generate(body) })
  end

  def self.get(path) = request(Net::HTTP::Get.new(URI("#{BASE}/#{path}")))

  def self.request(request)
    request["Authorization"] = "Bearer #{ENV.fetch('FASHN_API_KEY')}"
    request["Content-Type"] = "application/json"
    response = Net::HTTP.start(request.uri.host, request.uri.port, use_ssl: true, open_timeout: 10, read_timeout: 60) do |http|
      http.request(request)
    end
    raise Error, "try-on service answered #{response.code}" unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body)
  end
  private_class_method :post, :get, :request
end
