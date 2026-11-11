# syntax=docker.m.daocloud.io/docker/dockerfile:1.7
# Keep the Dockerfile frontend on the runner's reachable registry mirror. The
# default docker.io endpoint intermittently fails during protected source builds.

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime

# The pinned 2.1.0 source image contains verified release source only.
# No upstream operating system, virtualenv or developer CLIs enter the runtime.
FROM ${DEERFLOW_BASE_IMAGE} AS recovered-source

FROM cgr.dev/chainguard/wolfi-base@sha256:1c451d46a0d5c4e9f2b38e0e8d3e299564a1aa95c21973efcc1980a9d1d2e73e AS runtime

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
ARG DEERFLOW_SOURCE_COMMIT

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache \
      ca-certificates-bundle=20260909-r3 \
      python-3.12=3.12.15-r3 \
      uv=0.13.0-r0 \
      libstdc++=16.2.0-r1 \
      libbrotlicommon1=1.2.0-r7 \
      libbrotlidec1=1.2.0-r7 \
      libbrotlienc1=1.2.0-r7 \
    && mkdir -p /usr/local/bin \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python3

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_CACHE_DIR=/tmp/uv-cache
WORKDIR /app

COPY integrations/deerflow/runtime-security/prepare_source.py \
     integrations/deerflow/runtime-security/prepare_release.py \
     integrations/deerflow/runtime-security/test_runtime.py \
     /opt/workbench/deerflow/runtime-security/
COPY integrations/deerflow/runtime-security/upstream-2.1.0/dependencies.json /opt/workbench/deerflow/runtime-security/dependencies.json
COPY integrations/deerflow/runtime-security/upstream-2.1.0/dependencies.json \
     integrations/deerflow/runtime-security/upstream-2.1.0/source-snapshot.json \
     integrations/deerflow/runtime-security/upstream-2.1.0/uv.lock \
     /opt/workbench/deerflow/runtime-security/upstream-2.1.0/
COPY integrations/deerflow/source-patches/345f08be00c8a9495079b732a39b46aa9af1584e/ /opt/workbench/deerflow/source-patch/
# The dedicated BuildKit bridge may inherit a host proxy that returns 502 for
# PyPI while direct egress from the isolated builder is healthy. Keep
# dependency resolution inside the builder, but do not let that proxy turn a
# transient network issue into a 60-minute release timeout.
RUN --mount=from=recovered-source,source=/,target=/source-ro \
    python3 /opt/workbench/deerflow/runtime-security/prepare_release.py \
      --source-root /source-ro --destination /app/backend \
      --candidate-patch-root /opt/workbench/deerflow/source-patch \
    && cd /app/backend \
    && env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
      uv sync --locked --no-dev --python /usr/bin/python3.12 \
    && env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
      uv pip check --python /app/backend/.venv/bin/python \
    && rm -rf /tmp/uv-cache

# The candidate-owned extension is embedded in the derived image. Production
# never installs tools or public skills from a mutable host checkout.
COPY --from=validator-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=validator-runtime /usr/local/LICENSE /usr/share/licenses/node/LICENSE
COPY integrations/deerflow/runtime-security/upstream-2.1.0/LICENSE /usr/share/licenses/deerflow/LICENSE
COPY integrations/deerflow/skills/workbench/ /app/skills/public/workbench/
COPY integrations/deerflow/skills/requirement-doc-template/ /app/skills/public/requirement-doc-template/
COPY integrations/deerflow/runtime-tools/deerflow_workbench_tools/ /app/backend/deerflow_workbench_tools/
COPY integrations/deerflow/runtime-tools/config.fragment.yaml /opt/workbench/deerflow/config.fragment.yaml
COPY deploy/deerflow-extensions.production.json /app/backend/extensions_config.workbench.json

# The base image must contain the exact audited upstream sources. Apply the
# deterministic patch, run its contracts against the image's real
# LangChain/LangGraph dependencies, then verify the resulting file hashes.
RUN test "${DEERFLOW_SOURCE_COMMIT}" = "345f08be00c8a9495079b732a39b46aa9af1584e" \
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
      uv run --no-sync python -c 'import hashlib; from types import SimpleNamespace; from deerflow_workbench_tools.prd_reference_tool import workbench_prd_reference_read; tool = workbench_prd_reference_read; schema = tool.tool_call_schema.model_json_schema(); properties = schema.get("properties", {}); expected_paths = ["/mnt/skills/public/requirement-doc-template/SKILL.md", "/mnt/skills/public/requirement-doc-template/references/structure.md", "/mnt/skills/public/requirement-doc-template/references/quality-standards.md", "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json"]; assert tool.name == "read_file" and list(properties) == ["description", "path"] and schema.get("required") == ["description", "path"] and properties["path"].get("enum") == expected_paths and "start_line" not in properties and "end_line" not in properties; content = tool.func(runtime=SimpleNamespace(context={"workbench": {"requestedArtifactKinds": ["prd"]}}), description="Verify the pinned PRD skill", path=expected_paths[0]); assert hashlib.sha256(content.encode("utf-8")).hexdigest() == "fe668773ece4fb6790a59e8dc9981482def6a959079c280080a8a99600ba97e9"' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result; result = validate_runtime_result({}); assert result["protocol"] == "workbench.runtime.validation.v1" and result["ok"] is False and result["issues"]' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python /opt/workbench/deerflow/source-patch/test_workbench_upgrade.py \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit "${DEERFLOW_SOURCE_COMMIT}" \
      --check \
    && rm -rf /tmp/uv-cache

EXPOSE 8001
CMD ["sh", "-c", "cd /app/backend && PYTHONPATH=. exec uv run --no-sync uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001"]
USER 65532:65532
RUN --network=none cd /app/backend \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python /opt/workbench/deerflow/runtime-security/test_runtime.py \
    && rm -rf /tmp/uv-cache

# Source metadata must not invalidate dependency layers on every app-only fix.
ARG WORKBENCH_SOURCE_COMMIT
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=2d0a06701bc07c4d5bd97de446a3ee842df0b7800e5fbb0e2e4b70ac04fa3916
LABEL org.opencontainers.image.title="产品工作台 DeerFlow Runtime" \
      org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.base-image="${DEERFLOW_BASE_IMAGE}" \
      io.workbench.deerflow.runtime-base-image="cgr.dev/chainguard/wolfi-base@sha256:1c451d46a0d5c4e9f2b38e0e8d3e299564a1aa95c21973efcc1980a9d1d2e73e" \
      io.workbench.deerflow.validator-node-image="${DEERFLOW_NODE_IMAGE}" \
      io.workbench.deerflow.source-commit="${DEERFLOW_SOURCE_COMMIT}" \
      io.workbench.deerflow.tool-scope-patch-sha256="${WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256}" \
      io.workbench.deerflow.contract-version="1"
