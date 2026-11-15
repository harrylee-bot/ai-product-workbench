import { describe, expect, it } from "vitest";
import { formatPrototypeReviewPrompt, prototypePlanDisplayPrompt } from "../src/modules/prototypes/prototype-plan-presentation.js";

const anchor = { pageId: "screen-subscribe", selector: 'button[data-wb-node="node-subscribe"]', quote: "订阅" };
const feedback = { id: "feedback_private_1", body: "按钮改为确认订阅\n保留其他交互。", anchor };
const internalPrompt = `只调整按钮文字。\n${JSON.stringify(feedback)}`;
const legacy = { prompt: internalPrompt, sourceRevisionId: "revision_source", feedbackIds: [feedback.id], generationRequest: { prompt: internalPrompt } };

describe("prototype plan presentation", () => {
  it("uses page and selected text labels while keeping all review text", () => {
    const display = formatPrototypeReviewPrompt("只调整按钮文字。", [feedback], [{ id: anchor.pageId, title: "订阅页面" }]);
    expect(display).toBe("只调整按钮文字。\n- 订阅页面 · 订阅：按钮改为确认订阅\n保留其他交互。");
    for (const internal of [feedback.id, anchor.pageId, anchor.selector, '"anchor"']) expect(display).not.toContain(internal);
  });

  it("projects an exact earlier generated suffix without changing pinned inputs", () => {
    const before = structuredClone(legacy);
    const display = prototypePlanDisplayPrompt(legacy);
    expect(display).toBe("只调整按钮文字。\n- 订阅：按钮改为确认订阅\n保留其他交互。");
    expect(legacy).toEqual(before);
    expect(prototypePlanDisplayPrompt({ ...legacy, prompt: display })).toBe(display);
  });

  it("preserves authored JSON and prose before the generated suffix", () => {
    const authored = '用户提供的格式：\n{"anchor":"不要删除这段用户内容"}';
    const prompt = `${authored}\n${JSON.stringify(feedback)}`;
    expect(prototypePlanDisplayPrompt({ ...legacy, prompt, generationRequest: { prompt } })).toBe(`${authored}\n- 订阅：${feedback.body}`);
    expect(prototypePlanDisplayPrompt({ ...legacy, sourceRevisionId: null })).toBe(internalPrompt);
  });

  it.each([
    { feedbackIds: ["unrelated_feedback"] },
    { feedbackIds: [feedback.id, feedback.id] },
    { generationRequest: { prompt: "different pinned request" } },
    { prompt: '用户自己输入的 JSON：\n{"anchor":null}' },
  ])("does not heuristically strip unrelated or malformed content: %j", (change) => {
    const row = { ...legacy, ...change };
    expect(prototypePlanDisplayPrompt(row)).toBe(row.prompt);
  });

  it("drops optional location labels before dropping any review text", () => {
    const comments = Array.from({ length: 5 }, () => ({ body: "字".repeat(3950), anchor }));
    const result = formatPrototypeReviewPrompt(undefined, comments, [{ id: anchor.pageId, title: "页".repeat(240) }]);
    expect(result.length).toBeLessThanOrEqual(20_000);
    expect(result.split("字").length - 1).toBe(19_750);
    expect(result).not.toContain(anchor.selector);
  });
});
