require "test_helper"

class Api::StudioLooksControllerTest < ActionDispatch::IntegrationTest
  def picture(text) = "data:image/png;base64,#{Base64.strict_encode64(text)}"

  def pictures = { photo: picture("photo"), depth: picture("depth"), mask: picture("mask"), outfit: "navy coat, black jeans" }

  teardown { StudioLook.client = nil }

  test "sends the three pictures and the outfit, and gives back the repainted photo" do
    sent = nil
    StudioLook.client = ->(body) { sent = body; { "ok" => true, "image" => Base64.strict_encode64("painted"), "iou" => 0.93 } }
    post api_v1_studio_looks_path, params: pictures, as: :json

    assert_response :success
    assert_equal picture("painted"), response.parsed_body["image"]
    assert_equal "no-store", response.headers["Cache-Control"]
    assert_equal Base64.strict_encode64("photo"), sent[:photo]
    assert_equal Base64.strict_encode64("mask"), sent[:mask]
    assert_equal "navy coat, black jeans", sent[:outfit]
  end

  test "says so when the repaint changed the outfit's shape" do
    StudioLook.client = ->(_) { { "ok" => false, "error" => "shape_changed", "iou" => 0.71 } }
    post api_v1_studio_looks_path, params: pictures, as: :json

    assert_response :unprocessable_entity
    assert_equal "shape_changed", response.parsed_body["error"]
  end

  test "turns away anything that isn't a PNG, without calling the studio" do
    StudioLook.client = ->(_) { flunk "the studio was called" }
    post api_v1_studio_looks_path, params: pictures.merge(depth: "data:image/gif;base64,R0lG"), as: :json

    assert_response :unprocessable_entity
    assert_equal "invalid", response.parsed_body["error"]
  end

  test "a studio that fails is a bad gateway, not a crash" do
    StudioLook.client = ->(_) { raise StudioLook::Error, "timeout" }
    post api_v1_studio_looks_path, params: pictures, as: :json

    assert_response :bad_gateway
  end

  test "unavailable without the studio's address and keys" do
    skip "this machine has the studio set up" if StudioLook.available?
    post api_v1_studio_looks_path, params: pictures, as: :json

    assert_response :service_unavailable
  end
end
