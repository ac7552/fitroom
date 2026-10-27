require "test_helper"
require_relative "../../support/fake_try_on_jobs"

class Api::TryOnsControllerTest < ActionDispatch::IntegrationTest
  PHOTO = "data:image/jpeg;base64,#{Base64.strict_encode64('shop photo')}".freeze
  PAGE = "data:image/png;base64,#{Base64.strict_encode64("\x89PNG\r\n\x1a\npage".b)}".freeze
  CHECKS = { "shape" => { "score" => 0.93, "threshold" => 0.85, "pass" => true }, "ok" => true }.freeze
  DONE = { "status" => "done", "ok" => true, "image" => Base64.strict_encode64("painted"), "checks" => CHECKS }.freeze

  teardown do
    TryOn.client = nil
    TryOn.sleeper = nil
    TryOn.reset!
    TryOnJob.reset!
  end

  def start_one
    post api_v1_try_ons_path, params: { photo: PAGE, items: [ { kind: "top", photo: PHOTO } ] }, as: :json
    response.parsed_body["job"]
  end

  test "starts a job at once, then hands over the painted picture and its checks" do
    TryOn.client = FakeTryOnJobs.new(DONE)
    TryOn.sleeper = ->(_) { }

    job = start_one
    assert_response :accepted
    assert_equal "no-store", response.headers["Cache-Control"]
    TryOnJob.wait(job)

    get api_v1_try_on_path(job), as: :json
    assert_response :success
    assert_equal "done", response.parsed_body["status"]
    assert_equal "data:image/png;base64,#{Base64.strict_encode64('painted')}", response.parsed_body["image"]
    assert_equal CHECKS, response.parsed_body["checks"]["top"]

    get api_v1_try_on_path(job), as: :json
    assert_response :not_found
  end

  test "a job still waiting for its GPU says so, with the seconds so far" do
    gate = Queue.new
    TryOn.client = FakeTryOnJobs.new(DONE)
    TryOn.sleeper = ->(_) { gate.pop }

    job = start_one
    get api_v1_try_on_path(job), as: :json

    assert_response :success
    assert_equal "starting", response.parsed_body["status"]
    assert_equal 0, response.parsed_body["seconds"]
    assert_equal %w[top], response.parsed_body["layers"]
  ensure
    gate << :go
    TryOnJob.wait(job) if job
  end

  test "Stop cancels the job and the service's call" do
    gate = Queue.new
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs
    TryOn.sleeper = ->(_) { gate.pop }

    job = start_one
    sleep 0.01 until jobs.started.any?
    delete api_v1_try_on_path(job), as: :json
    assert_response :success
    assert_equal "cancelled", response.parsed_body["status"]
    gate << :go
    TryOnJob.wait(job)

    assert_includes jobs.cancelled, "fc-1"
    get api_v1_try_on_path(job), as: :json
    assert_equal "cancelled", response.parsed_body["status"]

    delete api_v1_try_on_path("nope"), as: :json
    assert_response :not_found
  end

  test "a picture it can't read is a 422, before any job" do
    TryOn.client = ->(_) { flunk "the service was called" }
    post api_v1_try_ons_path, params: { photo: "nope", items: [ { kind: "top", photo: PHOTO } ] }, as: :json
    assert_response :unprocessable_entity
    assert_equal "photo", response.parsed_body["field"]
  end

  test "a service that doesn't answer is a failed job with words for the page" do
    TryOn.client = ->(_) { raise TryOn::Error, "Net::ReadTimeout" }

    job = start_one
    TryOnJob.wait(job)
    get api_v1_try_on_path(job), as: :json

    assert_response :success
    assert_equal "failed", response.parsed_body["status"]
    assert_match(/didn't work/, response.parsed_body["message"])
  end

  test "an unknown job is a 404" do
    get api_v1_try_on_path("nope"), as: :json
    assert_response :not_found
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
