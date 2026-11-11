ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:stable-alpine
ARG QUARTZ_REF=v5.0.0
ARG QUARTZ_COMMIT=ab346fa66a895e12d63a308e70ce330ba795822a

FROM ${NODE_IMAGE} AS quartz-base

ARG QUARTZ_REF
ARG QUARTZ_COMMIT

WORKDIR /opt/quartz
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates coreutils git

RUN git clone --depth 1 --branch "${QUARTZ_REF}" https://github.com/jackyzha0/quartz.git /opt/quartz \
  && cd /opt/quartz \
  && test "$(git rev-parse HEAD)" = "${QUARTZ_COMMIT}" \
  && git rev-parse HEAD > /opt/quartz/.quartz-source-revision

COPY apps/knowledge/quartz.config.yaml /opt/quartz/quartz.config.yaml
COPY apps/knowledge/quartz.lock.json /opt/quartz/quartz.lock.json

RUN npm ci --no-audit --no-fund \
  && npx quartz plugin install

FROM quartz-base AS mutable-runner

RUN prepare-node-image nginx tini \
  && rm -f /etc/nginx/sites-enabled/default /etc/nginx/http.d/default.conf \
  && mkdir -p /vault /usr/share/nginx/html /var/cache/nginx /var/run/nginx

COPY apps/knowledge/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/knowledge/docker-entrypoint.sh /usr/local/bin/knowledge-entrypoint
COPY apps/knowledge/finalize-output.mjs /usr/local/lib/knowledge-finalize-output.mjs
COPY knowledge-vault /seed-vault

RUN chmod +x /usr/local/bin/knowledge-entrypoint

ENV QUARTZ_CONTENT_DIR=/vault
ENV QUARTZ_OUTPUT_DIR=/usr/share/nginx/html
ENV QUARTZ_CONCURRENCY=2

EXPOSE 3000
ENTRYPOINT ["tini", "--", "knowledge-entrypoint"]

FROM quartz-base AS immutable-builder

ARG QUARTZ_BASE_URL=localhost:3001
ARG KNOWLEDGE_WEB_URL=http://localhost:3000
ENV QUARTZ_BASE_URL=${QUARTZ_BASE_URL}
ENV KNOWLEDGE_WEB_URL=${KNOWLEDGE_WEB_URL}

COPY apps/knowledge/finalize-output.mjs /usr/local/lib/knowledge-finalize-output.mjs
COPY apps/knowledge/configure-immutable.mjs /usr/local/lib/knowledge-configure-immutable.mjs
COPY apps/knowledge/build-immutable.sh /usr/local/bin/knowledge-build-immutable
COPY knowledge-vault /seed-vault

RUN chmod +x /usr/local/bin/knowledge-build-immutable \
  && /usr/local/bin/knowledge-build-immutable

FROM ${NGINX_IMAGE} AS immutable-runner

# Pin the reviewed PCRE2 package supplied by the pinned Alpine 3.22 Nginx base;
# the final image must still pass the release scan.
RUN apk add --no-cache --upgrade pcre2=10.46-r0

COPY apps/knowledge/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=immutable-builder /tmp/quartz-public /usr/share/nginx/html

USER 101:101
EXPOSE 3000
ENTRYPOINT ["nginx", "-g", "daemon off;"]
