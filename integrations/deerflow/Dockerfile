# syntax=docker.m.daocloud.io/docker/dockerfile:1.7
# Keep the Dockerfile frontend on the runner's reachable registry mirror. The
# default docker.io endpoint intermittently fails during owner-release builds.

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime

# The recovered image is a checksum-verified source input only. Its Debian
# filesystem, virtualenv and developer CLIs must never enter the final image.
FROM ${DEERFLOW_BASE_IMAGE} AS recovered-source

FROM cgr.dev/chainguard/wolfi-base@sha256:1c451d46a0d5c4e9f2b38e0e8d3e299564a1aa95c21973efcc1980a9d1d2e73e AS runtime

ARG DEERFLOW_BASE_IMAGE
ARG DEERFLOW_NODE_IMAGE
ARG DEERFLOW_SOURCE_COMMIT
ARG WORKBENCH_SOURCE_COMMIT
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=019765754f4989d7274c20fb034f2eb8502d81a49855379bd6f35e7e726cc21c

LABEL org.opencontainers.image.title="产品工作台 DeerFlow Runtime" \
      org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.base-image="${DEERFLOW_BASE_IMAGE}" \
      io.workbench.deerflow.runtime-base-image="cgr.dev/chainguard/wolfi-base@sha256:1c451d46a0d5c4e9f2b38e0e8d3e299564a1aa95c21973efcc1980a9d1d2e73e" \
      io.workbench.deerflow.validator-node-image="${DEERFLOW_NODE_IMAGE}" \
      io.workbench.deerflow.source-commit="${DEERFLOW_SOURCE_COMMIT}" \
      io.workbench.deerflow.tool-scope-patch-sha256="${WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256}" \
      io.workbench.deerflow.contract-version="1"

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache \
      ca-certificates-bundle=20260909-r3 \
      python-3.12=3.12.15-r3 \
      uv=0.13.0-r0 \
      libstdc++=16.2.0-r1 \
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

COPY integrations/deerflow/base-recovery/ /opt/workbench/deerflow/base-recovery/
COPY integrations/deerflow/runtime-security/dependencies.json \
     integrations/deerflow/runtime-security/source-snapshot.json \
     integrations/deerflow/runtime-security/prepare_source.py \
     integrations/deerflow/runtime-security/test_runtime.py \
     integrations/deerflow/runtime-security/uv.lock \
     /opt/workbench/deerflow/runtime-security/
COPY integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2/ /opt/workbench/deerflow/source-patch/
# The dedicated BuildKit bridge may inherit a host proxy that returns 502 for
# PyPI while direct egress from the isolated builder is healthy. Keep
# dependency resolution inside the builder, but do not let that proxy turn a
# transient network issue into a 60-minute release timeout.
RUN --mount=from=recovered-source,source=/,target=/source-ro \
    python3 /opt/workbench/deerflow/runtime-security/prepare_source.py \
      --source-root /source-ro --destination /app/backend \
      --recovery-root /opt/workbench/deerflow/base-recovery \
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
COPY integrations/deerflow/skills/workbench/ /app/skills/public/workbench/
COPY integrations/deerflow/skills/requirement-doc-template/ /app/skills/public/requirement-doc-template/
COPY integrations/deerflow/runtime-tools/deerflow_workbench_tools/ /app/backend/deerflow_workbench_tools/
COPY integrations/deerflow/runtime-tools/config.fragment.yaml /opt/workbench/deerflow/config.fragment.yaml
COPY deploy/deerflow-extensions.production.json /app/backend/extensions_config.workbench.json

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
      uv run --no-sync python -c 'import hashlib; from types import SimpleNamespace; from deerflow_workbench_tools.prd_reference_tool import workbench_prd_reference_read; tool = workbench_prd_reference_read; schema = tool.tool_call_schema.model_json_schema(); properties = schema.get("properties", {}); expected_paths = ["/mnt/skills/public/requirement-doc-template/SKILL.md", "/mnt/skills/public/requirement-doc-template/references/structure.md", "/mnt/skills/public/requirement-doc-template/references/quality-standards.md", "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json"]; assert tool.name == "read_file" and list(properties) == ["description", "path"] and schema.get("required") == ["description", "path"] and properties["path"].get("enum") == expected_paths and "start_line" not in properties and "end_line" not in properties; content = tool.func(runtime=SimpleNamespace(context={"workbench": {"requestedArtifactKinds": ["prd"]}}), description="Verify the pinned PRD skill", path=expected_paths[0]); assert hashlib.sha256(content.encode("utf-8")).hexdigest() == "fe1493653986206aeed4684b46235c41d58e1e49db2b143ec0be5840542446e0"' \
    && PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python -c 'from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result; result = validate_runtime_result({}); assert result["protocol"] == "workbench.runtime.validation.v1" and result["ok"] is False and result["issues"]' \
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
