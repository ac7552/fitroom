require "net/http"

# Paints a shop's garment onto a studio render by virtual try-on, so the photo shows the exact item (its
# collar, pockets, wash) rather than Fitroom's stand-in garment. The fit stays Fitroom's: the render
# underneath is draped to the measured size, and the verdict is the measured one.
#
# Two ways to do it, Fitroom's own first:
#
# - Fitroom's own try-on service (script/modal/tryon_service.py on Modal), when FITROOM_TRYON_URL, _KEY and
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
  class Invalid < StandardError; end

  # What `call` gives back: the PNG bytes (nil when the service refused the picture) and the service's
  # checks ({shape, identity, print, ok}, nil from FASHN's hosted API).
  Result = Struct.new(:image, :checks) do
    def ok? = !image.nil?
  end

  BASE = "https://api.fashn.ai/v1"
  CATEGORIES = { "top" => "tops", "jacket" => "tops", "coat" => "tops", "trousers" => "bottoms" }.freeze
  # The outermost top is the one that shows, so it's the one painted; then the trousers, onto that.
  LAYERS = [ %w[coat jacket top], %w[trousers] ].freeze
  # Seconds to wait for a picture. A warm GPU answers in 15 to 30 s; a cold one takes about a minute to wake,
  # and the very first start after a deploy longer still (it pulls the service's image first), so there's room.
  TIMEOUT = 240
  # Steps of the model for each garment on Fitroom's own service: 20 is FASHN's "fast", and keeps a top and
  # trousers inside a minute on a warm L4 (30, its default, is a little finer and a third slower).
  STEPS = Integer(ENV.fetch("FITROOM_TRYON_STEPS", 20), exception: false) || 20
  WARM_EVERY = 45 # seconds: a wake-up call at most this often (the GPU sleeps after a minute idle)
  PNG = %r{\Adata:image/png;base64,([A-Za-z0-9+/=]+)\z}
  MAX_PICTURE = 8_000_000 # characters of a data: URL
  SELF_HOSTED = %w[FITROOM_TRYON_URL FITROOM_TRYON_KEY FITROOM_TRYON_SECRET].freeze
  DATA_URL = %r{\Adata:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\z}

  class << self
    attr_writer :client

    def self_hosted? = !@client.nil? || SELF_HOSTED.all? { ENV[it].present? }
    def hosted? = ENV["FASHN_API_KEY"].present?
    def available? = self_hosted? || hosted?

    # The page's own picture of the outfit with the shops' photos painted on, the outermost top first and
    # then the trousers onto that. photo and outline: data:image/png URLs from the page (the picture, and the
    # figure white on black). items: [{kind:, photo:}] with each garment's shop photo as a data: URL. Returns
    # {image: data URL or nil, checks: {kind => checks}, painted: [kinds]}; image nil when nothing passed.
    # Raises Invalid on bad input, Error when the service doesn't answer.
    def dress(photo:, items:, outline: nil)
      picture = png(photo) or raise Invalid, "photo"
      edge = outline.present? ? (png(outline) or raise Invalid, "outline") : nil
      photos = Array(items).filter_map do |item|
        item = item.to_h.symbolize_keys
        [ item[:kind].to_s, item[:photo].to_s ] if CATEGORIES.key?(item[:kind].to_s) && item[:photo].to_s.match?(DATA_URL)
      end.to_h
      layers = LAYERS.filter_map { |kinds| kinds.find { photos.key?(it) } }
      raise Invalid, "items" if layers.empty?

      checks, painted = {}, []
      layers.each do |kind|
        answer = call(picture, photos[kind], kind, outline: edge)
        checks[kind] = answer.checks if answer.checks
        next unless answer.ok?

        picture = answer.image
        painted << kind
      end
      { image: painted.any? ? "data:image/png;base64,#{Base64.strict_encode64(picture)}" : nil, checks:, painted: }
    end

    # Wakes Fitroom's own service (a GPU takes about a minute to start) without painting anything, in the
    # background and at most every WARM_EVERY seconds. Returns the thread sending it, or false when none
    # was sent. FASHN's hosted API is always awake: nothing to do.
    def warm
      return false unless self_hosted?

      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @warming ||= Mutex.new
      @warming.synchronize do
        return false if @warmed_at && now - @warmed_at < WARM_EVERY

        @warmed_at = now
      end
      Thread.new do
        client.call({ warm: true })
      rescue StandardError
        nil # a wake-up that fails costs nothing; the picture itself will say what's wrong
      end
    end

    # Forgets the last wake-up (for the tests).
    def reset! = @warmed_at = nil

    # model_png: the render (PNG bytes). garment: the shop's photo as a data: URL. kind: top, jacket, coat or
    # trousers. mask: the garment's outline in the render, and outline: the figure's (white on black), as PNG
    # bytes, when the page has them. Returns a Result; raises Error when neither service answers.
    def call(model_png, garment, kind, mask: nil, outline: nil)
      category = CATEGORIES.fetch(kind)
      return own(model_png, garment, category, mask, outline) if self_hosted?
      raise Error, "no try-on service is set up" unless hosted?

      Result.new(fashn(model_png, garment, category), nil)
    end

    def client = @client || method(:post)

    private

    def png(data_url)
      text = data_url.to_s
      text.length <= MAX_PICTURE && text.match(PNG)&.then { Base64.strict_decode64(it[1]) }
    rescue ArgumentError
      nil
    end

    # Fitroom's own service: {person, garment, category, steps, mask?, outline?} in, {ok, image?, checks} out.
    def own(model_png, garment, category, mask, outline)
      payload = garment.to_s.match(DATA_URL)&.[](1)
      raise Error, "the garment's photo isn't a picture" unless payload

      body = { person: Base64.strict_encode64(model_png), garment: payload, category:, steps: STEPS }
      body[:mask] = Base64.strict_encode64(mask) if mask
      body[:outline] = Base64.strict_encode64(outline) if outline
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
