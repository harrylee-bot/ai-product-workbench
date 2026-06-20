FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --include=dev

FROM deps AS build
COPY apps/api apps/api
COPY packages/database packages/database
RUN npm run db:generate
RUN npm --workspace @ai-product-workbench/api run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/database/prisma packages/database/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma
COPY deploy/api-entrypoint.sh deploy/api-entrypoint.sh
RUN chmod +x deploy/api-entrypoint.sh
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["/app/deploy/api-entrypoint.sh"]
