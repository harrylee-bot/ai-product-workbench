ARG NODE_IMAGE=node:22-bookworm-slim
ARG CODEX_CLI_VERSION=0.142.2

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
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
RUN npm ci --include=dev

FROM deps AS build
COPY apps/api apps/api
COPY packages/db packages/db
RUN npm run db:generate
RUN npm --workspace @ai-product-workbench/api run build

FROM ${NODE_IMAGE} AS runner
ARG CODEX_CLI_VERSION=0.142.2
WORKDIR /app
ENV NODE_ENV=production
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
RUN npm ci --omit=dev && npm cache clean --force
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/db/prisma packages/db/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma
COPY deploy/api-entrypoint.sh deploy/api-entrypoint.sh
RUN chmod +x deploy/api-entrypoint.sh
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["/app/deploy/api-entrypoint.sh"]
