require "net/http"
require "resolv"
require "ipaddr"

class GarmentImport
  # Fetches one product page that someone pasted. Because the URL comes from outside, it only talks to
  # public addresses (no localhost, private networks or cloud metadata), pins the connection to the address
  # it checked, re-checks every redirect, and stops at a size and time limit.
  class Fetcher
    class Error < StandardError; end
    # The store wouldn't give its page: it turns apps away, answered with an error page, or couldn't be
    # reached. The link was right, so its own words can still say what the garment is (see
    # GarmentImport.from_link). reason: what happened, to tell the person ("therealreal.com doesn't let apps
    # read its pages").
    class GaveUp < Error
      attr_reader :reason

      def initialize(message, reason:)
        @reason = reason
        super(message)
      end
    end
    # The site didn't answer in time; asking it again (for another address on it) would only wait as long.
    class TooSlow < GaveUp; end

    # Sites known to turn away every app (they answer only people's browsers), so there's no waiting on them.
    TURNS_AWAY = %w[therealreal.com].freeze

    MAX_BYTES = 3_000_000
    MAX_REDIRECTS = 3
    TIMEOUT = 8
    # However the site answers (slowly, a little at a time, through redirects), one fetch gives up after this.
    DEADLINE = 15
    USER_AGENT = "Fitroom/1.0 (reads one product page's size chart when a person asks)"
    BLOCKED = %w[
      0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16
      198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8
    ].map { IPAddr.new(it) }.freeze

    ACCEPT = { page: "text/html,application/xhtml+xml", image: "image/webp,image/jpeg,image/png", json: "application/json" }.freeze
    IMAGE_TYPES = %r{\Aimage/(jpeg|png|webp)\z}
    BOT_CHECK = /bm-verify|_Incapsula_Resource|cf-chl|challenge-platform|px-captcha|Pardon Our Interruption|Access to this page has been denied/i
    MAX_IMAGE_BYTES = 2_500_000

    def self.get(url) = new.get(url)

    # A product photo, with the same checks as a page: public addresses only, size and time limited.
    # Returns [bytes, content type]. max_bytes and types (a pattern for the content type) can be widened,
    # as the image proxy does.
    def self.get_image(url, max_bytes: MAX_IMAGE_BYTES, types: IMAGE_TYPES) = new(image_bytes: max_bytes, image_types: types).get(url, image: true)

    # A JSON API that a shop's page loads its size chart from (see Page#kiwi_sizing), parsed.
    def self.get_json(url) = JSON.parse(new.get(url, json: true))

    def initialize(image_bytes: MAX_IMAGE_BYTES, image_types: IMAGE_TYPES)
      @image_bytes = image_bytes
      @image_types = image_types
    end

    def get(url, redirects = 0, image: false, json: false)
      @deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + DEADLINE
      Timeout.timeout([ @deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0.5 ].max) { fetch(url, redirects, image:, json:) }
    rescue Timeout::Error
      raise TooSlow.new("That page took too long to answer. Try again, or paste its size chart, or just its size (like M), " \
                        "under \"Other ways to add clothes\".", reason: "#{site(url)} took too long to answer")
    end

    def self.turned_away(host)
      TURNS_AWAY.find { host.to_s.downcase == it || host.to_s.downcase.end_with?(".#{it}") }
    end

    def self.turned_away_message(host)
      "#{host.to_s.delete_prefix('www.')} doesn't let apps read its pages. Paste its size chart, or just its size (like M), " \
        "under \"Other ways to add clothes\"."
    end

    def self.turned_away_error(host)
      GaveUp.new(turned_away_message(host), reason: "#{host.to_s.downcase.delete_prefix('www.')} doesn't let apps read its pages")
    end

    # The site's name as people say it: "therealreal.com".
    def self.site(url) = (URI.parse(url.to_s.strip).host.to_s.downcase.delete_prefix("www.").presence rescue nil) || "The store"

    private

    def fetch(url, redirects, image:, json:)
      uri = parse(url)
      raise self.class.turned_away_error(uri.hostname) if self.class.turned_away(uri.hostname)
      http = connect(uri, resolve(uri.hostname))

      request = Net::HTTP::Get.new(uri)
      request["User-Agent"] = USER_AGENT
      request["Accept"] = ACCEPT[image ? :image : json ? :json : :page]

      begin
        http.request(request) do |response|
          case response
          when Net::HTTPRedirection
            raise GaveUp.new("That page redirects too many times.", reason: "#{site(uri)} kept sending us elsewhere") if redirects >= MAX_REDIRECTS
            return fetch(URI.join(uri, response["location"]).to_s, redirects + 1, image:, json:)
          when Net::HTTPSuccess
            return image ? read_image(response) : read_body(response, json:)
          when Net::HTTPForbidden, Net::HTTPUnauthorized, Net::HTTPTooManyRequests, Net::HTTPServiceUnavailable
            # Big shops often turn away any reader that isn't a person's browser. Fitroom doesn't pretend to be one.
            raise self.class.turned_away_error(uri.hostname)
          else
            raise GaveUp.new("The shop's site answered #{response.code}. Check the link, or paste the size chart instead.",
                             reason: "#{site(uri)} answered with an error page")
          end
        end
      ensure
        http.finish if http.started?
      end
    rescue Timeout::Error, SocketError, OpenSSL::SSL::SSLError, SystemCallError, Net::HTTPBadResponse => e
      raise GaveUp.new("Couldn't load that page (#{e.class.name.demodulize}).", reason: "#{site(url)} couldn't be reached")
    end

    def site(url) = self.class.site(url)

    def parse(url)
      uri = URI.parse(url.to_s.strip)
      raise Error, "That doesn't look like a web link." unless uri.is_a?(URI::HTTP) && uri.host.present?

      uri
    rescue URI::InvalidURIError
      raise Error, "That doesn't look like a web link."
    end

    def resolve(host)
      addresses = Resolv.getaddresses(host)
      raise Error, "Couldn't find that website." if addresses.empty?

      allowed = addresses.select { allowed?(it) }
      raise Error, "That link points to a private address." if allowed.empty?

      allowed
    end

    # Opens a connection to the first checked address that answers.
    def connect(uri, addresses)
      addresses.each_with_index do |address, index|
        http = Net::HTTP.new(uri.host, uri.port)
        http.ipaddr = address
        http.use_ssl = uri.scheme == "https"
        http.open_timeout = http.read_timeout = TIMEOUT
        return http.tap(&:start)
      rescue SystemCallError, Net::OpenTimeout
        raise if index == addresses.size - 1
      end
    end

    def allowed?(address)
      return true if Rails.configuration.x.garment_import.allow_private_hosts

      ip = IPAddr.new(address)
      ip = ip.native if ip.ipv4_mapped?
      BLOCKED.none? { it.include?(ip) }
    rescue IPAddr::InvalidAddressError
      false
    end

    def read_image(response)
      type = response["content-type"].to_s.split(";").first.to_s.strip
      raise Error, "That isn't a photo." unless type.match?(@image_types)

      bytes = +"".b
      response.read_body do |chunk|
        bytes << chunk
        raise Error, "That photo is too big." if bytes.bytesize > @image_bytes
      end
      [ bytes, type ]
    end

    def read_body(response, json: false)
      unless response["content-type"].to_s.match?(json ? %r{application/json} : %r{text/html|application/xhtml})
        raise Error, json ? "The shop's size chart service didn't answer with a chart." : "That link isn't a web page."
      end

      body = +""
      response.read_body do |chunk|
        body << chunk
        raise GaveUp.new("That page is too big to read.", reason: "#{site(response.uri)} sent a page too big to read") if body.bytesize > MAX_BYTES
      end
      encoding = Encoding.find(response.type_params["charset"] || "UTF-8") rescue Encoding::UTF_8
      body = body.force_encoding(encoding).encode("UTF-8", invalid: :replace, undef: :replace)
      # Some shops answer with a bot check instead of the page (and a 200). Fitroom doesn't try to pass them.
      raise self.class.turned_away_error(response.uri&.host) if !json && body.size < 20_000 && body.match?(BOT_CHECK)
      body
    end
  end
end
