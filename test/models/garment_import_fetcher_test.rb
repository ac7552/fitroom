require "test_helper"

class GarmentImportFetcherTest < ActiveSupport::TestCase
  Fetcher = GarmentImport::Fetcher

  test "refuses links to this machine, private networks and cloud metadata" do
    %w[http://localhost/ http://127.0.0.1:3000/ http://10.0.0.5/ http://192.168.1.1/ http://169.254.169.254/latest/meta-data
       http://[::1]/].each do |url|
      error = assert_raises(Fetcher::Error, url) { Fetcher.get(url) }
      assert_match "private address", error.message
    end
  end

  test "refuses things that aren't web links" do
    [ "ftp://example.com/x", "javascript:alert(1)", "not a link", "" ].each do |url|
      assert_raises(Fetcher::Error, url) { Fetcher.get(url) }
    end
  end
end
