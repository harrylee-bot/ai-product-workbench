import { ProductDesignStateStatus, ProjectStatus } from "@prisma/client";
import type { ProductDesignState, QAReport, QAReportStatus } from "./ai-vibe.types";

type ProductStateLike = Pick<ProductDesignState, "status"> | null | undefined;

export function projectStatusFromProductDesignState(
  state: ProductStateLike,
  fallback: ProjectStatus = ProjectStatus.draft,
): ProjectStatus {
  return projectStatusFromProductDesignStateStatus(state?.status, fallback);
}

export function projectStatusFromProductDesignStateStatus(
  status: ProductDesignStateStatus | ProductDesignState["status"] | null | undefined,
  fallback: ProjectStatus = ProjectStatus.draft,
): ProjectStatus {
  if (!status) return fallback;
  if (status === ProductDesignStateStatus.clarifying) return ProjectStatus.clarifying;
  if (status === ProductDesignStateStatus.prd_ready) return ProjectStatus.prd_ready;
  if (status === ProductDesignStateStatus.prototype_ready) return ProjectStatus.prototype_ready;
  if (status === ProductDesignStateStatus.patching) return ProjectStatus.designing;
  if (status === ProductDesignStateStatus.qa_failed) return ProjectStatus.qa_failed;
  if (status === ProductDesignStateStatus.confirmed) return ProjectStatus.completed;
  return fallback;
}

export function projectStatusAfterQa(input: {
  qaStatus: QAReportStatus;
  currentProjectStatus: ProjectStatus;
  productDesignState?: ProductStateLike;
}): ProjectStatus {
  if (isLifecycleLockedProjectStatus(input.currentProjectStatus)) return input.currentProjectStatus;
  if (input.qaStatus === "failed") return ProjectStatus.qa_failed;
  return projectStatusFromProductDesignState(input.productDesignState, input.currentProjectStatus);
}

export function projectStatusForCompletedArtifacts(input: {
  productDesignState?: ProductStateLike;
  qaReport?: Pick<QAReport, "status"> | null;
  fallback?: ProjectStatus;
}): ProjectStatus {
  if (input.qaReport?.status === "failed") return ProjectStatus.qa_failed;
  return projectStatusFromProductDesignState(input.productDesignState, input.fallback ?? ProjectStatus.draft);
}

function isLifecycleLockedProjectStatus(status: ProjectStatus) {
  return status === ProjectStatus.archived || status === ProjectStatus.deleted;
}
