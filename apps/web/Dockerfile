ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN NPM_CONFIG_UPDATE_NOTIFIER=false npm ci --include=dev --no-fund

FROM deps AS build
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_KNOWLEDGE_APP_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_KNOWLEDGE_APP_URL=$NEXT_PUBLIC_KNOWLEDGE_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN NPM_CONFIG_UPDATE_NOTIFIER=false npm ci --omit=dev --no-fund && npm cache clean --force
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build /app/apps/web/lib/security-headers.ts apps/web/lib/security-headers.ts
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
