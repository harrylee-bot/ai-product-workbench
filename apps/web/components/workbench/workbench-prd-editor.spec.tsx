// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  prdTableOfContentsEntriesFor,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchPrdArtifactEditor } from "./workbench-prd-editor";
import { prdDocument } from "./workbench-prd-test-fixture";
import { WorkbenchPrdDraftProvider } from "../../lib/workbench/prd-editor/draft-context";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("WorkbenchPrdArtifactEditor", () => {
  it("restores an edited author after deselection and supports explicit discard", async () => {
    const reference = { artifactId: "artifact-1", artifactVersionId: "version-v2", projectId: "project-1" };
    const onDocumentCommit = vi.fn(async () => "version-v3");
    const editor = <WorkbenchPrdArtifactEditor document={prdDocumentV2Example} onDocumentCommit={onDocumentCommit} reference={reference} />;
    const rendered = render(<WorkbenchPrdDraftProvider namespace="principal-1">{editor}</WorkbenchPrdDraftProvider>);
    fireEvent.change(await screen.findByRole("textbox", { name: "版本1作者" }), { target: { value: "审计保留草稿" } });
    rendered.rerender(<WorkbenchPrdDraftProvider namespace="principal-1"><div>其他产物</div></WorkbenchPrdDraftProvider>);
    rendered.rerender(<WorkbenchPrdDraftProvider namespace="principal-1">{editor}</WorkbenchPrdDraftProvider>);
    expect(await screen.findByRole("textbox", { name: "版本1作者" })).toHaveValue("审计保留草稿");
    expect(screen.getByRole("button", { name: "保存 PRD" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "放弃 PRD 修改" }));
    expect(screen.getByRole("textbox", { name: "版本1作者" })).toHaveValue(prdDocumentV2Example.versionHistory[0]!.author);
    expect(onDocumentCommit).not.toHaveBeenCalled();
  });

  it("retains failed edits and saves the edited structured document on retry", async () => {
    const onDocumentCommit = vi.fn().mockRejectedValueOnce(new Error("网络暂不可用")).mockResolvedValue("v3");
    render(<WorkbenchPrdDraftProvider namespace="principal-1"><WorkbenchPrdArtifactEditor
      document={prdDocumentV2Example} onDocumentCommit={onDocumentCommit}
      reference={{ artifactId: "artifact-1", artifactVersionId: "version-v2", projectId: "project-1" }}
    /></WorkbenchPrdDraftProvider>);
    fireEvent.change(await screen.findByRole("textbox", { name: "版本1作者" }), { target: { value: "已编辑作者" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 PRD" }));
    expect(await screen.findByText("网络暂不可用")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "版本1作者" })).toHaveValue("已编辑作者");
    fireEvent.click(screen.getByRole("button", { name: "保存 PRD" }));
    await waitFor(() => expect(onDocumentCommit).toHaveBeenCalledTimes(2));
    expect(onDocumentCommit.mock.calls[1]?.[1].versionHistory[0].author).toBe("已编辑作者");
    expect(onDocumentCommit.mock.calls[1]?.[1]).toEqual(onDocumentCommit.mock.calls[0]?.[1]);
  });

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
