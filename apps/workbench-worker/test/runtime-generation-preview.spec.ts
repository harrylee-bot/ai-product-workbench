import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RuntimeGenerationPreview, projectGenerationPreview } from "../src/runtime/runtime-generation-preview.js";

const chunk = (args: string, name: string | null = null, id = "message-1") => [{
  type: "AIMessageChunk", id, tool_call_chunks: [{ index: 0, name, args }],
}, { langgraph_node: "lead_agent" }];

describe("generation previews from unfinished tool arguments", () => {
  it("renders partial prose before the argument string or the tool call is complete, with bounded sampling", () => {
    let now = 0;
    const preview = new RuntimeGenerationPreview(["prd"], () => now);
    const prefix = '{"artifact_index":0,"draft":{"kind":"prd","title":"采购需求","content":{"sections":{"introduction":{"title":"引言","background":{"blocks":[{"type":"paragraph","content":[{"type":"text","text":"审批';
    expect(preview.push("messages", chunk(prefix, "workbench_artifact_draft_publish"))[0]?.markdown).toContain("审批");
    for (let index = 0; index < 1_000; index += 1) expect(preview.push("messages", chunk("流"))).toEqual([]);
    now = 300;
    const next = preview.push("messages", chunk("程"));
    expect(next).toHaveLength(1);
    expect(next[0]?.markdown).toContain(`审批${"流".repeat(1_000)}程`);
    expect(next[0]?.markdown).not.toContain("artifact_index");
  });

  it("isolates messages and requested kinds and ignores unrelated tools", () => {
    const preview = new RuntimeGenerationPreview(["prototype"]);
    const args = JSON.stringify({ artifact_index: 0, draft: { kind: "prd", title: "private" } });
    expect(preview.push("messages", chunk(args, "workbench_artifact_draft_publish"))).toEqual([]);
    expect(preview.push("messages", chunk(args, "read_file", "message-2"))).toEqual([]);
    expect(preview.push("values", chunk(args, "workbench_artifact_draft_publish"))).toEqual([]);
  });

  it("projects actual prototype nodes while excluding executable actions and asset URLs", () => {
    const example = JSON.parse(readFileSync(new URL("../../../integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json", import.meta.url), "utf8"));
    const projected = projectGenerationPreview(0, example.artifacts[0]);
    expect(projected?.screens[0]?.nodes.map((node) => node.kind)).toContain("input");
    expect(projected?.screens[0]?.nodes.find((node) => node.kind === "button")?.text).toBeTruthy();
    expect(JSON.stringify(projected)).not.toContain("actionIds");
    expect(JSON.stringify(projected)).not.toContain("bindingIds");
  });

  it("redacts capabilities, bounds prose, and rejects an out-of-range artifact index", () => {
    const draft = { kind: "prd", title: "标题 wbkg1.hidden", content: { sections: { introduction: { blocks: [{ type: "paragraph", content: [{ text: "wbct1.secret " + "文".repeat(60_000) }] }] } } } };
    const projected = projectGenerationPreview(0, draft);
    expect(JSON.stringify(projected)).not.toMatch(/wbkg1|wbct1/);
    expect(projected?.markdown.length).toBeLessThanOrEqual(48_000);
    expect(projectGenerationPreview(20, draft)).toBeNull();
  });
});
