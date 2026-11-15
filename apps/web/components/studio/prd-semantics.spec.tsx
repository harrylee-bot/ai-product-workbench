// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  prdSafetyBaselineItems,
  prdChannelLabels,
  prdDocumentDiagrams,
  type JsonValue,
} from "@workbench/workbench-contracts";
import { StructuredContent } from "./content";
import userEvent from "@testing-library/user-event";
import { PrdVersionHistory, layoutPrdDiagram } from "./prd-semantics";
afterEach(cleanup);
describe("Studio typed PRD reading", () => {
  it("allows typing multiple revision participants without erasing the separator", async () => {
    function Form() {
      const [entries, setEntries] = React.useState(
        structuredClone(prdDocumentV3Example.versionHistory),
      );
      return (
        <>
          <PrdVersionHistory entries={entries} onChange={setEntries} />
          <output>{entries[0]!.participants.join("|")}</output>
        </>
      );
    }
    render(<Form />);
    const user = userEvent.setup(),
      input = screen.getByLabelText("版本1参与者");
    await user.clear(input);
    await user.type(input, "产品负责人、测试负责人");
    expect((input as HTMLInputElement).value).toBe("产品负责人、测试负责人");
    expect(screen.getByRole("status").textContent).toBe(
      "产品负责人|测试负责人",
    );
  });

  it("renders all canonical requirements, scopes, intro, answers and human channel labels", () => {
    render(
      <StructuredContent
        value={prdDocumentV3Example as unknown as JsonValue}
      />,
    );
    const baseline = screen.getByRole("region", {
      name: "4 需求安全基线要求（必填）",
    });
    for (const item of prdSafetyBaselineItems)
      expect(
        within(baseline).getByText(item.requirement, { exact: true }),
      ).toBeTruthy();
    expect(within(baseline).getAllByRole("row")).toHaveLength(22);
    for (const line of prdDocumentV3Example.sections.safetyBaseline.intro.split(
      "\n",
    ))
      expect(within(baseline).getByText(line, { exact: true })).toBeTruthy();
    expect(
      within(baseline).getByRole("columnheader", { name: "适用范围" }),
    ).toBeTruthy();
    const channels = screen.getByRole("region", { name: "活动投放渠道" });
    for (const name of Object.values(prdChannelLabels))
      expect(within(channels).getByRole("rowheader", { name })).toBeTruthy();
    expect(screen.queryByText("wapH5", { exact: true })).toBeNull();
  });
  it("renders every real node and directed edge with a text alternative, without internal IDs in prose", () => {
    const { container } = render(
      <StructuredContent
        value={prdDocumentV3Example as unknown as JsonValue}
      />,
    );
    for (const diagram of prdDocumentDiagrams(prdDocumentV3Example)) {
      const figure = screen.getByRole("figure", { name: diagram.title });
      expect(
        within(figure).getByRole("img", { name: diagram.title }),
      ).toBeTruthy();
      expect(figure.querySelectorAll("[data-prd-node]")).toHaveLength(
        diagram.nodes.length,
      );
      expect(
        figure.querySelectorAll("[data-prd-edge] path[marker-end]"),
      ).toHaveLength(diagram.edges.length);
      expect(within(figure).getAllByRole("listitem")).toHaveLength(
        diagram.edges.length,
      );
      for (const edge of diagram.edges) {
        expect(container.textContent).not.toContain(edge.id);
        expect(container.textContent).not.toContain(edge.from);
      }
    }
  });
  it("lays out the maximum bounded graph without dropping cycles or overlapping node boxes", () => {
    const base = prdDocumentDiagrams(prdDocumentV3Example)[0]!;
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `n${index}`,
      label: `第${index}个业务节点`,
      group: "业务能力",
    }));
    const edges = Array.from({ length: 80 }, (_, index) => ({
      id: `e${index}`,
      from: `n${index % 40}`,
      to: `n${(index + 1 + (index >= 40 ? 7 : 0)) % 40}`,
      label: index % 3 === 0 ? "业务分支" : null,
    }));
    const graph = layoutPrdDiagram({ ...base, nodes, edges });
    expect(graph.nodes).toHaveLength(40);
    expect(graph.edges).toHaveLength(80);
    expect(Number.isFinite(graph.width) && Number.isFinite(graph.height)).toBe(
      true,
    );
    for (const edge of graph.edges) {
      expect(edge.points.length).toBeGreaterThan(1);
      for (const point of edge.points)
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
    for (let a = 0; a < graph.nodes.length; a++)
      for (let b = a + 1; b < graph.nodes.length; b++) {
        const first = graph.nodes[a]!,
          second = graph.nodes[b]!;
        expect(
          Math.abs(first.x - second.x) >= (first.width + second.width) / 2 ||
            Math.abs(first.y - second.y) >= (first.height + second.height) / 2,
        ).toBe(true);
      }
  });
});
