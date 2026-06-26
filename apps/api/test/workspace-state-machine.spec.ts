import { ProductDesignStateStatus, ProjectStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  projectStatusAfterQa,
  projectStatusForCompletedArtifacts,
  projectStatusFromProductDesignStateStatus,
} from "../src/ai/workspace-state-machine";

describe("workspace state machine", () => {
  it("derives visible project status from ProductDesignState status", () => {
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.clarifying)).toBe(ProjectStatus.clarifying);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.intake)).toBe(ProjectStatus.designing);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.format_check)).toBe(ProjectStatus.designing);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.scoring)).toBe(ProjectStatus.designing);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.optimizing)).toBe(ProjectStatus.designing);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.doc_ready)).toBe(ProjectStatus.prd_ready);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.doc_confirmed)).toBe(ProjectStatus.prd_ready);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.prd_ready)).toBe(ProjectStatus.prd_ready);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.prototype_ready)).toBe(ProjectStatus.prototype_ready);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.qa_failed)).toBe(ProjectStatus.qa_failed);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.confirmed)).toBe(ProjectStatus.completed);
    expect(projectStatusFromProductDesignStateStatus(ProductDesignStateStatus.design_ready)).toBe(ProjectStatus.draft);
  });

  it("lets QA failure override artifact readiness", () => {
    expect(projectStatusForCompletedArtifacts({
      productDesignState: { status: "prototype_ready" },
      qaReport: { status: "failed" },
    })).toBe(ProjectStatus.qa_failed);
  });

  it("returns to ProductDesignState-derived status after QA passes or warns", () => {
    expect(projectStatusAfterQa({
      qaStatus: "passed",
      currentProjectStatus: ProjectStatus.qa_failed,
      productDesignState: { status: "doc_ready" },
    })).toBe(ProjectStatus.prd_ready);

    expect(projectStatusAfterQa({
      qaStatus: "warning",
      currentProjectStatus: ProjectStatus.qa_failed,
      productDesignState: { status: "prototype_ready" },
    })).toBe(ProjectStatus.prototype_ready);
  });

  it("does not unlock archived or deleted projects", () => {
    expect(projectStatusAfterQa({
      qaStatus: "passed",
      currentProjectStatus: ProjectStatus.archived,
      productDesignState: { status: "prototype_ready" },
    })).toBe(ProjectStatus.archived);

    expect(projectStatusAfterQa({
      qaStatus: "failed",
      currentProjectStatus: ProjectStatus.deleted,
      productDesignState: { status: "prototype_ready" },
    })).toBe(ProjectStatus.deleted);
  });
});
