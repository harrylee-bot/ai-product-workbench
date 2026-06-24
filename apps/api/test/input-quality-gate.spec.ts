import { describe, expect, it } from "vitest";
import { assessInputQuality } from "../src/ai/input-quality-gate";

describe("input quality gate", () => {
  it("passes rich product and interaction input", () => {
    const result = assessInputQuality(
      "为运营后台做签到活动配置页面，需要配置奖励规则、每日一次限制、未开始/进行中/已结束状态、按钮点击后的成功和重复签到提示，目标是提升留存。",
      [],
    );

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.status).toBe("pass");
    expect(result.shouldBlock).toBe(false);
  });

  it("blocks template attachments that contain no parsed requirement content", () => {
    const result = assessInputQuality("做一下这个需求", [
      { fileId: "file-1", fileName: "需求文档模板.docx", fileType: "docx" },
    ]);

    expect(result.status).toBe("must_optimize");
    expect(result.shouldBlock).toBe(true);
    expect(result.hardGateTriggered).toBe(true);
    expect(result.suggestions).toContain("重新上传可解析的需求文档，或在消息里粘贴附件中的关键内容。");
  });
});
