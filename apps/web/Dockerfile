ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit --no-fund

FROM deps AS build
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_KNOWLEDGE_APP_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_KNOWLEDGE_APP_URL=$NEXT_PUBLIC_KNOWLEDGE_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund && rm -rf /root/.npm

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
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build /app/apps/web/lib/security-headers.ts apps/web/lib/security-headers.ts
COPY --from=build /app/apps/web/public apps/web/public
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
