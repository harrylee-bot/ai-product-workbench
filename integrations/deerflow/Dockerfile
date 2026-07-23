# syntax=docker/dockerfile:1.7

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime

FROM ${DEERFLOW_BASE_IMAGE} AS runtime

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
ARG DEERFLOW_SOURCE_COMMIT
ARG WORKBENCH_SOURCE_COMMIT
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=623b91e4f65863e3fa4f914e1ed2a7934726cefb55e6aff64d367781be6d4f94

LABEL org.opencontainers.image.title="产品工作台 DeerFlow Runtime" \
      org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.base-image="${DEERFLOW_BASE_IMAGE}" \
      io.workbench.deerflow.validator-node-image="${DEERFLOW_NODE_IMAGE}" \
      io.workbench.deerflow.source-commit="${DEERFLOW_SOURCE_COMMIT}" \
      io.workbench.deerflow.tool-scope-patch-sha256="${WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256}" \
      io.workbench.deerflow.contract-version="1"

# The candidate-owned extension is embedded in the derived image. Production
# never installs tools or public skills from a mutable host checkout.
COPY --from=validator-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=validator-runtime /usr/local/LICENSE /usr/share/licenses/node/LICENSE
COPY integrations/deerflow/skills/workbench/ /app/skills/public/workbench/
COPY integrations/deerflow/skills/requirement-doc-template/ /app/skills/public/requirement-doc-template/
COPY integrations/deerflow/runtime-tools/deerflow_workbench_tools/ /app/backend/deerflow_workbench_tools/
COPY integrations/deerflow/runtime-tools/config.fragment.yaml /opt/workbench/deerflow/config.fragment.yaml
COPY deploy/deerflow-extensions.production.json /app/backend/extensions_config.workbench.json
COPY integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2/ /opt/workbench/deerflow/source-patch/

# The hardened upstream image runs as the non-root runtime identity. Apply the
# immutable source patch as root, then restore that identity in the final image.
USER root

# The base image must contain the exact audited upstream sources. Apply the
# deterministic patch, run its contracts against the image's real
# LangChain/LangGraph dependencies, then verify the resulting file hashes.
RUN test "${DEERFLOW_SOURCE_COMMIT}" = "7a6c4a994a86583d2a3c056ee9d0f157d4f030c2" \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit "${DEERFLOW_SOURCE_COMMIT}" \
    && cd /app/backend \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python /opt/workbench/deerflow/source-patch/test_workbench_request_context.py \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result; result = validate_runtime_result({}); assert result["protocol"] == "workbench.runtime.validation.v1" and result["ok"] is False and result["issues"]' \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit "${DEERFLOW_SOURCE_COMMIT}" \
      --check

USER 65532:65532
