ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY apps/grist-auth-gateway/package.json apps/grist-auth-gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/grist-auth-gateway/src ./src

USER node
EXPOSE 8484
CMD ["node", "src/server.mjs"]
