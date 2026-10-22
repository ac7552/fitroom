require "open3"

# Photoreal renders of one outfit on one body, made by Blender on request (script/render/studio.py): the
# clothes are draped by cloth simulation and path-traced, which the page's real-time view can only imitate.
#
# With the person's say-so and a FASHN key on the server, a second image follows: the shops' own photos of
# the garments painted onto that render by AI try-on (see TryOn), so it shows the exact items.
#
# Renders run one at a time in a background thread. Everything about a render lives in this process's
# memory and a temporary folder: the job file is deleted when Blender is done, the image when it's
# fetched, and anything unfetched after MAX_AGE. Nothing reaches the database or the logs.
class StudioPhoto
  class Unavailable < StandardError; end
  class Invalid < StandardError
    attr_reader :errors

    def initialize(errors)
      @errors = errors
      super("invalid studio photo")
    end
  end

  KINDS = %w[jacket coat trousers].freeze
  FABRICS = %w[wool cotton denim leather nylon].freeze
  STYLES = %w[tailored zip bomber shirt].freeze
  MAX_AGE = 10.minutes
  TIMEOUT = 240 # seconds
  CALIBRATION = Rails.root.join("public/models/mannequin.json")
  POSES = Rails.root.join("public/models/poses.json")
  PHOTO = %r{\Adata:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+\z}
  MAX_PHOTO = 4_000_000 # characters of data: URL

  @jobs = {}
  @registry = Mutex.new  # guards @jobs
  @renderer = Mutex.new  # one render at a time

  class << self
    attr_writer :runner, :try_on

    def blender = ENV.fetch("FITROOM_BLENDER", "/Applications/Blender.app/Contents/MacOS/Blender")
    def available? = runner_given? || File.executable?(blender)
    def try_on = @try_on || TryOn.method(:call)
    def exact_available? = !@try_on.nil? || TryOn.available?

    # Checks a snapshot of the stage and starts rendering it. Returns the job's id, and whether an
    # exact-item image will follow.
    def start(snapshot)
      raise Unavailable unless available?

      job, photos = validate(snapshot)
      exact = snapshot[:exact] == true && photos.any? && exact_available?
      sweep
      id = SecureRandom.urlsafe_base64(18)
      @registry.synchronize { @jobs[id] = { status: "queued", created_at: Time.current, images: {}, exact: exact ? "pending" : nil } }
      Thread.new { render(id, job, exact ? photos : {}) }
      [ id, exact ]
    end

    # "queued", "rendering", "done" or "failed", with how many renders are ahead while queued.
    def status(id)
      sweep
      job = @registry.synchronize { @jobs[id]&.dup }
      return unless job

      ahead = @registry.synchronize { @jobs.count { |_, j| j[:status] == "queued" && j[:created_at] < job[:created_at] } }
      { status: job[:status], ahead: (ahead if job[:status] == "queued"), exact: job[:exact] }.compact
    end

    # A finished PNG ("draped", or "exact" for the try-on), once each. The job is gone once both are taken.
    def take_image(id, variant = "draped")
      path, dir = @registry.synchronize do
        job = @jobs[id]
        next unless job && %w[done styling].include?(job[:status]) && job[:images][variant]

        found = job[:images].delete(variant)
        @jobs.delete(id) if job[:images].empty? && job[:exact] != "pending"
        [ found, (job[:dir] unless @jobs.key?(id)) ]
      end
      return unless path

      File.binread(path).tap do
        FileUtils.rm_f(path)
        FileUtils.rm_rf(dir) if dir
      end
    end

    def runner = @runner || method(:run_blender)
    def runner_given? = !@runner.nil?

    def reset!
      @registry.synchronize { @jobs.each_value { FileUtils.rm_rf(it[:dir]) if it[:dir] }.clear }
    end

    private

    def render(id, job, photos = {})
      @renderer.synchronize do
        dir = Dir.mktmpdir("fitroom-studio-")
        update(id, status: "rendering", dir:)
        image = File.join(dir, "studio.png")
        job_file = File.join(dir, "job.json")
        File.write(job_file, JSON.generate(job.merge(output: image)))
        ok = runner.call(job_file)
        FileUtils.rm_f(job_file)
        unless ok && File.exist?(image)
          update(id, status: "failed", exact: nil)
          next
        end
        @registry.synchronize { @jobs[id]&.then { it[:images]["draped"] = image } }
        update(id, status: photos.any? ? "styling" : "done")
        dress_exactly(id, dir, image, photos) if photos.any?
      end
    rescue StandardError => e
      Rails.logger.error("[studio photo] #{e.class}")
      update(id, status: "failed")
    end

    # The outer top (a coat over a jacket) first, then the trousers, each painted onto the last result.
    def dress_exactly(id, dir, image, photos)
      picture = File.binread(image)
      %w[coat jacket trousers].each do |kind|
        next unless photos[kind]
        next if kind == "jacket" && photos["coat"]

        picture = try_on.call(picture, photos[kind], kind)
      end
      exact = File.join(dir, "exact.png")
      File.binwrite(exact, picture)
      @registry.synchronize { @jobs[id]&.then { it[:images]["exact"] = exact } }
      update(id, status: "done", exact: "done")
    rescue StandardError => e
      Rails.logger.error("[studio photo] try-on #{e.class}")
      update(id, status: "done", exact: "failed")
    end

    def run_blender(job_file)
      command = [ blender, "-b", "--python", Rails.root.join("script/render/studio.py").to_s, "--", job_file ]
      Open3.popen2e(*command) do |stdin, output, wait|
        stdin.close
        reader = Thread.new { output.read }
        unless wait.join(TIMEOUT)
          Process.kill("KILL", wait.pid)
          return false
        end
        reader.join
        wait.value.success?
      end
    end

    def update(id, changes)
      @registry.synchronize { @jobs[id]&.merge!(changes) }
    end

    # Forget renders nobody fetched.
    def sweep
      stale = @registry.synchronize { @jobs.select { |_, j| j[:created_at] < MAX_AGE.ago && j[:status] != "rendering" }.keys.map { @jobs.delete(it) } }
      stale.each { FileUtils.rm_rf(it[:dir]) if it[:dir] }
    end

    def validate(snapshot)
      errors = {}
      body_keys = JSON.parse(File.read(CALIBRATION))["targets"].keys
      ease_keys = JSON.parse(File.read(CALIBRATION))["ease_check"].keys
      poses = JSON.parse(File.read(POSES))["poses"].keys

      scale = Float(snapshot[:scale], exception: false)
      errors[:scale] = "must be between 0.6 and 1.6" unless scale&.between?(0.6, 1.6)
      body = weights(snapshot[:body], body_keys, 0..2, errors, :body)
      pose = snapshot[:pose].to_s
      errors[:pose] = "must be one of #{poses.join(', ')}" unless poses.include?(pose)

      given = snapshot[:items].is_a?(Array) ? snapshot[:items] : []
      photos = {}
      errors[:items] = "must list 1 to 3 garments" unless given.size.between?(1, 3)
      items = given.first(3).each_with_index.map do |item, i|
        kind = item[:kind].to_s
        errors[:"items.#{i}.kind"] = "must be one of #{KINDS.join(', ')}" unless KINDS.include?(kind)
        color = item[:color].to_s
        errors[:"items.#{i}.color"] = "must be a colour like #1f2a4a" unless color.match?(/\A#\h{6}\z/)
        photo = item[:photo].to_s
        if photo.present?
          valid = photo.size <= MAX_PHOTO && photo.match?(PHOTO)
          errors[:"items.#{i}.photo"] = "must be a PNG, JPEG or WebP data: URL under 3 MB" unless valid
          photos[kind] = photo if valid
        end
        fabric = item[:fabric].presence || "wool"
        errors[:"items.#{i}.fabric"] = "must be one of #{FABRICS.join(', ')}" unless FABRICS.include?(fabric)
        style = kind == "jacket" ? item[:style].presence || "tailored" : "tailored"
        errors[:"items.#{i}.style"] = "must be one of #{STYLES.join(', ')}" unless STYLES.include?(style)
        { kind:, style:, color:, fabric:, ease: weights(item[:ease], ease_keys, -30..30, errors, :"items.#{i}.ease") }
      end
      errors[:items] ||= "can have one of each kind" if items.map { it[:kind] }.uniq.size < items.size
      raise Invalid, errors if errors.any?

      [ { scale:, body:, pose:, items:, samples: 64 }, photos ]
    end

    def weights(given, allowed, range, errors, field)
      given = given.respond_to?(:to_unsafe_h) ? given.to_unsafe_h : given.to_h
      given.each_with_object({}) do |(key, value), out|
        number = Float(value, exception: false)
        if !allowed.include?(key.to_s) || number.nil? || !range.cover?(number)
          errors[field] = "has an unknown shape or a value out of range"
        else
          out[key.to_s] = number
        end
      end
    end
  end
end
