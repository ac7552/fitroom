# The AI picture as a job, so no browser request waits on a GPU: `start` checks the page's pictures and
# answers at once with an id; a background thread paints the layers in order (the outermost top, then the
# trousers onto that: each needs the last one's picture, see TryOn.paint), and the page asks `status` every
# second or two until it's done. `cancel` (the page's Stop) stops it here and cancels the call on the
# service, so it doesn't keep holding a GPU.
#
# Like StudioPhoto, everything lives in this process's memory: nothing is written to disk, the database or
# the logs. A finished picture is handed over once and forgotten; anything left is swept after MAX_AGE.
class TryOnJob
  class Busy < StandardError; end

  MAX_AGE = 10.minutes
  MAX_RUNNING = 4 # pictures being painted at once (the service has 2 GPUs; the rest wait their turn there)
  RUNNING = %w[starting painting].freeze

  @jobs = {}
  @registry = Mutex.new # guards @jobs

  class << self
    # Checks the pictures (raises TryOn::Invalid before anything starts) and starts painting. Returns the
    # job's id. Raises Busy when MAX_RUNNING are already being painted.
    def start(photo:, items:, outline: nil)
      prepared = TryOn.prepare(photo:, items:, outline:)
      sweep
      id = SecureRandom.urlsafe_base64(18)
      @registry.synchronize do
        raise Busy if @jobs.count { |_, job| RUNNING.include?(job[:status]) } >= MAX_RUNNING

        @jobs[id] = { status: "starting", created_at: Time.current, began: TryOn.now, layers: prepared[:layers], cancelled: false }
        @jobs[id][:thread] = Thread.new { run(id, prepared) }
      end
      id
    end

    # {status: "starting" | "painting" | "done" | "failed" | "cancelled", seconds, layer, layers}; once
    # done also {image (data URL, or nil when every garment was refused), checks, painted}, and the job is
    # forgotten; once failed, {message}. nil for a job it doesn't know.
    def status(id)
      sweep
      job = @registry.synchronize do
        found = @jobs[id]
        @jobs.delete(id) if found && found[:status] == "done"
        found&.dup
      end
      return unless job

      seconds = ((job[:finished] || TryOn.now) - job[:began]).round
      out = { status: job[:status], seconds:, layer: job[:layer], layers: job[:layers] }.compact
      out.merge!(job[:result].slice(:image, :checks, :painted)) if job[:status] == "done"
      out[:message] = job[:message] if job[:status] == "failed"
      out
    end

    # Stops a job: the thread gives up at its next look (within a few seconds) and the service's call is
    # cancelled now. false for a job it doesn't know.
    def cancel(id)
      call = @registry.synchronize do
        job = @jobs[id] or return false
        next unless RUNNING.include?(job[:status])

        job.merge!(cancelled: true, status: "cancelled", finished: TryOn.now)
        job[:call]
      end
      TryOn.cancel(call) if call
      true
    end

    # Waits for a job's thread (for the tests).
    def wait(id) = @registry.synchronize { @jobs[id]&.[](:thread) }&.join

    def reset! = @registry.synchronize { @jobs.clear }

    private

    def run(id, prepared)
      watch = TryOn::Watch.new(
        cancelled: -> { @registry.synchronize { @jobs[id].nil? || @jobs[id][:cancelled] } },
        started: ->(call) { update(id, call:) },
        phase: ->(phase) { update(id, status: phase) },
        layer: ->(kind) { update(id, layer: kind, status: "starting") }
      )
      result = TryOn.paint(prepared, watch:)
      update(id, status: "done", result:, finished: TryOn.now)
    rescue TryOn::Cancelled
      update(id, status: "cancelled", finished: TryOn.now)
    rescue TryOn::Error, KeyError => e
      Rails.logger.error("[try-on] #{e.class}: #{e.message.to_s[0, 300]}")
      update(id, status: "failed", finished: TryOn.now, message: e.message.include?("too long") ? "The AI took too long this time. Here's our own." : "The AI picture didn't work this time. Here's our own.")
    rescue StandardError => e
      Rails.logger.error("[try-on] #{e.class}: #{e.message.to_s[0, 300]}")
      update(id, status: "failed", finished: TryOn.now, message: "The AI picture didn't work this time. Here's our own.")
    end

    # A cancelled job stays cancelled whatever the thread says next.
    def update(id, changes)
      @registry.synchronize do
        job = @jobs[id] or next
        next if job[:cancelled] && changes[:status] && changes[:status] != "cancelled"

        job.merge!(changes)
      end
    end

    # Forget jobs nobody came back for (a running one is cancelled by this: its watch sees it gone).
    def sweep
      @registry.synchronize { @jobs.delete_if { |_, job| job[:created_at] < MAX_AGE.ago } }
    end
  end
end
