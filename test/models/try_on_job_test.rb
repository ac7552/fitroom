require "test_helper"
require_relative "../support/fake_try_on_jobs"

class TryOnJobTest < ActiveSupport::TestCase
  PHOTO = "data:image/jpeg;base64,#{Base64.strict_encode64('shop photo')}".freeze
  PAGE = "data:image/png;base64,#{Base64.strict_encode64("\x89PNG\r\n\x1a\npage".b)}".freeze
  CHECKS = { "shape" => { "score" => 0.93, "threshold" => 0.85, "pass" => true }, "ok" => true }.freeze

  teardown do
    TryOn.client = nil
    TryOn.sleeper = nil
    TryOn.reset!
    TryOnJob.reset!
  end

  def done(image = "painted") = { "status" => "done", "ok" => true, "image" => Base64.strict_encode64(image), "checks" => CHECKS }
  def start(items = [ { kind: "top", photo: PHOTO } ]) = TryOnJob.start(photo: PAGE, items:)

  test "a picture is painted in the background and handed over once" do
    TryOn.client = FakeTryOnJobs.new(FakeTryOnJobs::PENDING, done)
    TryOn.sleeper = ->(_) { }

    id = start
    TryOnJob.wait(id)
    state = TryOnJob.status(id)

    assert_equal "done", state[:status]
    assert_equal "data:image/png;base64,#{Base64.strict_encode64('painted')}", state[:image]
    assert_equal({ "top" => CHECKS }, state[:checks])
    assert_equal %w[top], state[:painted]
    assert_kind_of Integer, state[:seconds]
    assert_nil TryOnJob.status(id)
  end

  test "while it waits it says which garment and whether the GPU is still starting" do
    gate = Queue.new
    TryOn.client = FakeTryOnJobs.new({ "status" => "pending", "phase" => "painting" }, done)
    TryOn.sleeper = ->(_) { gate.pop }

    id = start
    assert_equal "starting", TryOnJob.status(id)[:status]
    gate << :go
    sleep 0.01 until TryOnJob.status(id)[:status] == "painting"
    state = TryOnJob.status(id)
    assert_equal "top", state[:layer]
    assert_equal %w[top], state[:layers]

    gate << :go
    TryOnJob.wait(id)
    assert_equal "done", TryOnJob.status(id)[:status]
  end

  test "every garment refused is a done job without a picture" do
    TryOn.client = FakeTryOnJobs.new({ "status" => "done", "ok" => false, "checks" => CHECKS.merge("ok" => false) })
    TryOn.sleeper = ->(_) { }

    id = start
    TryOnJob.wait(id)
    state = TryOnJob.status(id)

    assert_equal "done", state[:status]
    assert state.key?(:image)
    assert_nil state[:image]
    assert_equal false, state[:checks]["top"]["ok"]
  end

  test "cancelling stops the job and cancels the service's call" do
    gate = Queue.new
    jobs = FakeTryOnJobs.new
    TryOn.client = jobs
    TryOn.sleeper = ->(_) { gate.pop }

    id = start
    sleep 0.01 until jobs.started.any?
    assert TryOnJob.cancel(id)
    assert_equal "cancelled", TryOnJob.status(id)[:status]
    gate << :go
    TryOnJob.wait(id)

    assert_includes jobs.cancelled, "fc-1"
    assert_equal "cancelled", TryOnJob.status(id)[:status]
    refute TryOnJob.cancel("nope")
  end

  test "a service that fails is a failed job with words for the page" do
    TryOn.client = FakeTryOnJobs.new({ "status" => "failed", "error" => "timeout" })
    TryOn.sleeper = ->(_) { }

    id = start
    TryOnJob.wait(id)
    state = TryOnJob.status(id)

    assert_equal "failed", state[:status]
    assert_match(/didn't work/, state[:message])
  end

  test "bad pictures are turned away before a job starts, and only so many run at once" do
    TryOn.client = FakeTryOnJobs.new
    gate = Queue.new
    TryOn.sleeper = ->(_) { gate.pop }

    assert_raises(TryOn::Invalid) { TryOnJob.start(photo: "nope", items: [ { kind: "top", photo: PHOTO } ]) }
    ids = Array.new(TryOnJob::MAX_RUNNING) { start }
    assert_raises(TryOnJob::Busy) { start }

    ids.each { TryOnJob.cancel(it) }
    TryOnJob::MAX_RUNNING.times { gate << :go }
    ids.each { TryOnJob.wait(it) }
  end
end
