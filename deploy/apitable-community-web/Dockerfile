# Build from the corresponding APITable v1.13.0-beta.1 source tree.
FROM apitable/nodepy:16.15.0-alpine AS deps

RUN npm install -g pnpm@8.13.1

WORKDIR /workspace-install

COPY ./pnpm-workspace.yaml ./package.json ./pnpm-lock.yaml ./
COPY ./patches/ ./patches
COPY packages/components/package.json ./packages/components/
COPY packages/core/package.json ./packages/core/
COPY packages/databus-wasm-web/package.json ./packages/databus-wasm-web/
COPY packages/databus-wasm-nodejs/package.json ./packages/databus-wasm-nodejs/
COPY packages/i18n-lang/package.json ./packages/i18n-lang/
COPY packages/icons/package.json ./packages/icons/
COPY packages/widget-sdk/package.json ./packages/widget-sdk/
COPY packages/ai-components/package.json ./packages/ai-components/
COPY packages/api-client/package.json ./packages/api-client/
COPY packages/datasheet/package.json ./packages/datasheet/

RUN pnpm install

FROM apitable/nodepy:16.15.0-alpine AS builder

ARG SEMVER_FULL="v1.13.0-beta.1-ce-collaboration.14"
ARG NEXT_ASSET_PREFIX=""
ARG NEXT_PUBLIC_ASSET_PREFIX=""
ENV SEMVER_FULL=${SEMVER_FULL}

RUN npm install -g pnpm@8.13.1

WORKDIR /app

COPY ./pnpm-workspace.yaml ./build.js ./package.json ./pnpm-lock.yaml ./nx.json ./common-tsconfig.json ./tsconfig.json ./.eslintrc ./
COPY packages/ ./packages/
COPY self-hosted-community-web/src/permission_and_collaborator.tsx \
  ./packages/datasheet/src/pc/components/catalog/share_node/permission_and_collaborator.tsx
COPY self-hosted-community-web/src/link_invite.tsx \
  ./packages/datasheet/src/pc/components/invite/invite_outsider/link_invite/link_invite.tsx
COPY self-hosted-community-web/src/share.tsx \
  ./packages/datasheet/src/pc/components/share/share.tsx
COPY self-hosted-community-web/src/share.style.module.less \
  ./packages/datasheet/src/pc/components/share/style.module.less
COPY self-hosted-community-web/src/share_menu.tsx \
  ./packages/datasheet/src/pc/components/share/share_menu/share_menu.tsx
COPY self-hosted-community-web/src/share_menu.style.module.less \
  ./packages/datasheet/src/pc/components/share/share_menu/style.module.less
COPY self-hosted-community-web/src/multi_grid_cell/cell_attachment.tsx \
  ./packages/datasheet/src/pc/components/multi_grid/cell/cell_attachment/cell_attachment.tsx
COPY self-hosted-community-web/src/konva_cell/cell_attachment.tsx \
  ./packages/datasheet/src/pc/components/konva_grid/components/cell/cell_attachment/cell_attachment.tsx
COPY self-hosted-community-web/src/preview_file/preview_type/preview_type.tsx \
  ./packages/datasheet/src/pc/components/preview_file/preview_type/preview_type.tsx
COPY self-hosted-community-web/src/preview_file/preview_type/preview_docx.tsx \
  ./packages/datasheet/src/pc/components/preview_file/preview_type/preview_docx.tsx
COPY self-hosted-community-web/public/file/jszip.min.js \
  ./packages/datasheet/public/file/jszip.min.js
COPY self-hosted-community-web/public/file/docx-preview.js \
  ./packages/datasheet/public/file/docx-preview.js
COPY self-hosted-community-web/src/address_list.tsx \
  ./packages/datasheet/src/pc/components/address_list/address_list.tsx
COPY self-hosted-community-web/src/logo.tsx \
  ./packages/datasheet/src/pc/components/common/logo/logo.tsx
COPY self-hosted-community-web/src/logo.style.module.less \
  ./packages/datasheet/src/pc/components/common/logo/styles.module.less
COPY self-hosted-community-web/src/home_wrapper.tsx \
  ./packages/datasheet/src/pc/components/home/home_wrapper.tsx
COPY self-hosted-community-web/src/mobile_home.tsx \
  ./packages/datasheet/src/pc/components/home/mobile_home.tsx
COPY self-hosted-community-web/src/gantt_brand_desc.tsx \
  ./packages/datasheet/src/pc/components/gantt_view/group/brand_desc.tsx
COPY self-hosted-community-web/src/_app.tsx ./packages/datasheet/pages/_app.tsx
COPY self-hosted-community-web/src/index.less ./packages/datasheet/src/index.less
COPY self-hosted-community-web/scripts/apply-branding.mjs ./self-hosted-community-web/scripts/apply-branding.mjs
COPY self-hosted-community-web/scripts/scrub-runtime-branding.mjs ./self-hosted-community-web/scripts/scrub-runtime-branding.mjs

RUN node self-hosted-community-web/scripts/apply-branding.mjs

COPY --from=deps /workspace-install/patches ./patches
COPY --from=deps /workspace-install/node_modules ./node_modules
COPY --from=deps /workspace-install/packages/datasheet/node_modules ./packages/datasheet/node_modules
COPY --from=deps /workspace-install/packages/components/node_modules ./packages/components/node_modules
COPY --from=deps /workspace-install/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /workspace-install/packages/icons/node_modules ./packages/icons/node_modules
COPY --from=deps /workspace-install/packages/i18n-lang/node_modules ./packages/i18n-lang/node_modules
COPY --from=deps /workspace-install/packages/widget-sdk/node_modules ./packages/widget-sdk/node_modules
COPY --from=deps /workspace-install/packages/ai-components/node_modules ./packages/ai-components/node_modules
COPY --from=deps /workspace-install/packages/api-client/node_modules ./packages/api-client/node_modules

RUN set -eux; \
    sed -i~ '$a\WEB_CLIENT_VERSION='${SEMVER_FULL}'' packages/datasheet/.env; \
    sed -i~ 's~^SYSTEM_CONFIGURATION_DEFAULT_LANGUAGE=.*~SYSTEM_CONFIGURATION_DEFAULT_LANGUAGE=zh_CN~' packages/datasheet/.env; \
    sed -i~ 's~^NEXT_ASSET_PREFIX=.*~NEXT_ASSET_PREFIX='${NEXT_ASSET_PREFIX}'~' packages/datasheet/.env; \
    sed -i~ 's~^NEXT_PUBLIC_ASSET_PREFIX=.*~NEXT_PUBLIC_ASSET_PREFIX='${NEXT_PUBLIC_ASSET_PREFIX}'~' packages/datasheet/.env

RUN pnpm run build:dst
RUN node self-hosted-community-web/scripts/scrub-runtime-branding.mjs

FROM apitable/nodepy:16.15.0-alpine AS runner

LABEL org.opencontainers.image.title="APITable Community Edition web server"
LABEL org.opencontainers.image.version="v1.13.0-beta.1-ce-collaboration.14"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.source="https://github.com/apitable/apitable/tree/v1.13.0-beta.1"

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/datasheet/public ./packages/datasheet/public
COPY --from=builder /app/packages/datasheet/next.config.js \
                    /app/packages/datasheet/package.json \
                    ./packages/datasheet/
COPY --from=builder --chown=nextjs:nodejs /app/packages/datasheet/web_build/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/datasheet/web_build/static ./packages/datasheet/web_build/static

WORKDIR /app/packages/datasheet

USER nextjs
EXPOSE 8080
ENV PORT=8080

CMD ["node", "server.js"]
