require "erb"
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
#   Each picture is a job there (see Jobs): started, asked about every 2 to 3 seconds, cancelled at the
#   deadline or when the person presses Stop (TryOnJob), because Modal cuts a web request off at 150 s and
#   a GPU waking from sleep can take longer. FITROOM_TRYON_URL is the jobs app's base URL. The old
#   synchronous endpoint (a URL ending in -tryon-tryon.modal.run, or FITROOM_TRYON_MODE=sync) still works
#   for one release.
# - FASHN's hosted API (https://fashn.ai), when only FASHN_API_KEY is set. FASHN deletes inline inputs when
#   the request finishes, expires inline outputs after an hour, and doesn't train on them
#   (https://docs.fashn.ai/api-overview/data-retention-privacy). It runs no checks.
#
# Only runs when the person ticked the box. Only the mannequin's render and the shop's photo go: no
# measurements, nothing about the person. Pictures pass through in memory; nothing is written or logged.
class TryOn
  class Error < StandardError; end
  class Invalid < StandardError; end
  class Cancelled < StandardError; end

  # What `call` gives back: the PNG bytes (nil when the service refused the picture) and the service's
  # checks ({shape, identity, print, ok}, nil from FASHN's hosted API).
  Result = Struct.new(:image, :checks) do
    def ok? = !image.nil?
  end

  BASE = "https://api.fashn.ai/v1"
  CATEGORIES = { "top" => "tops", "jacket" => "tops", "coat" => "tops", "trousers" => "bottoms" }.freeze
  # The outermost top is the one that shows, so it's the one painted; then the trousers, onto that.
  LAYERS = [ %w[coat jacket top], %w[trousers] ].freeze
  # Seconds the old synchronous endpoint may take to answer one request (Modal itself stops it at 150 s).
  TIMEOUT = 240
  # Seconds a whole picture (every layer) may take on the jobs service before it's cancelled. A warm GPU
  # paints a garment in 15 to 30 s; a sleeping one wakes in well under a minute from its memory snapshot,
  # and the first start after a deploy takes a few minutes (it reads the weights and takes the snapshot).
  DEADLINE = Integer(ENV.fetch("FITROOM_TRYON_DEADLINE", 300), exception: false) || 300
  POLL_FIRST = 2.0 # seconds between asking how a job is doing, growing to
  POLL_MAX = 3.0
  POLL_MISSES = 3 # failed asks in a row before giving up
  # Steps of the model for each garment on Fitroom's own service: 20 is FASHN's "fast", and keeps a top and
  # trousers inside a minute on a warm L4 (30, its default, is a little finer and a third slower).
  STEPS = Integer(ENV.fetch("FITROOM_TRYON_STEPS", 20), exception: false) || 20
  WARM_EVERY = 45 # seconds: a wake-up call at most this often (the GPU sleeps after a minute idle)
  PNG = %r{\Adata:image/png;base64,([A-Za-z0-9+/=]+)\z}
  MAX_PICTURE = 8_000_000 # characters of a data: URL
  SELF_HOSTED = %w[FITROOM_TRYON_URL FITROOM_TRYON_KEY FITROOM_TRYON_SECRET].freeze
  DATA_URL = %r{\Adata:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\z}

  # What a picture in progress reports to, and what can stop it: the deadline (a TryOn.now reading), a
  # `cancelled` check, and hooks for the job's id, its phase ("starting" while a GPU wakes, "painting") and
  # the garment being painted. TryOnJob passes one; a bare call gets the default deadline and no hooks.
  class Watch
    attr_reader :deadline

    def initialize(deadline: TryOn.now + DEADLINE, cancelled: -> { false }, started: ->(_) { }, phase: ->(_) { }, layer: ->(_) { })
      @deadline, @cancelled, @started, @phase, @layer = deadline, cancelled, started, phase, layer
    end

    def cancelled? = @cancelled.call
    def late? = TryOn.now > deadline
    def started(id) = @started.call(id)
    def phase(name) = @phase.call(name)
    def layer(kind) = @layer.call(kind)
  end

  # The jobs app of Fitroom's own service (tryon_service.py's `jobs`): POST start, GET result/:id,
  # POST cancel/:id under one base URL, each answering at once.
  class Jobs
    # http: what opens the connection (Net::HTTP; the tests pass a stand-in).
    def initialize(base: ENV.fetch("FITROOM_TRYON_URL"), key: ENV.fetch("FITROOM_TRYON_KEY"), secret: ENV.fetch("FITROOM_TRYON_SECRET"), http: Net::HTTP)
      @base, @key, @secret, @http = base.to_s.chomp("/"), key, secret, http
    end

    # The call's id. Raises Error when the service turns the request down or doesn't answer.
    def start(body)
      answer = request(Net::HTTP::Post, "start", body)
      answer["id"].is_a?(String) ? answer["id"] : raise(Error, "the try-on service answered #{answer['error'] || 'no id'}")
    end

    # {status: "pending", phase} | {status: "done", ok, image?, checks, seconds} | {status: "failed", error}.
    def result(id) = request(Net::HTTP::Get, "result/#{ERB::Util.url_encode(id)}")

    def cancel(id) = request(Net::HTTP::Post, "cancel/#{ERB::Util.url_encode(id)}", {})

    private

    def request(kind, path, body = nil)
      uri = URI("#{@base}/#{path}")
      request = kind.new(uri)
      request["Modal-Key"] = @key
      request["Modal-Secret"] = @secret
      request["Accept"] = "application/json"
      if body
        request["Content-Type"] = "application/json"
        request.body = JSON.generate(body)
      end
      response = @http.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 10, read_timeout: 30) do |http|
        http.request(request)
      end
      # 202 is a job still running, 410 one whose result has gone; both carry JSON. Anything else
      # (a 303 from Modal's 150 s limit, a 401 without the token, a 5xx) is the service not answering.
      unless response.is_a?(Net::HTTPSuccess) || response.code == "410"
        raise Error, "the try-on service answered #{response.code}"
      end

      JSON.parse(response.body)
    rescue JSON::ParserError, Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError, OpenSSL::SSL::SSLError => e
      raise Error, e.class.name
    end
  end

  class << self
    attr_writer :client, :sleeper, :clock

    def self_hosted? = !@client.nil? || SELF_HOSTED.all? { ENV[it].present? }
    def hosted? = ENV["FASHN_API_KEY"].present?
    def available? = self_hosted? || hosted?

    # "jobs" (the jobs app: start, then poll) or "sync" (the old endpoint, one long request). From
    # FITROOM_TRYON_MODE when set; otherwise "sync" only for a URL that is the old endpoint's.
    def mode
      given = ENV["FITROOM_TRYON_MODE"].to_s.strip.downcase
      return given if %w[jobs sync].include?(given)

      host = URI(ENV["FITROOM_TRYON_URL"].to_s).host.to_s
      host.end_with?("-tryon-tryon.modal.run") ? "sync" : "jobs"
    rescue URI::InvalidURIError
      "jobs"
    end

    def now = (@clock || -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) }).call
    def sleeper = @sleeper || ->(seconds) { sleep seconds }

    # The page's own picture of the outfit with the shops' photos painted on, the outermost top first and
    # then the trousers onto that. photo and outline: data:image/png URLs from the page (the picture, and the
    # figure white on black). items: [{kind:, photo:}] with each garment's shop photo as a data: URL. Returns
    # {image: data URL or nil, checks: {kind => checks}, painted: [kinds]}; image nil when nothing passed.
    # Raises Invalid on bad input, Error when the service doesn't answer, Cancelled when the watch says so.
    def dress(photo:, items:, outline: nil, watch: nil) = paint(prepare(photo:, items:, outline:), watch:)

    # dress's checks, before anything is sent: {picture: PNG bytes, outline: PNG bytes or nil, photos:
    # {kind => data URL}, layers: [kinds, in painting order]}. Raises Invalid.
    def prepare(photo:, items:, outline: nil)
      picture = png(photo) or raise Invalid, "photo"
      edge = outline.present? ? (png(outline) or raise Invalid, "outline") : nil
      photos = Array(items).filter_map do |item|
        item = item.to_h.symbolize_keys
        [ item[:kind].to_s, item[:photo].to_s ] if CATEGORIES.key?(item[:kind].to_s) && item[:photo].to_s.match?(DATA_URL)
      end.to_h
      layers = LAYERS.filter_map { |kinds| kinds.find { photos.key?(it) } }
      raise Invalid, "items" if layers.empty?

      { picture:, outline: edge, photos:, layers: }
    end

    # dress's painting, from what `prepare` gave: one layer after another, each onto the last picture, all
    # inside one watch (one deadline for the lot).
    def paint(prepared, watch: nil)
      watch ||= Watch.new
      picture, checks, painted = prepared[:picture], {}, []
      prepared[:layers].each do |kind|
        raise Cancelled if watch.cancelled?

        watch.layer(kind)
        answer = call(picture, prepared[:photos][kind], kind, outline: prepared[:outline], watch:)
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

      sender = client

      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @warming ||= Mutex.new
      @warming.synchronize do
        return false if @warmed_at && now - @warmed_at < WARM_EVERY

        @warmed_at = now
      end
      Thread.new do
        sender.respond_to?(:start) ? sender.start({ warm: true }) : sender.call({ warm: true })
      rescue StandardError
        nil # a wake-up that fails costs nothing; the picture itself will say what's wrong
      end
    end

    # Forgets the last wake-up (for the tests).
    def reset! = @warmed_at = nil

    # model_png: the render (PNG bytes). garment: the shop's photo as a data: URL. kind: top, jacket, coat or
    # trousers. mask: the garment's outline in the render, and outline: the figure's (white on black), as PNG
    # bytes, when the page has them. watch: a Watch (deadline, cancel, progress), or the default deadline.
    # Returns a Result; raises Error when neither service answers, Cancelled when the watch says so.
    def call(model_png, garment, kind, mask: nil, outline: nil, watch: nil)
      category = CATEGORIES.fetch(kind)
      watch ||= Watch.new
      return own(model_png, garment, category, mask, outline, watch) if self_hosted?
      raise Error, "no try-on service is set up" unless hosted?

      watch.phase("painting")
      Result.new(fashn(model_png, garment, category, watch), nil)
    end

    # What talks to the service: a Jobs (start/result/cancel) or anything with `call(body) -> answer` (the
    # old endpoint, the tests' lambdas).
    def client = @client || (mode == "jobs" ? Jobs.new : method(:post))

    # Cancels a job on the service; quiet when that fails (it stops at its own timeout anyway).
    def cancel(id)
      sender = client
      sender.cancel(id) if id && sender.respond_to?(:cancel)
    rescue StandardError
      nil
    end

    private

    def png(data_url)
      text = data_url.to_s
      text.length <= MAX_PICTURE && text.match(PNG)&.then { Base64.strict_decode64(it[1]) }
    rescue ArgumentError
      nil
    end

    # Fitroom's own service: {person, garment, category, steps, mask?, outline?} in, {ok, image?, checks} out.
    def own(model_png, garment, category, mask, outline, watch)
      payload = garment.to_s.match(DATA_URL)&.[](1)
      raise Error, "the garment's photo isn't a picture" unless payload

      body = { person: Base64.strict_encode64(model_png), garment: payload, category:, steps: STEPS }
      body[:mask] = Base64.strict_encode64(mask) if mask
      body[:outline] = Base64.strict_encode64(outline) if outline
      answer = ask(body, watch)
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

    # One picture from the service: at once from a client that answers in one go, or by starting a job and
    # asking after it, every 2 s and then 3 s, until it's done, the deadline passes or the watch cancels (both
    # cancel the job on the service too, so it stops holding a GPU). A few failed asks in a row are an Error.
    def ask(body, watch)
      sender = client
      unless sender.respond_to?(:start)
        watch.phase("painting")
        return sender.call(body)
      end

      id = sender.start(body)
      watch.started(id)
      wait, misses = POLL_FIRST, 0
      loop do
        sleeper.call(wait)
        wait = [ wait + 0.5, POLL_MAX ].min
        if watch.cancelled?
          cancel(id)
          raise Cancelled
        end
        if watch.late?
          cancel(id)
          raise Error, "try-on took too long"
        end
        begin
          answer = sender.result(id)
        rescue Error
          (misses += 1) < POLL_MISSES ? next : raise
        end
        misses = 0
        case answer["status"]
        when "pending" then watch.phase(answer["phase"] == "painting" ? "painting" : "starting")
        when "failed" then raise Error, "the try-on service answered #{answer['error'] || 'failed'}"
        else return answer
        end
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
    def fashn(model_png, garment, category, watch)
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

      loop do
        raise Error, "try-on took too long" if watch.late?

        sleeper.call(2)
        raise Cancelled if watch.cancelled?

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
