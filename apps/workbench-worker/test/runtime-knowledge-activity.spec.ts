import { describe, it, expect } from "vitest";
import { RuntimeKnowledgeActivity } from "../src/runtime/runtime-knowledge-activity.js";
import { knowledgeCitationFixture as citation } from "./runtime-prd-result.fixture.js";
const response = {
  protocol: "workbench.knowledge-retrieval-result.v1",
  evidence: {
    schema: "workbench.knowledge-retrieval-evidence.v1", mode: "hybrid", routeScope: "production",
    release: { id: "release-1", key: "vault", version: 1 },
    embeddingProfile: { id: "embedding", specSha256: "a".repeat(64), dimension: 3 },
    retrievalProfile: { id: "retrieval", specSha256: "b".repeat(64) },
    candidateCounts: { lexical: 1, dense: 1, fused: 1 }, fusion: { algorithm: "rrf", k: 60 },
    reranker: { status: "not_needed" }, degraded: false,
  },
  items: [{ rank: 1, rrfScore: 0.03, rerankerScore: null, citation }],
};
const human = { type: "human", content: "当前需求" };
const call = { type: "ai", tool_calls: [{ id: "retrieve-1", name: "workbench_knowledge_retrieve", args: { query: "抽奖次数限制" } }] };
const tool = { type: "tool", name: "workbench_knowledge_retrieve", tool_call_id: "retrieve-1", status: "success", content: JSON.stringify(response) };
const tracker = () => new RuntimeKnowledgeActivity("attempt-1", "release-1");
describe("knowledge process facts", () => {
  it("emits a query and updates the same activity from matching tool evidence without duplicates", () => {
    const t = tracker();
    const running = t.push({ messages: [human, call] });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ status: "running", detail: "检索问题：抽奖次数限制" });
    const completed = t.push({ messages: [human, call, tool] });
    expect(completed[0]).toMatchObject({ activityId: running[0]!.activityId, status: "succeeded" });
    expect(completed[0]!.detail).toContain(citation.title ?? citation.sourcePath);
    expect(completed[0]!.detail).toContain("返回 1 条资料片段");
    expect(t.push({ messages: [human, call, tool] })).toEqual([]);
  });
  it("does not copy assistant reasoning, old turns, or unpaired responses", () => {
    expect(tracker().push({ messages: [human, call, tool, human, { type: "ai", content: "private thought", reasoning: "private thought" }, tool] })).toEqual([]);
    expect(tracker().push({ messages: [call, tool] })).toEqual([]);
    expect(new RuntimeKnowledgeActivity("attempt-1", null).push({ messages: [human, call, tool] })).toEqual([]);
  });
  it("supports serialized message envelopes and OpenAI tool declarations", () => {
    const c = { type: "ai", additional_kwargs: { tool_calls: [{ id: "retrieve-1", function: { name: "workbench_knowledge_retrieve", arguments: JSON.stringify({ query: "活动规则" }) } }] } };
    expect(tracker().push({ values: { messages: [human, c, tool].map(kwargs => ({ kwargs })) } })[0]).toMatchObject({ status: "succeeded" });
    expect(tracker().push({ messages: [human, c, tool].map((kwargs, index) => ({
      lc: 1, type: "constructor", id: ["langchain_core", "messages", ["HumanMessage", "AIMessage", "ToolMessage"][index]], kwargs,
    })) })[0]).toMatchObject({ status: "succeeded" });
  });
  it.each(["error", "wrong-release", "malformed", "duplicate"])("keeps %s results out of evidence", mode => {
    const bad = mode === "wrong-release" ? { ...tool, content: JSON.stringify({ ...response, evidence: { ...response.evidence, release: { id: "other", key: "vault", version: 1 } } }) }
      : mode === "malformed" ? { ...tool, content: "not json" } : mode === "error" ? { ...tool, status: "error" } : tool;
    const effects = tracker().push({ messages: [human, call, bad, ...(mode === "duplicate" ? [tool] : [])] });
    expect(effects[0]).toMatchObject({ status: "failed" });
    expect(effects[0]!.detail).not.toContain("返回 1 条");
  });
  it("labels empty results and redacts capability tokens in query text", () => {
    const c = { ...call, tool_calls: [{ ...call.tool_calls[0], args: { query: "规则 wbkg1.secret.secret" } }] };
    const effects = tracker().push({ messages: [human, c, { ...tool, content: JSON.stringify({ ...response, items: [] }) }] });
    expect(effects[0]!.detail).toContain("尚无可引用资料");
    expect(effects[0]!.detail).not.toContain("secret");
  });
});
