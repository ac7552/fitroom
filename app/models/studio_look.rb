require "net/http"

# The studio look, for anyone: the page's photo of the 3D view repainted by SDXL on Fitroom's own GPU
# service (script/modal/studio_look.py, on Modal) so it looks like a studio shot. The fit doesn't change:
# the service is held to the render's depth and edges, and gives nothing back if the outline it painted
# differs from the render's by more than 15%.
#
# Only with the person's say-so (a box they tick), and only the mannequin's photo goes: no measurements,
# no name, nothing else about them. The pictures pass through in memory, here and on the service, and
# nothing is written down or logged. Off unless the server has FITROOM_STUDIO_URL, _KEY and _SECRET.
class StudioLook
  class Error < StandardError; end
  class Invalid < StandardError; end

  PNG = %r{\Adata:image/png;base64,([A-Za-z0-9+/=]+)\z}
  MAX_PICTURE = 8_000_000 # characters of data: URL each
  TIMEOUT = 150 # seconds; a cold start (the GPU waking up) takes most of a minute

  class << self
    attr_writer :client

    def available? = !@client.nil? || %w[FITROOM_STUDIO_URL FITROOM_STUDIO_KEY FITROOM_STUDIO_SECRET].all? { ENV[it].present? }

    # photo, depth, mask: PNG data: URLs from the page. outfit: what's worn, in words. Returns a PNG data:
    # URL, or nil when the repaint changed the outfit's shape (the page then keeps its own photo).
    def call(photo:, depth:, mask:, outfit: "")
      raise Error, "not set up" unless available?

      pictures = { photo:, depth:, mask: }.transform_values { base64_of(it) }
      answer = client.call(pictures.merge(outfit: outfit.to_s.first(300)))
      return "data:image/png;base64,#{answer['image']}" if answer["ok"] && answer["image"].is_a?(String)
      return nil if answer["error"] == "shape_changed"

      raise Error, "the studio didn't take the photo"
    end

    def client = @client || method(:post)

    private

    def base64_of(data_url)
      text = data_url.to_s
      match = text.size <= MAX_PICTURE && text.match(PNG)
      raise Invalid unless match

      match[1]
    end

    def post(body)
      uri = URI(ENV.fetch("FITROOM_STUDIO_URL"))
      request = Net::HTTP::Post.new(uri)
      request["Modal-Key"] = ENV.fetch("FITROOM_STUDIO_KEY")
      request["Modal-Secret"] = ENV.fetch("FITROOM_STUDIO_SECRET")
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 10, read_timeout: TIMEOUT) do |http|
        http.request(request)
      end
      raise Error, "the studio answered #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    rescue JSON::ParserError, Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError => e
      raise Error, e.class.name
    end
  end
end
