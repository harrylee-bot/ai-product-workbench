ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always
COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --include=dev --include=optional --no-audit --no-fund \
  && node -e "require('lightningcss'); require('@tailwindcss/oxide')"

FROM deps AS build
ARG NEXT_PUBLIC_KNOWLEDGE_APP_URL
ARG NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL
ARG NEXT_PUBLIC_WORKBENCH_FORUM_URL
ARG NEXT_PUBLIC_WORKBENCH_PRIVACY_URL
ARG NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED=false
ARG WORKBENCH_PREVIEW_ORIGIN
ARG WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL
ENV NEXT_PUBLIC_KNOWLEDGE_APP_URL=$NEXT_PUBLIC_KNOWLEDGE_APP_URL
ENV NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL=$NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL
ENV NEXT_PUBLIC_WORKBENCH_FORUM_URL=$NEXT_PUBLIC_WORKBENCH_FORUM_URL
ENV NEXT_PUBLIC_WORKBENCH_PRIVACY_URL=$NEXT_PUBLIC_WORKBENCH_PRIVACY_URL
ENV NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED=$NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED
ENV WORKBENCH_PREVIEW_ORIGIN=$WORKBENCH_PREVIEW_ORIGIN
ENV WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=$WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    WORKBENCH_NEXT_BUILD_CPUS=1
COPY apps/web apps/web
COPY packages/workbench-contracts packages/workbench-contracts
COPY packages/workbench-telemetry packages/workbench-telemetry
RUN npm --workspace @workbench/workbench-contracts run validate:openapi \
  && npm --workspace @workbench/workbench-contracts run build \
  && npm --workspace @workbench/workbench-telemetry run build \
  && npm --workspace @workbench/web run generate:workbench-api
WORKDIR /app/apps/web
# Type checking in a separate process avoids retaining the compiler heap while
# Next starts its TypeScript worker on memory-constrained builders.
RUN npx next typegen && npx tsc -p tsconfig.json --noEmit
ENV WORKBENCH_TYPES_PREVALIDATED=1
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev --include=optional --no-audit --no-fund && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always
COPY --chmod=0555 deploy/prepare-node-image.sh /usr/local/bin/prepare-node-image
RUN prepare-node-image
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/workbench-contracts/package.json packages/workbench-contracts/package.json
COPY packages/workbench-telemetry/package.json packages/workbench-telemetry/package.json
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build /app/apps/web/lib/security-headers.ts apps/web/lib/security-headers.ts
COPY --from=build /app/apps/web/public apps/web/public
COPY --from=build /app/packages/workbench-contracts/dist packages/workbench-contracts/dist
COPY --from=build /app/packages/workbench-telemetry/dist packages/workbench-telemetry/dist
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
