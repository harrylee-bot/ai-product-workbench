ARG GRIST_BASE_IMAGE=gristlabs/grist-oss@sha256:b87ec1c3b62ca99f872611a9aa71ca33ee5fef9f40e0921e0beed878e5083473
FROM ${GRIST_BASE_IMAGE}

LABEL org.opencontainers.image.title="Workbench Grist"
LABEL org.opencontainers.image.version="1.7.17-owner-tools"
LABEL org.opencontainers.image.description="Grist 1.7.17 with document tools restricted to owners"

COPY static /grist/static
