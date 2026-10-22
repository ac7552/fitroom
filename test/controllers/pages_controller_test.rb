require "test_helper"

class PagesControllerTest < ActionDispatch::IntegrationTest
  test "home page renders the hero and the fitting room" do
    get root_path
    assert_response :success
    assert_select "[data-controller~=hero] canvas"
    assert_select "[data-controller~=fitting-room]"
  end

  test "measurement inputs have no names, so the browser never submits or remembers them" do
    get root_path
    assert_select "[data-fitting-room-target=input]" do |inputs|
      inputs.each do |input|
        assert_nil input["name"]
        assert_equal "off", input["autocomplete"]
      end
    end
  end
end
