ARG GRIST_BASE_IMAGE=gristlabs/grist-oss@sha256:b87ec1c3b62ca99f872611a9aa71ca33ee5fef9f40e0921e0beed878e5083473

FROM node:22-trixie AS frontend-builder

ARG GRIST_SOURCE_REF=v1.7.17
ARG GRIST_BUILD_COMMIT=fe67281
ENV GRIST_SKIP_EXT_AUTOSETUP=1
WORKDIR /src

RUN git clone --branch "${GRIST_SOURCE_REF}" --depth 1 https://github.com/gristlabs/grist-core.git .
COPY deploy/grist-owner-tools.patch /tmp/grist-owner-tools.patch
RUN git apply --check /tmp/grist-owner-tools.patch && git apply /tmp/grist-owner-tools.patch
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  yarn install --frozen-lockfile --network-timeout 600000
RUN GRIST_BUILD_CHANNEL=release GRIST_BUILD_COMMIT="${GRIST_BUILD_COMMIT}" yarn run build:prod

FROM ${GRIST_BASE_IMAGE}

LABEL org.opencontainers.image.title="Workbench Grist"
LABEL org.opencontainers.image.version="1.7.17-owner-tools"
LABEL org.opencontainers.image.description="Grist 1.7.17 with document tools restricted to owners"

COPY --from=frontend-builder /src/static /grist/static
