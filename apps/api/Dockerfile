ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    DEBIAN_FRONTEND=noninteractive
RUN sed -i \
    -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
    -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY apps/api apps/api
COPY packages/db packages/db
RUN npm run db:generate
RUN npm --workspace @ai-product-workbench/api run build

FROM build AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    DEBIAN_FRONTEND=noninteractive
RUN sed -i \
    -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
    -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/db/prisma packages/db/prisma
COPY knowledge-vault knowledge-vault
COPY scripts/assert-no-legacy-schema.mjs scripts/cleanup-smoke-data.mjs scripts/
COPY deploy/api-entrypoint.sh deploy/api-entrypoint.sh
RUN chmod +x deploy/api-entrypoint.sh
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["/app/deploy/api-entrypoint.sh"]
