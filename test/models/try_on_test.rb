require "test_helper"
require_relative "../support/fake_try_on_jobs"

class TryOnTest < ActiveSupport::TestCase
  PNG = "\x89PNG\r\n\x1a\nrender".b
  PHOTO = "data:image/jpeg;base64,#{Base64.strict_encode64('shop photo')}".freeze
  CHECKS = {
    "shape" => { "score" => 0.93, "threshold" => 0.85, "pass" => true },
    "identity" => { "score" => 0.88, "colour" => 3.1, "threshold" => 0.8, "colour_threshold" => 12.0, "pass" => true },
    "print" => { "skipped" => true, "score" => nil, "threshold" => 0.45, "pass" => true },
    "ok" => true
  }.freeze

  teardown do
    TryOn.client = nil
    TryOn.sleeper = nil
    TryOn.clock = nil
    TryOn.reset!
  end

  def done(image = "painted", checks = CHECKS) = { "status" => "done", "ok" => true, "image" => Base64.strict_encode64(image), "checks" => checks }

  # Runs the block with these ENV entries (nil deletes one), then puts them back.
  def with_env(changes)
    before = changes.keys.to_h { [ it, ENV[it] ] }
    changes.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
    yield
  ensure
    before.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
  end

  def png_url(bytes) = "data:image/png;base64,#{Base64.strict_encode64(bytes)}"

  test "sends the render, the shop photo and the category to Fitroom's own service, and gets the picture and checks back" do
    sent = nil
    TryOn.client = ->(body) { sent = body; { "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS } }

    result = TryOn.call(PNG, PHOTO, "jacket")

    assert result.ok?
    assert_equal "painted", result.image
    assert_equal CHECKS, result.checks
    assert_equal Base64.strict_encode64(PNG), sent[:person]
    assert_equal Base64.strict_encode64("shop photo"), sent[:garment]
    assert_equal "tops", sent[:category]
    refute sent.key?(:mask)
  end

  test "trousers are bottoms, and a garment mask goes along when the page has one" do
    sent = nil
    TryOn.client = ->(body) { sent = body; { "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS } }

    TryOn.call(PNG, PHOTO, "trousers", mask: "mask png".b)

    assert_equal "bottoms", sent[:category]
    assert_equal Base64.strict_encode64("mask png"), sent[:mask]
  end

  test "a refused picture comes back without an image but with the checks that said no" do
    refused = CHECKS.merge("shape" => CHECKS["shape"].merge("score" => 0.71, "pass" => false), "ok" => false)
    TryOn.client = ->(_) { { "ok" => false, "checks" => refused } }

    result = TryOn.call(PNG, PHOTO, "coat")

    refute result.ok?
    assert_nil result.image
    assert_equal 0.71, result.checks.dig("shape", "score")
  end

  test "a model that couldn't paint this one is a refusal too, not an error" do
    TryOn.client = ->(_) { { "ok" => false, "error" => "leffa_failed:RuntimeError", "seconds" => 3.2 } }

    result = TryOn.call(PNG, PHOTO, "jacket")

    refute result.ok?
    assert_nil result.checks
  end

  test "anything else the service says is an error" do
    TryOn.client = ->(_) { { "ok" => false, "error" => "invalid" } }
    assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "jacket") }

    TryOn.client = ->(_) { raise TryOn::Error, "Net::ReadTimeout" }
    assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "jacket") }
  end

  test "a garment that isn't a picture never reaches the service" do
    TryOn.client = ->(_) { flunk "the service was called" }
    assert_raises(TryOn::Error) { TryOn.call(PNG, "data:text/html;base64,PHNjcmlwdD4=", "jacket") }
  end

  test "a kind it doesn't dress is a KeyError before anything is sent" do
    TryOn.client = ->(_) { flunk "the service was called" }
    assert_raises(KeyError) { TryOn.call(PNG, PHOTO, "hat") }
  end

  test "is available with its own service or with a FASHN key, and the own service comes first" do
    skip "this machine has a try-on service set up" if TryOn::SELF_HOSTED.any? { ENV[it].present? } || ENV["FASHN_API_KEY"].present?
    refute TryOn.available?
    TryOn.client = ->(_) { { "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS } }
    assert TryOn.self_hosted?
    assert TryOn.available?
    assert_equal "painted", TryOn.call(PNG, PHOTO, "jacket").image
  end

  test "a top is a top for the service, and the figure's outline and the steps go along" do
    sent = nil
    TryOn.client = ->(body) { sent = body; { "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS } }

    TryOn.call(PNG, PHOTO, "top", outline: "outline png".b)

    assert_equal "tops", sent[:category]
    assert_equal Base64.strict_encode64("outline png"), sent[:outline]
    assert_equal TryOn::STEPS, sent[:steps]
  end

  test "dressing the page's picture paints the outermost top, then the trousers onto that" do
    sent = []
    TryOn.client = lambda do |body|
      sent << body
      { "ok" => true, "image" => Base64.strict_encode64("#{Base64.decode64(body[:person])}+#{body[:category]}"), "checks" => CHECKS }
    end
    items = [ { kind: "trousers", photo: PHOTO }, { kind: "top", photo: PHOTO }, { kind: "jacket", photo: PHOTO }, { kind: "shoes", photo: PHOTO } ]

    dressed = TryOn.dress(photo: png_url("page"), outline: png_url("figure"), items:)

    assert_equal %w[tops bottoms], sent.map { it[:category] }  # the jacket over the top, then the trousers
    assert_equal png_url("page+tops+bottoms"), dressed[:image]
    assert_equal %w[jacket trousers], dressed[:painted]
    assert_equal %w[jacket trousers], dressed[:checks].keys
    assert_equal Base64.strict_encode64("figure"), sent.first[:outline]
  end

  test "a refused garment is left as the page drew it, and when every one is refused there's no picture" do
    refused = CHECKS.merge("ok" => false)
    TryOn.client = ->(body) { body[:category] == "tops" ? { "ok" => false, "checks" => refused } : { "ok" => true, "image" => Base64.strict_encode64("pants on"), "checks" => CHECKS } }
    both = TryOn.dress(photo: png_url("page"), items: [ { kind: "top", photo: PHOTO }, { kind: "trousers", photo: PHOTO } ])
    assert_equal png_url("pants on"), both[:image]
    assert_equal %w[trousers], both[:painted]
    assert_equal false, both[:checks]["top"]["ok"]

    TryOn.client = ->(_) { { "ok" => false, "checks" => refused } }
    none = TryOn.dress(photo: png_url("page"), items: [ { kind: "top", photo: PHOTO } ])
    assert_nil none[:image]
    assert_equal({ "top" => refused }, none[:checks])
  end

  test "a picture that isn't a PNG, or no garment it can paint, is turned away before the service" do
    TryOn.client = ->(_) { flunk "the service was called" }
    assert_raises(TryOn::Invalid) { TryOn.dress(photo: PHOTO, items: [ { kind: "top", photo: PHOTO } ]) }
    assert_raises(TryOn::Invalid) { TryOn.dress(photo: png_url("page"), outline: "not a picture", items: [ { kind: "top", photo: PHOTO } ]) }
    assert_raises(TryOn::Invalid) { TryOn.dress(photo: png_url("page"), items: [ { kind: "shoes", photo: PHOTO } ]) }
    assert_raises(TryOn::Invalid) { TryOn.dress(photo: png_url("page"), items: [ { kind: "top", photo: "https://shop.example/top.jpg" } ]) }
  end

  test "a wake-up goes to Fitroom's own service at most every 45 seconds, in the background" do
    sent = []
    TryOn.client = ->(body) { sent << body; { "ok" => true, "warm" => true } }

    TryOn.warm.join
    refute TryOn.warm

    assert_equal [ { warm: true } ], sent
  end

  test "a wake-up that fails is quiet" do
    TryOn.client = ->(_) { raise TryOn::Error, "Net::ReadTimeout" }
    assert_nil TryOn.warm.value
  end

  test "on the jobs service a picture is started, asked after every 2 s growing to 3 s, and taken when done" do
    jobs = FakeTryOnJobs.new(FakeTryOnJobs::PENDING, { "status" => "pending", "phase" => "painting" }, FakeTryOnJobs::PENDING, done)
    TryOn.client = jobs
    slept, phases, ids = [], [], []
    TryOn.sleeper = ->(seconds) { slept << seconds }
    watch = TryOn::Watch.new(started: ->(id) { ids << id }, phase: ->(phase) { phases << phase })

    result = TryOn.call(PNG, PHOTO, "jacket", watch:)

    assert_equal "painted", result.image
    assert_equal CHECKS, result.checks
    assert_equal "tops", jobs.started.first[:category]
    assert_equal Base64.strict_encode64(PNG), jobs.started.first[:person]
    assert_equal %w[fc-1], ids
    assert_equal [ 2.0, 2.5, 3.0, 3.0 ], slept
    assert_equal %w[starting painting starting], phases
    assert_empty jobs.cancelled
  end

  test "a job past its deadline is cancelled on the service, and is an error" do
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs
    clock = 1000.0
    TryOn.clock = -> { clock }
    TryOn.sleeper = ->(seconds) { clock += seconds }

    error = assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "top", watch: TryOn::Watch.new(deadline: 1010.0)) }

    assert_match(/too long/, error.message)
    assert_equal %w[fc-1], jobs.cancelled
    assert_operator jobs.polls, :<=, 5
  end

  test "the default deadline is FITROOM_TRYON_DEADLINE's 300 s, counted from the start" do
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs
    clock = 0.0
    TryOn.clock = -> { clock }
    TryOn.sleeper = ->(seconds) { clock += seconds }

    assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "top") }

    assert_equal 300, TryOn::DEADLINE
    assert_in_delta 300, clock, 3.0
    assert_equal %w[fc-1], jobs.cancelled
  end

  test "a job the watch cancels is cancelled on the service too" do
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs
    TryOn.sleeper = ->(_) { }
    stop = false
    watch = TryOn::Watch.new(cancelled: -> { stop }, phase: ->(_) { stop = true })

    assert_raises(TryOn::Cancelled) { TryOn.call(PNG, PHOTO, "top", watch:) }
    assert_equal %w[fc-1], jobs.cancelled
  end

  test "a refusal on the jobs service is a picture-less result with the checks" do
    refused = CHECKS.merge("ok" => false)
    TryOn.client = FakeTryOnJobs.new({ "status" => "done", "ok" => false, "checks" => refused, "seconds" => 14.2 })
    TryOn.sleeper = ->(_) { }

    result = TryOn.call(PNG, PHOTO, "coat")

    refute result.ok?
    assert_equal refused, result.checks
  end

  test "a failed job is an error; a couple of failed asks are shrugged off, three in a row are not" do
    TryOn.sleeper = ->(_) { }
    TryOn.client = FakeTryOnJobs.new({ "status" => "failed", "error" => "timeout" })
    assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "top") }

    TryOn.client = FakeTryOnJobs.new(TryOn::Error.new("503"), TryOn::Error.new("503"), done)
    assert_equal "painted", TryOn.call(PNG, PHOTO, "top").image

    jobs = FakeTryOnJobs.new(TryOn::Error.new("503"), TryOn::Error.new("503"), TryOn::Error.new("503"), done)
    TryOn.client = jobs
    assert_raises(TryOn::Error) { TryOn.call(PNG, PHOTO, "top") }
    assert_equal 3, jobs.polls
  end

  test "dressing on the jobs service paints the trousers onto the top's picture, inside one deadline" do
    jobs = FakeTryOnJobs.new { |_, body| done("#{Base64.decode64(body[:person])}+#{body[:category]}") }
    TryOn.client = jobs
    TryOn.sleeper = ->(_) { }
    layers = []

    dressed = TryOn.dress(photo: png_url("page"), items: [ { kind: "trousers", photo: PHOTO }, { kind: "top", photo: PHOTO } ],
                          watch: TryOn::Watch.new(layer: ->(kind) { layers << kind }))

    assert_equal png_url("page+tops+bottoms"), dressed[:image]
    assert_equal %w[top trousers], layers
    assert_equal 2, jobs.started.size
  end

  test "a wake-up on the jobs service is a started warm job" do
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs

    TryOn.warm.join

    assert_equal [ { warm: true } ], jobs.started
    assert_equal 0, jobs.polls
  end

  test "the service is the jobs app unless the URL is the old endpoint's or FITROOM_TRYON_MODE says otherwise" do
    with_env("FITROOM_TRYON_MODE" => nil, "FITROOM_TRYON_URL" => "https://acme--fitroom-tryon-service-jobs.modal.run") do
      assert_equal "jobs", TryOn.mode
    end
    with_env("FITROOM_TRYON_MODE" => nil, "FITROOM_TRYON_URL" => "https://acme--fitroom-tryon-service-tryon-tryon.modal.run") do
      assert_equal "sync", TryOn.mode
    end
    with_env("FITROOM_TRYON_MODE" => "sync", "FITROOM_TRYON_URL" => "https://acme--fitroom-tryon-service-jobs.modal.run") do
      assert_equal "sync", TryOn.mode
    end
    with_env("FITROOM_TRYON_MODE" => "jobs", "FITROOM_TRYON_URL" => "https://acme--fitroom-tryon-service-tryon-tryon.modal.run") do
      assert_equal "jobs", TryOn.mode
    end
  end

  # A stand-in for Net::HTTP: `start` yields a connection whose `request` answers with the block's response.
  def fake_http(sent = [], &respond)
    connection = Object.new
    connection.define_singleton_method(:request) { |request| sent << request; respond.call(request) }
    starter = Object.new
    starter.define_singleton_method(:start) { |*_, **_, &block| block.call(connection) }
    starter
  end

  def response(kind, code, body = nil)
    kind.new("1.1", code, "").tap do |answer|
      answer.instance_variable_set(:@body, body)
      answer.instance_variable_set(:@read, true)
    end
  end

  test "the jobs client sends the token and appends the paths to one base URL" do
    sent = []
    http = fake_http(sent) do |request|
      request.path.start_with?("/start") ? response(Net::HTTPOK, "200", '{"id":"fc-9"}') : response(Net::HTTPAccepted, "202", '{"status":"pending","phase":"starting"}')
    end
    jobs = TryOn::Jobs.new(base: "https://acme--fitroom-tryon-service-jobs.modal.run/", key: "wk-1", secret: "ws-1", http:)

    assert_equal "fc-9", jobs.start({ warm: true })
    assert_equal "pending", jobs.result("fc-9")["status"]
    jobs.cancel("fc-9")

    assert_equal [ "POST /start", "GET /result/fc-9", "POST /cancel/fc-9" ], sent.map { "#{it.method} #{it.path}" }
    assert_equal %w[wk-1 ws-1], [ sent.first["Modal-Key"], sent.first["Modal-Secret"] ]
    assert_equal({ "warm" => true }, JSON.parse(sent.first.body))
  end

  test "a redirect from the service (Modal's 150 s limit) is an error, not a hang; an expired result is an answer" do
    jobs = TryOn::Jobs.new(base: "https://acme--fitroom-tryon-service-jobs.modal.run", key: "k", secret: "s",
                           http: fake_http { response(Net::HTTPSeeOther, "303") })
    assert_raises(TryOn::Error) { jobs.result("fc-1") }

    gone = TryOn::Jobs.new(base: "https://acme--fitroom-tryon-service-jobs.modal.run", key: "k", secret: "s",
                           http: fake_http { response(Net::HTTPGone, "410", '{"status":"failed","error":"expired"}') })
    assert_equal "failed", gone.result("fc-1")["status"]
  end
end
