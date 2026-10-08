import { parseKnowledgeSource } from "@workbench/workbench-knowledge";
import { artifactKnowledgeMarkdown } from "../src/modules/artifacts/artifact-knowledge-markdown.js";

describe("Finalized artifact business semantics", () => {
  const render = (content: Parameters<typeof artifactKnowledgeMarkdown>[1]) => artifactKnowledgeMarkdown("Confirmed", content);

  it("preserves PRD channel switches, safety decisions, table coordinates and directed edges", () => {
    const original = {
      protocol: "workbench.prd.v2",
      sections: {
        channels: [{ channel: "wapH5", enabled: true }],
        safetyBaseline: { rows: [{ sequence: 1, applicability: "是", remarks: "已满足" }] },
        table: { columns: [{ id: "amount", label: "额度" }], rows: [{ id: "standard", cells: [{ columnId: "amount", value: 0 }] }] },
        graph: { nodes: [{ id: "start" }, { id: "end" }], edges: [{ from: "start", to: "end", label: "通过" }] },
      },
    };
    const baseline = render(original);
    for (const change of [
      (value: typeof original) => { value.sections.channels[0]!.enabled = false; },
      (value: typeof original) => { value.sections.safetyBaseline.rows[0]!.applicability = "否"; },
      (value: typeof original) => { value.sections.table.rows[0]!.cells[0]!.columnId = "balance"; },
      (value: typeof original) => { value.sections.graph.edges[0]!.to = "start"; },
    ]) {
      const changed = structuredClone(original);
      change(changed);
      expect(render(changed)).not.toBe(baseline);
    }
    expect(baseline).toContain('"columnId": "amount"');
    expect(baseline).toContain('"value": 0');
    expect(baseline).toContain('"enabled": true');
  });

  it("keeps prototype state values and binding sources linked to actions and screens", () => {
    const original = {
      protocol: "workbench.prototype.v1",
      screens: [{ id: "checkout", rootNodeId: "form" }],
      nodes: [{ id: "submit", kind: "button", enabled: false }],
      variables: [{ name: "accepted", initialValue: false }],
      states: [{ id: "ready", screenId: "checkout", values: { accepted: true } }],
      actions: [{ nodeId: "submit", event: "click", kind: "setState", targetStateId: "ready" }],
      bindings: [{ nodeId: "submit", property: "enabled", source: { kind: "state", stateId: "ready", field: "accepted" } }],
      assets: [{ blobId: "private-blob" }],
    };
    const baseline = render(original);
    expect(baseline).toContain('"source"."stateId": "ready"');
    expect(baseline).toContain('"targetStateId": "ready"');
    expect(baseline).not.toContain("private-blob");
    const changed = structuredClone(original);
    changed.bindings[0]!.source.stateId = "blocked";
    expect(render(changed)).not.toBe(baseline);
  });

  it("is deterministic and cannot turn content into vault links or storage declarations", () => {
    const content = { protocol: "workbench.prd.v2", sections: {
      title: "---\nstatus: 不参与检索\n---",
      text: "[[private]] ![file](storage/private.bin) <script>secret</script>",
    }, citations: [{ sourcePath: "private/source.md" }] };
    const markdown = render(content);
    expect(render({ sections: content.sections, citations: content.citations, protocol: content.protocol })).toBe(markdown);
    const parsed = parseKnowledgeSource({ path: "02-finalized/business.md", content: markdown });
    expect(parsed.route).toBe("production");
    expect(parsed.references).toEqual([]);
    expect(markdown).not.toContain("private/source.md");
    expect(markdown).not.toContain("storage/private.bin");
  });
});
