ARG DEERFLOW_PARENT_IMAGE=workbench-candidate-f63eaebd-deerflow:functional-v15

FROM ${DEERFLOW_PARENT_IMAGE} AS runtime

ARG DEERFLOW_PARENT_IMAGE
ARG DEERFLOW_PARENT_IMAGE_ID=sha256:382e33c10d639d14bad38b75e9c45cbe959a97ff670aac78ca7e6ab2efd5dfec
ARG WORKBENCH_SOURCE_COMMIT=e15dc3f76f0dffa1a645d086d8f3993127d12a09
ARG WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_PATCH_SHA256
ARG WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_WORKER_SHA256=9424a47369bd557b7dcdd7688ec6e2310ee8aba8f240bde7d0597e1ca2a50d9d

LABEL org.opencontainers.image.title="Workbench DeerFlow Runtime" \
      org.opencontainers.image.revision="${WORKBENCH_SOURCE_COMMIT}" \
      io.workbench.deerflow.incremental-parent-image="${DEERFLOW_PARENT_IMAGE}" \
      io.workbench.deerflow.incremental-parent-image-id="${DEERFLOW_PARENT_IMAGE_ID}" \
      io.workbench.deerflow.fallback-rollback-patch-sha256="${WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_PATCH_SHA256}" \
      io.workbench.deerflow.worker-sha256="${WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_WORKER_SHA256}"

USER root

COPY --chown=0:0 --chmod=0755 apply.py /opt/workbench/deerflow/fallback-rollback-patch/apply.py
COPY --chown=0:0 --chmod=0644 manifest.json /opt/workbench/deerflow/fallback-rollback-patch/manifest.json
COPY --chown=0:0 --chmod=0644 test_workbench_fallback_rollback.py /opt/workbench/deerflow/fallback-rollback-patch/test_workbench_fallback_rollback.py

RUN test -n "${WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_PATCH_SHA256}" \
    && test "$(sha256sum /opt/workbench/deerflow/fallback-rollback-patch/manifest.json | awk '{print $1}')" = "${WORKBENCH_DEERFLOW_FALLBACK_ROLLBACK_PATCH_SHA256}" \
    && python3 /opt/workbench/deerflow/fallback-rollback-patch/apply.py \
      --root /app/backend/packages/harness \
      --parent-image "${DEERFLOW_PARENT_IMAGE}" \
      --parent-image-id "${DEERFLOW_PARENT_IMAGE_ID}" \
    && cd /app/backend \
    && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/backend/packages/harness:/app/backend \
      uv run --no-sync pytest -q \
        tests/test_run_worker_rollback.py \
        /opt/workbench/deerflow/fallback-rollback-patch/test_workbench_fallback_rollback.py \
    && python3 /opt/workbench/deerflow/fallback-rollback-patch/apply.py \
      --root /app/backend/packages/harness \
      --parent-image "${DEERFLOW_PARENT_IMAGE}" \
      --parent-image-id "${DEERFLOW_PARENT_IMAGE_ID}" \
      --check

USER 65532:65532
