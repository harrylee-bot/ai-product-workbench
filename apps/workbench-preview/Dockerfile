ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always

RUN sed -i \
    -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
    -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/workbench-preview/package.json apps/workbench-preview/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-db/package.json packages/workbench-db/package.json
COPY packages/workbench-preview-token/package.json packages/workbench-preview-token/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --include=dev --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY apps/workbench-preview apps/workbench-preview
COPY packages/workbench-contracts packages/workbench-contracts
COPY packages/workbench-db packages/workbench-db
COPY packages/workbench-preview-token packages/workbench-preview-token
RUN rm -rf packages/workbench-db/generated \
  && npm --workspace @workbench/workbench-db run generate \
  && npm --workspace @workbench/workbench-contracts run build \
  && npm --workspace @workbench/workbench-preview-token run build \
  && npm --workspace @workbench/workbench-preview run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund \
  && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always

RUN sed -i \
    -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
    -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/workbench-preview/package.json apps/workbench-preview/package.json
COPY --chown=node:node packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY --chown=node:node packages/workbench-db/package.json packages/workbench-db/package.json
COPY --chown=node:node packages/workbench-preview-token/package.json packages/workbench-preview-token/package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/workbench-preview/node_modules apps/workbench-preview/node_modules
COPY --from=build --chown=node:node /app/apps/workbench-preview/dist apps/workbench-preview/dist
COPY --from=build --chown=node:node /app/packages/workbench-contracts/dist packages/workbench-contracts/dist
COPY --from=build --chown=node:node /app/packages/workbench-db/generated packages/workbench-db/generated
COPY --from=build --chown=node:node /app/packages/workbench-preview-token/dist packages/workbench-preview-token/dist

RUN install -d -o node -g node -m 0700 /var/lib/workbench-preview

RUN node --input-type=module -e \
  "await import('./apps/workbench-preview/dist/csp.js'); await import('./apps/workbench-preview/dist/preview-bridge.js')"

USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4300/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/workbench-preview/dist/main.js"]
