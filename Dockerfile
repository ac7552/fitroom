# Fitroom on one small server (a DigitalOcean droplet, say): Rails in production, serving the page and the
# JSON API; SQLite in storage/ (nothing is kept there yet: no accounts, no measurements). See docs/droplet.md.
#
#   docker build -t fitroom .
#   docker run -p 3000:3000 -e SECRET_KEY_BASE=... fitroom
ARG RUBY_VERSION=3.4.3
FROM ruby:${RUBY_VERSION}-slim AS base
WORKDIR /rails
ENV RAILS_ENV=production BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle BUNDLE_WITHOUT="development test"
RUN apt-get update -qq && apt-get install --no-install-recommends -y curl libjemalloc2 libsqlite3-0 && rm -rf /var/lib/apt/lists/*

FROM base AS build
RUN apt-get update -qq && apt-get install --no-install-recommends -y build-essential git libyaml-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock ./
RUN gem install bundler -v "$(tail -n 1 Gemfile.lock | tr -d ' ')" && bundle install && rm -rf ~/.bundle "${BUNDLE_PATH}"/ruby/*/cache && bundle exec bootsnap precompile --gemfile
COPY . .
RUN bundle exec bootsnap precompile app/ lib/
# The assets as the page serves them (propshaft digests them; the importmap pins the JavaScript as is).
RUN SECRET_KEY_BASE_DUMMY=1 ./bin/rails assets:precompile

FROM base
COPY --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=build /rails /rails
RUN groupadd --system --gid 1000 rails && useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash && \
    chown -R rails:rails db log storage tmp
USER 1000:1000
ENV LD_PRELOAD=/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2 RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1
ENTRYPOINT ["/rails/bin/docker-entrypoint"]
EXPOSE 3000
CMD ["./bin/rails", "server", "-b", "0.0.0.0"]
