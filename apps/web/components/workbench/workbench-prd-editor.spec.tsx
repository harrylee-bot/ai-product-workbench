// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  prdTableOfContentsEntriesFor,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchPrdArtifactEditor } from "./workbench-prd-editor";
import { prdDocument } from "./workbench-prd-test-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkbenchPrdArtifactEditor", () => {
  it("mounts the Tiptap editor over the persisted PRD projection", async () => {
    const onDocumentCommit = vi.fn(async () => undefined);
    render(
      <WorkbenchPrdArtifactEditor
        document={prdDocument()}
        onDocumentCommit={onDocumentCommit}
        reference={{ artifactId: "artifact-1", artifactVersionId: "version-1", projectId: "project-1" }}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "PRD 编辑器" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Production PRD" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "保存 PRD" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "撤销 PRD 编辑" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onDocumentCommit).not.toHaveBeenCalled();
  });

  it("keeps the command boundary explicit when the editor is busy", async () => {
    const onDocumentCommit = vi.fn(async () => undefined);
    render(
      <WorkbenchPrdArtifactEditor
        document={prdDocument()}
        editingBusy
        onDocumentCommit={onDocumentCommit}
        reference={{ artifactId: "artifact-1", artifactVersionId: "version-1", projectId: "project-1" }}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "PRD 编辑器" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "正在保存 PRD" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "撤销 PRD 编辑" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("mounts PRD v2 with its fixed template structures protected", async () => {
    const onDocumentCommit = vi.fn(async () => undefined);
    const rendered = render(
      <WorkbenchPrdArtifactEditor
        document={prdDocumentV2Example}
        onDocumentCommit={onDocumentCommit}
        reference={{ artifactId: "artifact-1", artifactVersionId: "version-v2", projectId: "project-1" }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "示例工单需求说明书" })).not.toBeNull();
    expect(rendered.container.querySelectorAll("[data-prd-fixed-block]").length).toBeGreaterThan(10);
    expect((screen.getByRole("button", { name: "保存 PRD" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders an additional PRD v2 business section in the editor", async () => {
    const document = structuredClone(prdDocumentV2Example);
    document.sections.businessRequirements.additionalSections = [{
      title: "2.5 配置规则",
      blocks: [{
        id: "additional-config-rule",
        type: "paragraph",
        content: [{ type: "text", text: "补充业务配置规则及对应结果。", marks: [] }],
      }],
    }];
    document.tableOfContents.entries = prdTableOfContentsEntriesFor(["2.5 配置规则"]);

    render(
      <WorkbenchPrdArtifactEditor
        document={document}
        onDocumentCommit={vi.fn(async () => undefined)}
        reference={{ artifactId: "artifact-1", artifactVersionId: "version-v2-extra", projectId: "project-1" }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "2.5 配置规则" })).not.toBeNull();
    expect(screen.getByText("补充业务配置规则及对应结果。")).not.toBeNull();
  });
});
