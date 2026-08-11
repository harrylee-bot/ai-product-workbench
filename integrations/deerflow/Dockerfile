# syntax=docker/dockerfile:1.7

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime

FROM ${DEERFLOW_BASE_IMAGE} AS runtime

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
ARG DEERFLOW_SOURCE_COMMIT
ARG WORKBENCH_SOURCE_COMMIT
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=8c7cca38ad640d8c8360a68788dd2fefab2cf65d2b86afe1f19d3ecde9d1b91b
ARG WORKBENCH_DEERFLOW_PROTOTYPE_NORMALIZER_SHA256=fc0d76078c3470fbde6c3333a059fcade24eb80aeda338c1c604c498b09edd19

LABEL org.opencontainers.image.title="产品工作台 DeerFlow Runtime" \
      org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.base-image="${DEERFLOW_BASE_IMAGE}" \
      io.workbench.deerflow.validator-node-image="${DEERFLOW_NODE_IMAGE}" \
      io.workbench.deerflow.source-commit="${DEERFLOW_SOURCE_COMMIT}" \
      io.workbench.deerflow.tool-scope-patch-sha256="${WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256}" \
      io.workbench.deerflow.prototype-normalizer-sha256="${WORKBENCH_DEERFLOW_PROTOTYPE_NORMALIZER_SHA256}" \
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
    && test "$(sha256sum /app/backend/deerflow_workbench_tools/prototype_runtime_normalizer.py | awk '{print $1}')" = "${WORKBENCH_DEERFLOW_PROTOTYPE_NORMALIZER_SHA256}" \
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
      uv run --no-sync python -c 'import hashlib; from types import SimpleNamespace; from deerflow_workbench_tools.prd_reference_tool import workbench_prd_reference_read; tool = workbench_prd_reference_read; schema = tool.tool_call_schema.model_json_schema(); properties = schema.get("properties", {}); expected_paths = ["/mnt/skills/public/requirement-doc-template/SKILL.md", "/mnt/skills/public/requirement-doc-template/references/structure.md", "/mnt/skills/public/requirement-doc-template/references/quality-standards.md", "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json", "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json", "/mnt/skills/public/workbench/references/runtime-result-contract.md"]; assert tool.name == "read_file" and list(properties) == ["description", "path"] and schema.get("required") == ["description", "path"] and properties["path"].get("enum") == expected_paths and "start_line" not in properties and "end_line" not in properties; prd_content = tool.func(runtime=SimpleNamespace(context={"workbench": {"requestedArtifactKinds": ["prd"]}}), description="Verify the pinned PRD skill", path=expected_paths[0]); prototype_content = tool.func(runtime=SimpleNamespace(context={"workbench": {"requestedArtifactKinds": ["prototype"]}}), description="Verify the pinned Prototype example", path=expected_paths[4]); assert hashlib.sha256(prd_content.encode("utf-8")).hexdigest() == "82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f" and hashlib.sha256(prototype_content.encode("utf-8")).hexdigest() == "e76e0c8b8c797a4941e31cc5067b80bb8106d4329b086ef743d6ad76ef958a99"' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result; result = validate_runtime_result({}); assert result["protocol"] == "workbench.runtime.validation.v1" and result["ok"] is False and result["issues"]' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'import importlib; configured_tools = (("workbench_artifact_draft_publish", "deerflow_workbench_tools.artifact_draft_tool", "workbench_artifact_draft_publish"), ("workbench_generation_stage_update", "deerflow_workbench_tools.generation_stage_tool", "workbench_generation_stage_update"), ("workbench_prototype_patch_publish", "deerflow_workbench_tools.prototype_patch_tool", "workbench_prototype_patch_publish"), ("workbench_knowledge_retrieve", "deerflow_workbench_tools.knowledge_tool", "workbench_knowledge_retrieve"), ("workbench_runtime_result_submit", "deerflow_workbench_tools.runtime_result_tool", "workbench_runtime_result_submit"), ("read_file", "deerflow_workbench_tools.prd_reference_tool", "workbench_prd_reference_read")); resolved_tools = [getattr(importlib.import_module(module), attribute) for _, module, attribute in configured_tools]; assert [getattr(tool, "name", None) for tool in resolved_tools] == [name for name, _, _ in configured_tools]' \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit "${DEERFLOW_SOURCE_COMMIT}" \
      --check

USER 65532:65532
