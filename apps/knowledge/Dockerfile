ARG NODE_IMAGE=node:22-bookworm-slim
ARG QUARTZ_REF=v5.0.0

FROM ${NODE_IMAGE}

ARG QUARTZ_REF

WORKDIR /opt/quartz

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nginx tini \
  && rm -f /etc/nginx/sites-enabled/default \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${QUARTZ_REF}" https://github.com/jackyzha0/quartz.git /opt/quartz

COPY apps/knowledge/quartz.config.yaml /opt/quartz/quartz.config.yaml
COPY apps/knowledge/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/knowledge/docker-entrypoint.sh /usr/local/bin/knowledge-entrypoint
COPY knowledge-vault /seed-vault

RUN npm ci \
  && npx quartz plugin install \
    created-modified-date \
    obsidian-flavored-markdown \
    github-flavored-markdown \
    table-of-contents \
    crawl-links \
    description \
    hard-line-breaks \
    remove-draft \
    alias-redirects \
    content-index \
    content-page \
    folder-page \
    tag-page \
    explorer \
    search \
    graph \
    backlinks \
    article-title \
    content-meta \
    page-title \
    darkmode \
    breadcrumbs \
    footer \
    spacer \
    note-properties \
    og-image \
  && chmod +x /usr/local/bin/knowledge-entrypoint \
  && mkdir -p /vault /usr/share/nginx/html /var/cache/nginx /var/run/nginx

ENV QUARTZ_CONTENT_DIR=/vault
ENV QUARTZ_OUTPUT_DIR=/usr/share/nginx/html
ENV QUARTZ_CONCURRENCY=2

EXPOSE 3000

ENTRYPOINT ["tini", "--", "knowledge-entrypoint"]
