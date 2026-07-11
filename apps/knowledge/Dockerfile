ARG NODE_IMAGE=node:22-bookworm-slim
ARG QUARTZ_REF=v5.0.0
ARG QUARTZ_COMMIT=ab346fa66a895e12d63a308e70ce330ba795822a

FROM ${NODE_IMAGE}

ARG QUARTZ_REF
ARG QUARTZ_COMMIT

WORKDIR /opt/quartz
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

RUN sed -i \
    -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
    -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nginx tini \
  && rm -f /etc/nginx/sites-enabled/default \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${QUARTZ_REF}" https://github.com/jackyzha0/quartz.git /opt/quartz \
  && cd /opt/quartz \
  && test "$(git rev-parse HEAD)" = "${QUARTZ_COMMIT}" \
  && git rev-parse HEAD > /opt/quartz/.quartz-source-revision

COPY apps/knowledge/quartz.config.yaml /opt/quartz/quartz.config.yaml
COPY apps/knowledge/quartz.lock.json /opt/quartz/quartz.lock.json
COPY apps/knowledge/static/icon.png /opt/quartz/quartz/static/icon.png
COPY apps/knowledge/static/og-image.png /opt/quartz/quartz/static/og-image.png
COPY apps/knowledge/patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch /opt/quartz-patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch
COPY apps/knowledge/patches/0002-quartz-v5-disable-dangerous-raw-html.patch /opt/quartz-patches/0002-quartz-v5-disable-dangerous-raw-html.patch

RUN git apply --check /opt/quartz-patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch \
  && git apply /opt/quartz-patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch \
  && git apply --check /opt/quartz-patches/0002-quartz-v5-disable-dangerous-raw-html.patch \
  && git apply /opt/quartz-patches/0002-quartz-v5-disable-dangerous-raw-html.patch \
  && npm ci --no-audit --no-fund \
  && npx quartz plugin install \
  && mkdir -p /vault /usr/share/nginx/html /var/cache/nginx /var/run/nginx

COPY apps/knowledge/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/knowledge/docker-entrypoint.sh /usr/local/bin/knowledge-entrypoint
COPY apps/knowledge/finalize-output.mjs /usr/local/lib/knowledge-finalize-output.mjs
COPY apps/knowledge/publish-generation.mjs /usr/local/lib/knowledge-publish-generation.mjs
COPY scripts/assert-knowledge-output.mjs /usr/local/lib/knowledge-assert-output.mjs
COPY knowledge-vault /seed-vault

RUN chmod +x /usr/local/bin/knowledge-entrypoint

ENV QUARTZ_CONTENT_DIR=/vault
ENV QUARTZ_OUTPUT_DIR=/usr/share/nginx/html
ENV QUARTZ_CONCURRENCY=2

EXPOSE 3000

ENTRYPOINT ["tini", "--", "knowledge-entrypoint"]
