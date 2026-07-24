# syntax=docker/dockerfile:1.7

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime

FROM ${DEERFLOW_BASE_IMAGE} AS runtime

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
ARG DEERFLOW_SOURCE_COMMIT
ARG WORKBENCH_SOURCE_COMMIT
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=1a4f37bc1d6bf866debf13b986d15f12bedf0cbbad9ca13baa5b7f6db4c9321e

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
      uv run --no-sync python -c 'import hashlib; from types import SimpleNamespace; from deerflow_workbench_tools.prd_reference_tool import workbench_prd_reference_read; tool = workbench_prd_reference_read; schema = tool.tool_call_schema.model_json_schema(); properties = schema.get("properties", {}); expected_paths = ["/mnt/skills/public/requirement-doc-template/SKILL.md", "/mnt/skills/public/requirement-doc-template/references/structure.md", "/mnt/skills/public/requirement-doc-template/references/quality-standards.md", "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json"]; assert tool.name == "read_file" and list(properties) == ["description", "path"] and schema.get("required") == ["description", "path"] and properties["path"].get("enum") == expected_paths and "start_line" not in properties and "end_line" not in properties; content = tool.func(runtime=SimpleNamespace(context={"workbench": {"requestedArtifactKinds": ["prd"]}}), description="Verify the pinned PRD skill", path=expected_paths[0]); assert hashlib.sha256(content.encode("utf-8")).hexdigest() == "6ce1d2094a833210b0578a4396c4c268e7c99a33b2a411b4f4bd11f4b9e69f84"' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result; result = validate_runtime_result({}); assert result["protocol"] == "workbench.runtime.validation.v1" and result["ok"] is False and result["issues"]' \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit "${DEERFLOW_SOURCE_COMMIT}" \
      --check

USER 65532:65532
