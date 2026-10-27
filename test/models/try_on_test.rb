require "test_helper"

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
    TryOn.reset!
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
end
