ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    DEBIAN_FRONTEND=noninteractive

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates openssl

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/workbench-file-worker/package.json apps/workbench-file-worker/package.json
COPY packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-db/package.json packages/workbench-db/package.json
COPY packages/workbench-knowledge/package.json packages/workbench-knowledge/package.json
COPY packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --include=dev --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY apps/workbench-file-worker apps/workbench-file-worker
COPY packages/workbench-content-security packages/workbench-content-security
COPY packages/workbench-contracts packages/workbench-contracts
COPY packages/workbench-db packages/workbench-db
COPY packages/workbench-knowledge packages/workbench-knowledge
COPY packages/workbench-telemetry packages/workbench-telemetry
RUN rm -rf packages/workbench-db/generated \
  && npm --workspace @workbench/workbench-contracts run validate:openapi \
  && npm --workspace @workbench/workbench-contracts run build \
  && npm --workspace @workbench/workbench-db run generate \
  && npm --workspace @workbench/workbench-content-security run build \
  && npm --workspace @workbench/workbench-knowledge run build \
  && npm --workspace @workbench/workbench-telemetry run build \
  && npm --workspace @workbench/workbench-file-worker run build

FROM build AS production-dependencies
COPY deploy/collect-workspace-runtime-dependencies.mjs /usr/local/lib/collect-workspace-runtime-dependencies.mjs
RUN npm prune --omit=dev --no-audit --no-fund \
  && node /usr/local/lib/collect-workspace-runtime-dependencies.mjs /app /app/.runtime-workspace-dependencies \
  && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates openssl

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/workbench-file-worker/package.json apps/workbench-file-worker/package.json
COPY --chown=node:node packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY --chown=node:node packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY --chown=node:node packages/workbench-db/package.json packages/workbench-db/package.json
COPY --chown=node:node packages/workbench-knowledge/package.json packages/workbench-knowledge/package.json
COPY --chown=node:node packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/.runtime-workspace-dependencies/ ./
COPY --from=build --chown=node:node /app/apps/workbench-file-worker/dist apps/workbench-file-worker/dist
COPY --from=build --chown=node:node /app/packages/workbench-content-security/dist packages/workbench-content-security/dist
COPY --from=build --chown=node:node /app/packages/workbench-contracts/dist packages/workbench-contracts/dist
COPY --from=build --chown=node:node /app/packages/workbench-db/generated packages/workbench-db/generated
COPY --from=build --chown=node:node /app/packages/workbench-knowledge/dist packages/workbench-knowledge/dist
COPY --from=build --chown=node:node /app/packages/workbench-telemetry/dist packages/workbench-telemetry/dist

RUN node --input-type=module -e "await import('./apps/workbench-file-worker/dist/mime.js')"

COPY deploy/remove-node-package-managers.mjs /usr/local/lib/remove-node-package-managers.mjs
RUN node /usr/local/lib/remove-node-package-managers.mjs
USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "apps/workbench-file-worker/dist/healthcheck.js"]
CMD ["node", "apps/workbench-file-worker/dist/main.js"]
