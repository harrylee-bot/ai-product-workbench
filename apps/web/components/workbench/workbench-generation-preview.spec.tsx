// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GenerationPreview, GenerationPreviewNode } from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationPreviewTree, WorkbenchGenerationPreview } from "./workbench-generation-preview";

vi.mock("./workbench-artifact-content", () => ({
  WorkbenchArtifactContent: ({ reference }: { reference: { artifactId: string } }) => (
    <div data-testid="final-artifact-content">{reference.artifactId}</div>
  ),
}));

afterEach(cleanup);
const preview: GenerationPreview = { artifactIndex: 0, kind: "prd", title: "采购审批", markdown: "## 业务规则\n\n提交后进入审批。", screens: [] };

describe("live generation canvas", () => {
  it("updates rendered document prose while generation is still active", () => {
    const { rerender } = render(<WorkbenchGenerationPreview previews={[preview]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("heading", { name: "业务规则" })).toBeTruthy();
    expect(screen.getByText("提交后进入审批。")).toBeTruthy();
    rerender(<WorkbenchGenerationPreview previews={[{ ...preview, markdown: `${preview.markdown}\n\n## 验收标准\n\n审批人可查看详情。` }]} />);
    expect(screen.getByRole("heading", { name: "验收标准" })).toBeTruthy();
    expect(screen.getByText("审批人可查看详情。")).toBeTruthy();
    rerender(<WorkbenchGenerationPreview previews={[]} />);
    expect(screen.queryByRole("region", { name: "生成中预览" })).toBeNull();
  });

  it("renders prototype components through json-render without executing source actions", () => {
    const node: GenerationPreviewNode = { id: "submit", parentId: null, kind: "button", text: "提交审批", x: 20, y: 20, width: 200, height: 40, absolute: true, direction: "column", gap: 0, padding: 0, fill: "#7467f6", color: "#ffffff", fontSize: 14, radius: 4 };
    render(<WorkbenchGenerationPreview previews={[{ ...preview, kind: "prototype", markdown: "", screens: [{ id: "screen", name: "采购申请", width: 390, height: 844, nodes: [node] }] }]} />);
    const button = screen.getByRole("button", { name: "提交审批" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.style.left).toBe("20px");
    const tree = generationPreviewTree([{ ...node, id: "a", parentId: "b" }, { ...node, id: "b", parentId: "a" }]);
    expect(Object.keys(tree.elements)).toEqual(["preview-screen"]);
  });

  it("does not show a preview shell before generated content arrives", () => {
    render(<WorkbenchGenerationPreview previews={[]} runStatus="running" />);
    expect(screen.queryByRole("region", { name: "生成中预览" })).toBeNull();
    expect(screen.queryByText("生成过程")).toBeNull();
  });
  it("starts prototype screens at the top while keeping document auto-follow", () => {
    const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1200);
    try {
      const { container, rerender } = render(<WorkbenchGenerationPreview previews={[preview]} />);
      const viewport = container.querySelector<HTMLElement>("[data-workbench-generation-preview-scroll]")!;
      expect(viewport.scrollTop).toBe(1200);
      const prototype: GenerationPreview = {
        ...preview, kind: "prototype", markdown: "",
        screens: [{ id: "screen-1", name: "采购申请", width: 390, height: 844, nodes: [{ id: "heading", parentId: null, kind: "text", text: "已生成内容", x: 0, y: 0, width: 200, height: 40, absolute: false, direction: "column", gap: 0, padding: 0, fill: null, color: null, fontSize: 14, radius: 0 }] },
          { id: "screen-2", name: "采购审批", width: 390, height: 844, nodes: [{ id: "heading", parentId: null, kind: "text", text: "已生成内容", x: 0, y: 0, width: 200, height: 40, absolute: false, direction: "column", gap: 0, padding: 0, fill: null, color: null, fontSize: 14, radius: 0 }] }],
      };
      rerender(<WorkbenchGenerationPreview previews={[prototype]} />);
      expect(viewport.scrollTop).toBe(0);
      viewport.scrollTop = 200;
      rerender(<WorkbenchGenerationPreview previews={[{ ...prototype, title: "增量更新" }]} />);
      expect(viewport.scrollTop).toBe(200);
      fireEvent.click(screen.getByRole("button", { name: "采购审批" }));
      expect(viewport.scrollTop).toBe(0);
    } finally {
      height.mockRestore();
    }
  });
  it("keeps process, stages, timing, and cancellation out of generated content", () => {
    const { container } = render(<WorkbenchGenerationPreview previews={[preview]} runStatus="running" />);
    expect(screen.getByText("提交后进入审批。")).toBeTruthy();
    expect(screen.queryByText("生成过程")).toBeNull();
    expect(screen.queryByText("当前文档结构")).toBeNull();
    expect(screen.queryByText("理解需求")).toBeNull();
    expect(container.querySelector("[data-generation-step]")).toBeNull();
    expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();
  });

  it("switches the same dock to the final artifact after completion", () => {
    const { rerender } = render(
      <WorkbenchGenerationPreview previews={[preview]} runId="run-1" runStatus="running" />,
    );
    const region = screen.getByRole("region", { name: "生成中预览" });

    rerender(
      <WorkbenchGenerationPreview
        finalArtifactReferences={[{ artifactId: "artifact-1", artifactVersionId: "version-1", projectId: "project-1" }]}
        previews={[]}
        runId="run-1"
        runStatus="succeeded"
      />,
    );

    expect(screen.getByRole("region", { name: "生成结果预览" })).toBe(region);
    expect(region.getAttribute("data-workbench-generation-preview"))
      .toBe("final");
    expect(screen.getByTestId("final-artifact-content").textContent).toBe("artifact-1");
    fireEvent.click(screen.getByRole("button", { name: "关闭最终预览" }));
    expect(screen.queryByRole("region", { name: "生成结果预览" })).toBeNull();
  });
});
