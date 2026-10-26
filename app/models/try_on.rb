require "net/http"

# Paints a shop's garment onto a studio render by virtual try-on, so the photo shows the exact item (its
# collar, pockets, wash) rather than Fitroom's stand-in garment. The fit stays Fitroom's: the render
# underneath is draped to the measured size, and the verdict is the measured one.
#
# Two ways to do it, Fitroom's own first:
#
# - Fitroom's own try-on service (script/modal/tryon_spike.py on Modal), when FITROOM_TRYON_URL, _KEY and
#   _SECRET are set. It runs an open-source model and then three checks: the figure's outline is the
#   render's (shape), the garment looks like the shop's (identity: likeness and colour) and its print
#   survived (print). When a check fails the service says so, `call` gives back no picture, and the page
#   keeps its own render. The checks come back with the picture so the page can show them.
# - FASHN's hosted API (https://fashn.ai), when only FASHN_API_KEY is set. FASHN deletes inline inputs when
#   the request finishes, expires inline outputs after an hour, and doesn't train on them
#   (https://docs.fashn.ai/api-overview/data-retention-privacy). It runs no checks.
#
# Only runs when the person ticked the box. Only the mannequin's render and the shop's photo go: no
# measurements, nothing about the person. Pictures pass through in memory; nothing is written or logged.
class TryOn
  class Error < StandardError; end

  # What `call` gives back: the PNG bytes (nil when the service refused the picture) and the service's
  # checks ({shape, identity, print, ok}, nil from FASHN's hosted API).
  Result = Struct.new(:image, :checks) do
    def ok? = !image.nil?
  end

  BASE = "https://api.fashn.ai/v1"
  CATEGORIES = { "jacket" => "tops", "coat" => "tops", "trousers" => "bottoms" }.freeze
  TIMEOUT = 150 # seconds; a cold start (the GPU waking up) takes most of a minute
  SELF_HOSTED = %w[FITROOM_TRYON_URL FITROOM_TRYON_KEY FITROOM_TRYON_SECRET].freeze
  DATA_URL = %r{\Adata:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\z}

  class << self
    attr_writer :client

    def self_hosted? = !@client.nil? || SELF_HOSTED.all? { ENV[it].present? }
    def hosted? = ENV["FASHN_API_KEY"].present?
    def available? = self_hosted? || hosted?

    # model_png: the render (PNG bytes). garment: the shop's photo as a data: URL. kind: jacket, coat or
    # trousers. mask: the garment's outline in the render as PNG bytes, when the page has one. Returns a
    # Result; raises Error when neither service answers.
    def call(model_png, garment, kind, mask: nil)
      category = CATEGORIES.fetch(kind)
      return own(model_png, garment, category, mask) if self_hosted?
      raise Error, "no try-on service is set up" unless hosted?

      Result.new(fashn(model_png, garment, category), nil)
    end

    def client = @client || method(:post)

    private

    # Fitroom's own service: {person, garment, category, mask?} in, {ok, image?, checks} out.
    def own(model_png, garment, category, mask)
      payload = garment.to_s.match(DATA_URL)&.[](1)
      raise Error, "the garment's photo isn't a picture" unless payload

      body = { person: Base64.strict_encode64(model_png), garment: payload, category: }
      body[:mask] = Base64.strict_encode64(mask) if mask
      answer = client.call(body)
      checks = answer["checks"].is_a?(Hash) ? answer["checks"] : nil
      if answer["ok"] && answer["image"].is_a?(String)
        Result.new(Base64.decode64(answer["image"]), checks)
      elsif checks || answer["error"].to_s.include?("_failed")
        # A check said no, or the model couldn't paint this one: the page keeps its own render.
        Result.new(nil, checks)
      else
        raise Error, "the try-on service answered #{answer['error'] || 'nothing'}"
      end
    end

    def post(body)
      uri = URI(ENV.fetch("FITROOM_TRYON_URL"))
      request = Net::HTTP::Post.new(uri)
      request["Modal-Key"] = ENV.fetch("FITROOM_TRYON_KEY")
      request["Modal-Secret"] = ENV.fetch("FITROOM_TRYON_SECRET")
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 10, read_timeout: TIMEOUT) do |http|
        http.request(request)
      end
      raise Error, "the try-on service answered #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    rescue JSON::ParserError, Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError => e
      raise Error, e.class.name
    end

    # FASHN's hosted API. Returns PNG bytes.
    def fashn(model_png, garment, category)
      id = fashn_post("run", {
        model_name: "tryon-v1.6",
        inputs: {
          model_image: "data:image/png;base64,#{Base64.strict_encode64(model_png)}",
          garment_image: garment,
          category:,
          mode: "quality",
          output_format: "png",
          return_base64: true
        }
      }).fetch("id")

      deadline = Time.current + TIMEOUT
      loop do
        raise Error, "try-on took too long" if Time.current > deadline

        sleep 2
        status = fashn_get("status/#{id}")
        case status["status"]
        when "completed" then return Base64.decode64(status.fetch("output").first.split(",", 2).last)
        when "failed" then raise Error, "try-on failed"
        end
      end
    end

    def fashn_post(path, body)
      fashn_request(Net::HTTP::Post.new(URI("#{BASE}/#{path}")).tap { it.body = JSON.generate(body) })
    end

    def fashn_get(path) = fashn_request(Net::HTTP::Get.new(URI("#{BASE}/#{path}")))

    def fashn_request(request)
      request["Authorization"] = "Bearer #{ENV.fetch('FASHN_API_KEY')}"
      request["Content-Type"] = "application/json"
      response = Net::HTTP.start(request.uri.host, request.uri.port, use_ssl: true, open_timeout: 10, read_timeout: 60) do |http|
        http.request(request)
      end
      raise Error, "try-on service answered #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    end
  end
end
