require "test_helper"

class Api::StudioPhotosControllerTest < ActionDispatch::IntegrationTest
  SNAPSHOT = {
    scale: 1.02,
    body: { "measure-bust-circ-incr" => 0.13, "measure-waist-circ-incr" => 0.5 },
    pose: "standing",
    items: [ { kind: "jacket", color: "#1f2a4a", ease: { "ease-chest" => 2, "ease-length" => 14 } },
             { kind: "trousers", color: "#73777f", ease: { "ease-inseam" => 6 } } ]
  }.freeze
  PNG = "\x89PNG\r\n\x1a\nfake".b

  setup do
    @jobs = []
    StudioPhoto.runner = lambda do |job_file|
      job = JSON.parse(File.read(job_file))
      @jobs << job
      File.binwrite(job["output"], PNG)
      true
    end
  end

  teardown do
    StudioPhoto.runner = nil
    StudioPhoto.try_on = nil
    StudioPhoto.reset!
  end

  def wait_until_done(id)
    50.times do
      get api_v1_studio_photo_path(id), as: :json
      return response.parsed_body if response.parsed_body["status"] == "done"
      sleep 0.02
    end
    flunk "render never finished"
  end

  test "with a shop photo and the box ticked, paints the exact item on too" do
    calls = []
    StudioPhoto.try_on = lambda do |png, photo, kind|
      calls << [ png, photo, kind ]
      "exact:#{kind}".b
    end
    photo = "data:image/png;base64,#{Base64.strict_encode64('jacket photo')}"
    snapshot = SNAPSHOT.merge(exact: true, items: [ SNAPSHOT[:items].first.merge(photo:) ])
    post api_v1_studio_photos_path, params: snapshot, as: :json
    assert response.parsed_body["exact"]
    id = response.parsed_body["id"]

    50.times do
      get api_v1_studio_photo_path(id), as: :json
      break if response.parsed_body["exact"] == "done"
      sleep 0.02
    end
    assert_equal [ [ PNG, photo, "jacket" ] ], calls
    refute @jobs.sole.dig("items", 0).key?("photo"), "shop photos never go to Blender's job file"

    get image_api_v1_studio_photo_path(id, variant: "exact")
    assert_equal "exact:jacket", response.body
    get image_api_v1_studio_photo_path(id)
    assert_equal PNG, response.body
    get api_v1_studio_photo_path(id), as: :json
    assert_response :not_found
  end

  CHECKS = {
    "shape" => { "score" => 0.93, "threshold" => 0.85, "pass" => true },
    "identity" => { "score" => 0.88, "colour" => 3.1, "threshold" => 0.8, "colour_threshold" => 12.0, "pass" => true },
    "print" => { "skipped" => true, "score" => nil, "threshold" => 0.45, "pass" => true },
    "ok" => true
  }.freeze

  def wait_for_exact(id)
    50.times do
      get api_v1_studio_photo_path(id), as: :json
      return response.parsed_body if %w[done failed refused].include?(response.parsed_body["exact"])
      sleep 0.02
    end
    flunk "the exact image never finished"
  end

  test "with Fitroom's own try-on, the checks ride along with the status, one entry per garment" do
    StudioPhoto.try_on = ->(_png, _photo, kind) { TryOn::Result.new("exact:#{kind}".b, CHECKS.merge("kind" => kind)) }
    photo = "data:image/jpeg;base64,#{Base64.strict_encode64('photo')}"
    items = SNAPSHOT[:items].map { it.merge(photo:) }
    post api_v1_studio_photos_path, params: SNAPSHOT.merge(exact: true, items:), as: :json
    id = response.parsed_body["id"]

    status = wait_for_exact(id)
    assert_equal "done", status["exact"]
    assert_equal %w[jacket trousers], status["exact_checks"].keys.sort
    assert_equal 0.93, status["exact_checks"].dig("jacket", "shape", "score")

    get image_api_v1_studio_photo_path(id, variant: "exact")
    assert_equal "exact:trousers", response.body, "the trousers are painted onto the jacket's result"
  end

  test "when every garment is refused, there's no exact image, the checks say why, and the draped one stays" do
    refused = CHECKS.merge("shape" => { "score" => 0.62, "threshold" => 0.85, "pass" => false }, "ok" => false)
    StudioPhoto.try_on = ->(_png, _photo, _kind) { TryOn::Result.new(nil, refused) }
    photo = "data:image/jpeg;base64,#{Base64.strict_encode64('photo')}"
    post api_v1_studio_photos_path, params: SNAPSHOT.merge(exact: true, items: [ SNAPSHOT[:items].first.merge(photo:) ]), as: :json
    id = response.parsed_body["id"]

    status = wait_for_exact(id)
    assert_equal "refused", status["exact"]
    assert_equal false, status["exact_checks"].dig("jacket", "shape", "pass")

    get image_api_v1_studio_photo_path(id, variant: "exact")
    assert_response :not_found
    get image_api_v1_studio_photo_path(id)
    assert_equal PNG, response.body
  end

  test "one refused garment leaves that garment as rendered and paints the rest" do
    StudioPhoto.try_on = lambda do |png, _photo, kind|
      kind == "jacket" ? TryOn::Result.new(nil, CHECKS.merge("ok" => false)) : TryOn::Result.new("#{png}+#{kind}".b, CHECKS)
    end
    photo = "data:image/jpeg;base64,#{Base64.strict_encode64('photo')}"
    post api_v1_studio_photos_path, params: SNAPSHOT.merge(exact: true, items: SNAPSHOT[:items].map { it.merge(photo:) }), as: :json
    id = response.parsed_body["id"]

    assert_equal "done", wait_for_exact(id)["exact"]
    get image_api_v1_studio_photo_path(id, variant: "exact")
    assert_equal "#{PNG}+trousers".b, response.body
  end

  test "renders a snapshot, then hands the image over once" do
    post api_v1_studio_photos_path, params: SNAPSHOT, as: :json
    assert_response :accepted
    id = response.parsed_body["id"]

    assert_equal "done", wait_until_done(id)["status"]
    assert_equal "standing", @jobs.sole["pose"]
    assert_equal({ "ease-chest" => 2.0, "ease-length" => 14.0 }, @jobs.sole["items"].first["ease"])

    get image_api_v1_studio_photo_path(id)
    assert_response :success
    assert_equal "image/png", response.media_type
    assert_equal PNG, response.body

    get image_api_v1_studio_photo_path(id)
    assert_response :not_found
  end

  test "rejects shapes and garments it doesn't know" do
    bad = SNAPSHOT.merge(pose: "dabbing", body: { "rm -rf" => 1 }, items: [ { kind: "hat", color: "red", ease: {} } ])
    post api_v1_studio_photos_path, params: bad, as: :json

    assert_response :unprocessable_entity
    assert_equal %w[body items.0.color items.0.kind pose], response.parsed_body["errors"].keys.sort
  end

  test "passes a jacket's style through, and turns away styles it doesn't draw" do
    zip = SNAPSHOT.merge(items: [ SNAPSHOT[:items].first.merge(style: "zip", fabric: "leather") ])
    post api_v1_studio_photos_path, params: zip, as: :json
    assert_equal "done", wait_until_done(response.parsed_body["id"])["status"]
    assert_equal [ "zip", "leather" ], @jobs.sole["items"].first.values_at("style", "fabric")

    post api_v1_studio_photos_path, params: SNAPSHOT.merge(items: [ SNAPSHOT[:items].first.merge(style: "cape") ]), as: :json
    assert_response :unprocessable_entity
    assert_equal [ "items.0.style" ], response.parsed_body["errors"].keys
  end

  test "says so when Blender isn't there" do
    StudioPhoto.runner = nil
    ENV["FITROOM_BLENDER"] = "/nowhere/blender"
    post api_v1_studio_photos_path, params: SNAPSHOT, as: :json
    assert_response :service_unavailable
  ensure
    ENV.delete("FITROOM_BLENDER")
  end
end
