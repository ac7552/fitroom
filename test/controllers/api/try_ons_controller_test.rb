require "test_helper"

class Api::TryOnsControllerTest < ActionDispatch::IntegrationTest
  PHOTO = "data:image/jpeg;base64,#{Base64.strict_encode64('shop photo')}".freeze
  PAGE = "data:image/png;base64,#{Base64.strict_encode64("\x89PNG\r\n\x1a\npage".b)}".freeze
  CHECKS = { "shape" => { "score" => 0.93, "threshold" => 0.85, "pass" => true }, "ok" => true }.freeze

  teardown do
    TryOn.client = nil
    TryOn.reset!
  end

  test "paints the stores' photos onto the page's picture and sends it back with the checks" do
    TryOn.client = ->(_) { { "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS } }

    post api_v1_try_ons_path, params: { photo: PAGE, items: [ { kind: "top", photo: PHOTO } ] }, as: :json

    assert_response :success
    assert_equal "data:image/png;base64,#{Base64.strict_encode64('painted')}", response.parsed_body["image"]
    assert_equal CHECKS, response.parsed_body["checks"]["top"]
  end

  test "a picture it can't read is a 422" do
    TryOn.client = ->(_) { flunk "the service was called" }
    post api_v1_try_ons_path, params: { photo: "nope", items: [ { kind: "top", photo: PHOTO } ] }, as: :json
    assert_response :unprocessable_entity
    assert_equal "photo", response.parsed_body["field"]
  end

  test "a service that doesn't answer is a 502 with words for the page" do
    TryOn.client = ->(_) { raise TryOn::Error, "Net::ReadTimeout" }
    post api_v1_try_ons_path, params: { photo: PAGE, items: [ { kind: "top", photo: PHOTO } ] }, as: :json
    assert_response :bad_gateway
    assert_match(/didn't work/, response.parsed_body["message"])
  end

  test "without a try-on service it says so" do
    skip "this machine has a try-on service set up" if TryOn::SELF_HOSTED.any? { ENV[it].present? } || ENV["FASHN_API_KEY"].present?
    post api_v1_try_ons_path, params: { photo: PAGE, items: [ { kind: "top", photo: PHOTO } ] }, as: :json
    assert_response :service_unavailable
  end

  test "a wake-up is accepted at once" do
    sent = Queue.new
    TryOn.client = ->(body) { sent << body; { "ok" => true, "warm" => true } }
    post warm_api_v1_try_ons_path, as: :json
    assert_response :accepted
    assert_equal true, response.parsed_body["warming"]
    assert_equal({ warm: true }, sent.pop(timeout: 5))
  end
end
