ARG DEERFLOW_PARENT_IMAGE=workbench-candidate-57b0ce8a-deerflow:functional-v4

FROM ${DEERFLOW_PARENT_IMAGE} AS validation

USER root

COPY --chown=0:0 --chmod=0644 workbench_tool_scope_middleware.py /app/backend/packages/harness/deerflow/agents/middlewares/workbench_tool_scope_middleware.py
COPY --chown=0:0 --chmod=0644 source-patch/manifest.json /opt/workbench/deerflow/source-patch/manifest.json
COPY --chown=0:0 --chmod=0644 source-patch/test_workbench_tool_scope_middleware.py /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py
COPY --chown=0:0 --chmod=0644 source-patch/workbench_tool_scope_middleware.py /opt/workbench/deerflow/source-patch/workbench_tool_scope_middleware.py
COPY --chown=0:0 --chmod=0644 workbench-skill/SKILL.md /app/skills/public/workbench/SKILL.md

RUN test "$(sha256sum /app/backend/packages/harness/deerflow/agents/middlewares/workbench_tool_scope_middleware.py | awk '{print $1}')" = "18c84ae41be8d363b7ced1ea7e20093c9e8fd8e0df619975ef5cfd530fbaa0f1" \
    && test "$(sha256sum /opt/workbench/deerflow/source-patch/manifest.json | awk '{print $1}')" = "c21187eb45c1a2f712df008e326fe93d3ba9c886d917cb4a3d11276dd367fd4b" \
    && test "$(sha256sum /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py | awk '{print $1}')" = "2c5392086199cbce1b97bdbf93a675dad11d1752c4afed93be9d170bc02c6792" \
    && test "$(sha256sum /app/skills/public/workbench/SKILL.md | awk '{print $1}')" = "7cd6f9377ef25b6a2ac92a38049b29878e208ee9cb501096303913bcc5d72ded" \
    && cd /app/backend \
    && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync python /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py \
    && python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit 7a6c4a994a86583d2a3c056ee9d0f157d4f030c2 \
      --check

FROM ${DEERFLOW_PARENT_IMAGE} AS runtime

ARG DEERFLOW_PARENT_IMAGE
ARG WORKBENCH_SOURCE_COMMIT=71d75aa04259f2c8c8d46362d9e5c1b2d00aaf63
ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=c21187eb45c1a2f712df008e326fe93d3ba9c886d917cb4a3d11276dd367fd4b

LABEL org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.tool-scope-patch-sha256="${WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256}" \
      io.workbench.deerflow.incremental-parent-image="${DEERFLOW_PARENT_IMAGE}" \
      io.workbench.deerflow.incremental-parent-image-id="sha256:6491dc11376e66f71006062c33d646dc25d847a90ddb1d7324992a0097b24009" \
      io.workbench.deerflow.prototype-subagent-policy="lead-direct-v1" \
      io.workbench.deerflow.workbench-skill-sha256="7cd6f9377ef25b6a2ac92a38049b29878e208ee9cb501096303913bcc5d72ded"

USER root

COPY --from=validation --chown=0:0 --chmod=0644 /app/backend/packages/harness/deerflow/agents/middlewares/workbench_tool_scope_middleware.py /app/backend/packages/harness/deerflow/agents/middlewares/workbench_tool_scope_middleware.py
COPY --from=validation --chown=0:0 --chmod=0644 /opt/workbench/deerflow/source-patch/manifest.json /opt/workbench/deerflow/source-patch/manifest.json
COPY --from=validation --chown=0:0 --chmod=0644 /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py /opt/workbench/deerflow/source-patch/test_workbench_tool_scope_middleware.py
COPY --from=validation --chown=0:0 --chmod=0644 /opt/workbench/deerflow/source-patch/workbench_tool_scope_middleware.py /opt/workbench/deerflow/source-patch/workbench_tool_scope_middleware.py
COPY --from=validation --chown=0:0 --chmod=0644 /app/skills/public/workbench/SKILL.md /app/skills/public/workbench/SKILL.md

RUN python3 /opt/workbench/deerflow/source-patch/apply.py \
      --root /app/backend/packages/harness \
      --gateway-root /app/backend \
      --source-commit 7a6c4a994a86583d2a3c056ee9d0f157d4f030c2 \
      --check

USER 65532:65532
