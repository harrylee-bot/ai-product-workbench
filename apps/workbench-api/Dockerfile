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
COPY apps/workbench-api/package.json apps/workbench-api/package.json
COPY packages/workbench-canvas-tools/package.json packages/workbench-canvas-tools/package.json
COPY packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-db/package.json packages/workbench-db/package.json
COPY packages/workbench-knowledge/package.json packages/workbench-knowledge/package.json
COPY packages/workbench-preview-token/package.json packages/workbench-preview-token/package.json
COPY packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --include=dev --include=optional --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY apps/workbench-api apps/workbench-api
COPY packages/workbench-canvas-tools packages/workbench-canvas-tools
COPY packages/workbench-content-security packages/workbench-content-security
COPY packages/workbench-contracts packages/workbench-contracts
COPY packages/workbench-db packages/workbench-db
COPY packages/workbench-knowledge packages/workbench-knowledge
COPY packages/workbench-preview-token packages/workbench-preview-token
COPY packages/workbench-telemetry packages/workbench-telemetry
RUN rm -rf packages/workbench-db/generated \
  && npm --workspace @workbench/workbench-contracts run validate:openapi \
  && npm --workspace @workbench/workbench-contracts run build \
  && npm --workspace @workbench/workbench-canvas-tools run build \
  && npm --workspace @workbench/workbench-db run generate \
  && npm --workspace @workbench/workbench-content-security run build \
  && npm --workspace @workbench/workbench-knowledge run build \
  && npm --workspace @workbench/workbench-preview-token run build \
  && npm --workspace @workbench/workbench-telemetry run build \
  && npm --workspace @workbench/workbench-api run build

FROM build AS production-dependencies
COPY deploy/collect-workspace-runtime-dependencies.mjs /usr/local/lib/collect-workspace-runtime-dependencies.mjs
RUN npm prune --omit=dev --include=optional --no-audit --no-fund \
  && node /usr/local/lib/collect-workspace-runtime-dependencies.mjs /app /app/.runtime-workspace-dependencies \
  && rm -rf /root/.npm

# Migrations are a one-shot deployment concern. This target intentionally keeps
# the Prisma CLI and never starts the API process.
FROM build AS migrator
ENV NODE_ENV=production
COPY deploy/workbench-migrate.sh deploy/workbench-migrate.sh
COPY deploy/run-workspace-cli.mjs deploy/run-workspace-cli.mjs
COPY scripts/assert-workbench-postgres-extensions.mjs scripts/assert-workbench-postgres-extensions.mjs
COPY scripts/provision-workbench-database-roles.mjs scripts/provision-workbench-database-roles.mjs
COPY scripts/reconcile-workbench-runtime-queues.mjs scripts/reconcile-workbench-runtime-queues.mjs
RUN chmod 0555 deploy/workbench-migrate.sh
COPY deploy/remove-node-package-managers.mjs /usr/local/lib/remove-node-package-managers.mjs
RUN node /usr/local/lib/remove-node-package-managers.mjs
USER node
ENTRYPOINT ["/app/deploy/workbench-migrate.sh"]

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    WORKBENCH_API_HOST=0.0.0.0 \
    WORKBENCH_API_PORT=4100 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates openssl

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/workbench-api/package.json apps/workbench-api/package.json
COPY --chown=node:node packages/workbench-canvas-tools/package.json packages/workbench-canvas-tools/package.json
COPY --chown=node:node packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY --chown=node:node packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY --chown=node:node packages/workbench-db/package.json packages/workbench-db/package.json
COPY --chown=node:node packages/workbench-knowledge/package.json packages/workbench-knowledge/package.json
COPY --chown=node:node packages/workbench-preview-token/package.json packages/workbench-preview-token/package.json
COPY --chown=node:node packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/.runtime-workspace-dependencies/ ./
COPY --from=build --chown=node:node /app/apps/workbench-api/dist apps/workbench-api/dist
COPY --from=build --chown=node:node /app/packages/workbench-canvas-tools/dist packages/workbench-canvas-tools/dist
COPY --from=build --chown=node:node /app/packages/workbench-content-security/dist packages/workbench-content-security/dist
COPY --from=build --chown=node:node /app/packages/workbench-contracts/dist packages/workbench-contracts/dist
COPY --from=build --chown=node:node /app/packages/workbench-contracts/openapi packages/workbench-contracts/openapi
COPY --from=build --chown=node:node /app/packages/workbench-db/generated packages/workbench-db/generated
COPY --from=build --chown=node:node /app/packages/workbench-knowledge/dist packages/workbench-knowledge/dist
COPY --from=build --chown=node:node /app/packages/workbench-preview-token/dist packages/workbench-preview-token/dist
COPY --from=build --chown=node:node /app/packages/workbench-telemetry/dist packages/workbench-telemetry/dist

RUN cd /app/apps/workbench-api \
  && node --input-type=module -e "import sharp from 'sharp'; const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer(); const { data, info } = await sharp(png).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true }); if (info.width !== 1 || info.height !== 1 || info.channels !== 3 || !data.equals(Buffer.from([255, 0, 0]))) throw new Error('SHARP_RUNTIME_SMOKE_FAILED');" \
  && install -d -o node -g node -m 0700 /var/lib/workbench-api/ready-object-spool

COPY deploy/remove-node-package-managers.mjs /usr/local/lib/remove-node-package-managers.mjs
RUN node /usr/local/lib/remove-node-package-managers.mjs
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/api/v1/system/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/workbench-api/dist/main.js"]
