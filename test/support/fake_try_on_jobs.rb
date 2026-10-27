# Stands in for TryOn::Jobs (the try-on service's jobs app): `start` hands out fc-1, fc-2, ...; `result`
# gives the queued answers in turn (an exception in the queue is raised; pending once they run out), and
# `cancel` is noted. Thread-safe, for TryOnJob's background thread.
class FakeTryOnJobs
  PENDING = { "status" => "pending", "phase" => "starting" }.freeze

  attr_reader :started, :cancelled, :polls

  def initialize(*answers, &answer)
    @answers, @answer = answers, answer
    @started, @cancelled, @polls = [], [], 0
    @lock = Mutex.new
  end

  def start(body)
    @lock.synchronize do
      @started << body
      "fc-#{@started.size}"
    end
  end

  def result(id)
    found = @lock.synchronize do
      @polls += 1
      @answer ? @answer.call(id, @started[id.delete_prefix('fc-').to_i - 1]) : (@answers.shift || PENDING)
    end
    raise found if found.is_a?(Exception)

    found
  end

  def cancel(id) = @lock.synchronize { @cancelled << id }
end
