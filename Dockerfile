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

# The page's photo tools (transformers.js and ONNX Runtime, MediaPipe, the pose and photo models), served by
# this server itself rather than CDNs (lib/hosted.js): fetched here, where the build has the internet. What
# can't be fetched is left out, and the page uses the CDN for that one.
FROM node:22-slim AS vendor
WORKDIR /vendor
COPY script/vendor/fetch.mjs ./
RUN npm install --no-audit --no-fund --prefix /vendor/pkg @huggingface/transformers@4.3.2 @mediapipe/tasks-vision@1.1.1 && \
    node fetch.mjs /vendor/pkg/node_modules /vendor/out

# Blender for studio photos (Cycles on the CPU), only with STUDIO=1 (deploy/.env's FITROOM_STUDIO): see
# deploy/studio/README.md for the two files to put beside it first.
FROM base AS studio
ARG STUDIO=0
ARG BLENDER_VERSION=5.2.0
COPY deploy/studio/ /tmp/studio/
RUN mkdir -p /opt/blender && if [ "$STUDIO" = "1" ]; then \
      apt-get update -qq && apt-get install --no-install-recommends -y xz-utils libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 \
        libxkbcommon0 libsm6 libice6 libgl1 libegl1 libglu1-mesa && rm -rf /var/lib/apt/lists/* && \
      series=$(echo "$BLENDER_VERSION" | cut -d. -f1,2) && \
      curl -fsSL "https://download.blender.org/release/Blender${series}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt/blender --strip-components=1 && \
      test -f /tmp/studio/mpfb.zip -a -f /tmp/studio/makehuman_system_assets.zip || { echo "deploy/studio needs mpfb.zip and makehuman_system_assets.zip (see its README)"; exit 1; } && \
      HOME=/opt/blender-home /opt/blender/blender -b --command extension install-file -r user_default -e /tmp/studio/mpfb.zip && \
      data=$(HOME=/opt/blender-home /opt/blender/blender -b --python-expr "from bl_ext.user_default.mpfb.services.locationservice import LocationService as L; print('DATA=' + L.get_user_data())" 2>/dev/null | sed -n 's/^DATA=//p') && \
      mkdir -p "$data" && apt-get update -qq && apt-get install --no-install-recommends -y unzip && unzip -q -o /tmp/studio/makehuman_system_assets.zip -d "$data" && \
      rm -rf /var/lib/apt/lists/*; \
    fi; rm -rf /tmp/studio

FROM studio
COPY --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=build /rails /rails
COPY --from=vendor /vendor/out /rails/public/vendor
RUN groupadd --system --gid 1000 rails && useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash && \
    chown -R rails:rails db log storage tmp && \
    if [ -d /opt/blender-home ]; then cp -a /opt/blender-home/. /home/rails/ && chown -R rails:rails /home/rails; fi
USER 1000:1000
ENV LD_PRELOAD=/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2 RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1 \
    FITROOM_BLENDER=/opt/blender/blender
ENTRYPOINT ["/rails/bin/docker-entrypoint"]
EXPOSE 3000
CMD ["./bin/rails", "server", "-b", "0.0.0.0"]
