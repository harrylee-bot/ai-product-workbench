// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { GenerationPreview, GenerationPreviewNode } from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { generationPreviewTree, WorkbenchGenerationPreview } from "./workbench-generation-preview";

afterEach(cleanup);
const preview: GenerationPreview = { artifactIndex: 0, kind: "prd", title: "采购审批", markdown: "## 业务规则\n\n提交后进入审批。", screens: [] };

describe("live generation canvas", () => {
  it("updates rendered document prose while generation is still active", () => {
    const { rerender } = render(<WorkbenchGenerationPreview previews={[preview]} />);
    expect(screen.getByRole("status").textContent).toContain("正在生成");
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

  it("shows an independent dock skeleton before the first preview arrives", () => {
    render(<WorkbenchGenerationPreview previews={[]} generationStage="generating-ui" runStatus="running" />);

    expect(screen.getByRole("region", { name: "生成中预览" }).getAttribute("data-workbench-generation-preview-layout"))
      .toBe("dock");
    expect(screen.getByText("生成界面，首个结构片段到达后会立即显示。")).toBeTruthy();
  });
});
