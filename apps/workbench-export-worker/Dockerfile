ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates openssl

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/workbench-export-worker/package.json apps/workbench-export-worker/package.json
COPY packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-db/package.json packages/workbench-db/package.json
COPY packages/workbench-export-core/package.json packages/workbench-export-core/package.json
COPY packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --include=dev --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY apps/workbench-export-worker apps/workbench-export-worker
COPY packages/workbench-content-security packages/workbench-content-security
COPY packages/workbench-contracts packages/workbench-contracts
COPY packages/workbench-db packages/workbench-db
COPY packages/workbench-export-core packages/workbench-export-core
COPY packages/workbench-telemetry packages/workbench-telemetry
RUN rm -rf packages/workbench-db/generated \
  && npm --workspace @workbench/workbench-contracts run build \
  && npm --workspace @workbench/workbench-db run generate \
  && npm --workspace @workbench/workbench-content-security run build \
  && npm --workspace @workbench/workbench-export-core run build \
  && npm --workspace @workbench/workbench-telemetry run build \
  && npm --workspace @workbench/workbench-export-worker run build

FROM build AS production-dependencies
COPY deploy/collect-workspace-runtime-dependencies.mjs /usr/local/lib/collect-workspace-runtime-dependencies.mjs
RUN npm prune --omit=dev --no-audit --no-fund \
  && node /usr/local/lib/collect-workspace-runtime-dependencies.mjs /app /app/.runtime-workspace-dependencies \
  && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/chromium-config \
    XDG_CACHE_HOME=/tmp/chromium-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    WORKBENCH_EXPORT_CHROMIUM_PATH=/usr/bin/chromium \
    WORKBENCH_FIGMA_FALLBACK_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    PATH="/opt/workbench-export-python/bin:${PATH}"

COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image ca-certificates openssl chromium fonts-dejavu-core fonts-noto-cjk \
    python3 python3-lxml python3-pillow python3-virtualenv libreoffice-writer

COPY deploy/workbench-export-python-requirements.txt /tmp/workbench-export-python-requirements.txt
RUN python3 -m virtualenv --no-download --system-site-packages /opt/workbench-export-python \
  && /opt/workbench-export-python/bin/python3 -m pip install --disable-pip-version-check --no-cache-dir \
    --index-url https://pypi.org/simple --only-binary=:all: --no-deps --require-hashes \
    -r /tmp/workbench-export-python-requirements.txt \
  && rm /tmp/workbench-export-python-requirements.txt

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/workbench-export-worker/package.json apps/workbench-export-worker/package.json
COPY --chown=node:node packages/workbench-content-security/package.json packages/workbench-content-security/package.json
COPY --chown=node:node packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY --chown=node:node packages/workbench-db/package.json packages/workbench-db/package.json
COPY --chown=node:node packages/workbench-export-core/package.json packages/workbench-export-core/package.json
COPY --chown=node:node packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/.runtime-workspace-dependencies/ ./
COPY --from=build --chown=node:node /app/apps/workbench-export-worker/dist apps/workbench-export-worker/dist
COPY --from=build --chown=node:node /app/packages/workbench-content-security/dist packages/workbench-content-security/dist
COPY --from=build --chown=node:node /app/packages/workbench-contracts/dist packages/workbench-contracts/dist
COPY --from=build --chown=node:node /app/packages/workbench-db/generated packages/workbench-db/generated
COPY --from=build --chown=node:node /app/packages/workbench-export-core/dist packages/workbench-export-core/dist
COPY --from=build --chown=node:node /app/packages/workbench-export-core/scripts packages/workbench-export-core/scripts
COPY --from=build --chown=node:node /app/packages/workbench-telemetry/dist packages/workbench-telemetry/dist
COPY --chown=node:node integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx
COPY --chown=node:node integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py
COPY --chown=node:node deploy/check-workbench-document-export.mjs deploy/check-workbench-document-export.mjs

COPY deploy/remove-node-package-managers.mjs /usr/local/lib/remove-node-package-managers.mjs
RUN node /usr/local/lib/remove-node-package-managers.mjs
USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "apps/workbench-export-worker/dist/healthcheck.js"]
CMD ["node", "apps/workbench-export-worker/dist/main.js"]
