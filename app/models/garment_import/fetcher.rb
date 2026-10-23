require "net/http"
require "resolv"
require "ipaddr"

class GarmentImport
  # Fetches one product page that someone pasted. Because the URL comes from outside, it only talks to
  # public addresses (no localhost, private networks or cloud metadata), pins the connection to the address
  # it checked, re-checks every redirect, and stops at a size and time limit.
  class Fetcher
    class Error < StandardError; end
    # The site didn't answer in time; asking it again (for another address on it) would only wait as long.
    class TooSlow < Error; end

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
    # Returns [bytes, content type].
    def self.get_image(url) = new.get(url, image: true)

    # A JSON API that a shop's page loads its size chart from (see Page#kiwi_sizing), parsed.
    def self.get_json(url) = JSON.parse(new.get(url, json: true))

    def get(url, redirects = 0, image: false, json: false)
      @deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + DEADLINE
      Timeout.timeout([ @deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0.5 ].max) { fetch(url, redirects, image:, json:) }
    rescue Timeout::Error
      raise TooSlow, "That page took too long to answer. Try again, or paste its size chart, or just its size (like M), " \
                     "under \"Other ways to add clothes\"."
    end

    def self.turned_away(host)
      TURNS_AWAY.find { host.to_s.downcase == it || host.to_s.downcase.end_with?(".#{it}") }
    end

    def self.turned_away_message(host)
      "#{host.to_s.delete_prefix('www.')} doesn't let apps read its pages. Paste its size chart, or just its size (like M), " \
        "under \"Other ways to add clothes\"."
    end

    private

    def fetch(url, redirects, image:, json:)
      uri = parse(url)
      raise Error, self.class.turned_away_message(uri.hostname) if self.class.turned_away(uri.hostname)
      http = connect(uri, resolve(uri.hostname))

      request = Net::HTTP::Get.new(uri)
      request["User-Agent"] = USER_AGENT
      request["Accept"] = ACCEPT[image ? :image : json ? :json : :page]

      begin
        http.request(request) do |response|
          case response
          when Net::HTTPRedirection
            raise Error, "That page redirects too many times." if redirects >= MAX_REDIRECTS
            return fetch(URI.join(uri, response["location"]).to_s, redirects + 1, image:, json:)
          when Net::HTTPSuccess
            return image ? read_image(response) : read_body(response, json:)
          when Net::HTTPForbidden, Net::HTTPUnauthorized, Net::HTTPTooManyRequests, Net::HTTPServiceUnavailable
            # Big shops often turn away any reader that isn't a person's browser. Fitroom doesn't pretend to be one.
            raise Error, "#{uri.hostname.delete_prefix('www.')} doesn't let apps read its pages. Paste its size chart, or just " \
                         "its size (like M), under \"Other ways to add clothes\"."
          else
            raise Error, "The shop's site answered #{response.code}. Check the link, or paste the size chart instead."
          end
        end
      ensure
        http.finish if http.started?
      end
    rescue Timeout::Error, SocketError, OpenSSL::SSL::SSLError, SystemCallError, Net::HTTPBadResponse => e
      raise Error, "Couldn't load that page (#{e.class.name.demodulize})."
    end

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
      raise Error, "That isn't a photo." unless type.match?(IMAGE_TYPES)

      bytes = +"".b
      response.read_body do |chunk|
        bytes << chunk
        raise Error, "That photo is too big." if bytes.bytesize > MAX_IMAGE_BYTES
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
        raise Error, "That page is too big to read." if body.bytesize > MAX_BYTES
      end
      encoding = Encoding.find(response.type_params["charset"] || "UTF-8") rescue Encoding::UTF_8
      body = body.force_encoding(encoding).encode("UTF-8", invalid: :replace, undef: :replace)
      # Some shops answer with a bot check instead of the page (and a 200). Fitroom doesn't try to pass them.
      if !json && body.size < 20_000 && body.match?(BOT_CHECK)
        raise Error, "#{response.uri&.host.to_s.delete_prefix('www.')} doesn't let apps read its pages. Paste its size chart, or just " \
                     "its size (like M), under \"Other ways to add clothes\"."
      end
      body
    end
  end
end
