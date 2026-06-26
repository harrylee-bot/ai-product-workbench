import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter } from "../src/ai/runtime/codex-runtime.adapter";
import type { RequirementRuntimeInput, RequirementRuntimeOutput } from "../src/ai/runtime/external-runtime.types";

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 143;
    setImmediate(() => this.emit("close", this.exitCode, signal ?? "SIGTERM"));
    return true;
  });
}

const { spawnMock, spawnedChildren } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnedChildren: [] as MockChildProcess[],
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("CodexRuntimeAdapter", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-runtime-adapter-"));
    spawnedChildren.length = 0;
    spawnMock.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("does not stop Codex while stdout keeps producing after the output file is written", async () => {
    spawnMock.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      setTimeout(async () => {
        await writeFile(join(options.cwd, "runtime-output.json"), JSON.stringify(requirementOutput("持续产出")), "utf8");
        child.stdout.write(JSON.stringify({ type: "item.completed", item: { text: "已生成草稿。" } }) + "\n");
      }, 5);
      setTimeout(() => {
        child.stdout.write(JSON.stringify({ type: "item.completed", item: { text: "继续收尾。" } }) + "\n");
      }, 20);
      setTimeout(() => {
        child.exitCode = 0;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 45);
      return child;
    });

    const adapter = new CodexRuntimeAdapter(config(workspaceRoot, {
      codexIdleTimeoutMs: () => 25,
      codexIdlePollMs: () => 5,
    }) as never);

    const result = await adapter.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(requirementTask());

    expect(result.output?.productDesignDraft.title).toBe("持续产出");
    expect(spawnedChildren[0]?.kill).not.toHaveBeenCalled();
    expect(result.events.map((item) => item.content).join("\n")).not.toContain("空闲超时");
  });

  it("stops Codex when there is no stdout, stderr, or output file activity", async () => {
    spawnMock.mockImplementation(() => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      return child;
    });

    const adapter = new CodexRuntimeAdapter(config(workspaceRoot, {
      codexIdleTimeoutMs: () => 20,
      codexIdlePollMs: () => 5,
    }) as never);

    await expect(adapter.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(requirementTask()))
      .rejects
      .toThrow("Codex runtime 空闲超时");
    expect(spawnedChildren[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("finishes on Codex turn/completed instead of waiting for idle timeout", async () => {
    spawnMock.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      setTimeout(async () => {
        await writeFile(join(options.cwd, "runtime-output.json"), JSON.stringify(requirementOutput("终态事件")), "utf8");
        child.stdout.write(JSON.stringify({ method: "turn/completed", params: { completedAt: "2026-06-26T00:00:00.000Z" } }) + "\n");
      }, 5);
      return child;
    });

    const adapter = new CodexRuntimeAdapter(config(workspaceRoot, {
      codexIdleTimeoutMs: () => 10_000,
      codexIdlePollMs: () => 20,
    }) as never);
    const startedAt = Date.now();

    const result = await adapter.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(requirementTask());

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.output?.productDesignDraft.title).toBe("终态事件");
    expect(spawnedChildren[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.events.map((item) => item.content).join("\n")).toContain("turn/completed");
  });

  it("compacts large structured runtime inputs while preserving selected PRD context", async () => {
    let capturedInput: Record<string, any> | undefined;
    spawnMock.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      setTimeout(async () => {
        capturedInput = JSON.parse(await readFile(join(options.cwd, "runtime-input.json"), "utf8"));
        await writeFile(join(options.cwd, "runtime-output.json"), JSON.stringify({
          patchType: "document",
          targetNodes: [],
          impactScope: {
            affectedStatePaths: [],
            affectedPrdSectionIds: ["section-25"],
            affectedPrototypePageIds: [],
            affectedPrototypeComponentIds: [],
            affectedAcceptanceCriteriaIds: [],
            requiresPrdRegeneration: true,
            requiresPrototypeRegeneration: false,
            requiresQaCheck: true,
            reason: "测试",
          },
          operations: [],
          regenerationPlan: {
            prd: "affected_sections",
            prototypeSpec: "none",
            htmlPrototype: "none",
            qa: "basic",
          },
          risks: [],
          needUserConfirm: false,
          needsUserConfirmation: false,
          reason: "测试",
          summary: "测试",
        }), "utf8");
        child.exitCode = 0;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 5);
      return child;
    });

    const adapter = new CodexRuntimeAdapter(config(workspaceRoot) as never);
    const result = await adapter.runTask(longPatchTask());
    const fileEvent = result.events.find((item) => item.type === "runtime_file_changed");
    const compaction = (fileEvent?.payload as any)?.inputCompaction;

    expect(compaction.wasCompacted).toBe(true);
    expect(compaction.compactedBytes).toBeLessThan(compaction.originalBytes);
    expect(capturedInput?.prdDocument.sections).toHaveLength(18);
    expect(capturedInput?.prdDocument.sections.map((section: any) => section.id)).toContain("section-25");
    const selectedContent = capturedInput?.prdDocument.sections.find((section: any) => section.id === "section-25").content;
    expect(selectedContent).toContain("已截断");
    expect(selectedContent.length).toBeGreaterThan(6_500);
    expect(selectedContent.length).toBeLessThan(7_200);
    expect(capturedInput?.knowledgeContext.strongRules).toHaveLength(6);
    expect(capturedInput?.knowledgeContext.strongRules[0].content.length).toBeLessThan(1_400);
  });

  it("keeps only recent compacted messages for requirement intake", async () => {
    let capturedInput: Record<string, any> | undefined;
    spawnMock.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      setTimeout(async () => {
        capturedInput = JSON.parse(await readFile(join(options.cwd, "runtime-input.json"), "utf8"));
        await writeFile(join(options.cwd, "runtime-output.json"), JSON.stringify(requirementOutput("消息裁剪")), "utf8");
        child.exitCode = 0;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 5);
      return child;
    });

    const adapter = new CodexRuntimeAdapter(config(workspaceRoot) as never);
    await adapter.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(requirementTask({
      recentMessages: Array.from({ length: 20 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `第 ${index + 1} 条消息：${"很长的上下文".repeat(500)}`,
        createdAt: new Date(2026, 5, index + 1).toISOString(),
      })),
    }));

    expect(capturedInput?.recentMessages).toHaveLength(8);
    expect(capturedInput?.recentMessages[0].id).toBe("message-13");
    expect(capturedInput?.recentMessages[0].content).toContain("已截断");
  });
});

function config(workspaceRoot: string, overrides: Partial<CodexTestConfig> = {}): CodexTestConfig {
  return {
    workspaceRoot: () => workspaceRoot,
    codexCommand: () => "codex",
    codexSandbox: () => "danger-full-access",
    codexIdleTimeoutMs: () => 180_000,
    codexIdlePollMs: () => 1_000,
    codexModel: () => "gpt-5.5",
    codexBaseUrl: () => "https://datatoken.shop",
    codexModelProviderId: () => "datatoken",
    codexModelProviderName: () => "datatoken",
    codexSupportsWebsockets: () => false,
    codexApiKey: () => "test-key",
    ...overrides,
  };
}

type CodexTestConfig = {
  workspaceRoot: () => string;
  codexCommand: () => string;
  codexSandbox: () => "read-only" | "workspace-write" | "danger-full-access";
  codexIdleTimeoutMs: () => number;
  codexIdlePollMs: () => number;
  codexModel: () => string;
  codexBaseUrl: () => string;
  codexModelProviderId: () => string;
  codexModelProviderName: () => string;
  codexSupportsWebsockets: () => boolean;
  codexApiKey: () => string;
};

function requirementTask(inputOverrides: Partial<RequirementRuntimeInput> = {}) {
  return {
    id: "runtime-task-1",
    provider: "codex" as const,
    taskType: "intake_requirement" as const,
    runId: "run-1",
    projectId: "project-1",
    userId: "user-1",
    input: {
      userInput: "做一个测试备注字段",
      conversationId: "conversation-1",
      recentMessages: [],
      attachments: [],
      ...inputOverrides,
    },
  };
}

function longPatchTask() {
  return {
    id: "runtime-task-2",
    provider: "codex" as const,
    taskType: "patch_prd" as const,
    runId: "run-2",
    projectId: "project-1",
    userId: "user-1",
    input: {
      userInput: "请修改第 25 节的只读测试备注字段规则。",
      selectedRegion: {
        type: "document" as const,
        sectionId: "section-25",
        targetId: "section-25",
        selectedText: "只读测试备注字段",
      },
      productDesignState: {
        id: "state-1",
        projectId: "project-1",
        version: 3,
        title: "大型需求",
        summary: "用于测试大输入瘦身。",
        businessGoal: "降低 Codex runtime 输入体积。",
        targetUsers: [],
        userScenarios: [],
        pages: [],
        features: Array.from({ length: 40 }, (_, index) => ({
          id: `feature-${index + 1}`,
          name: `功能 ${index + 1}`,
          description: "非常长的功能描述".repeat(200),
        })),
        backendConfigs: [],
        frontendRules: [],
        businessRules: [],
        stateRules: [],
        exceptionScenarios: [],
        acceptanceCriteria: [],
        assumptions: [],
        knowledgeRefs: [],
        pendingQuestions: [],
        confirmedFacts: [],
        status: "doc_ready",
        createdBy: "user-1",
        createdAt: "2026-06-26T00:00:00.000Z",
        updatedAt: "2026-06-26T00:00:00.000Z",
      },
      prdDocument: longRequirementDocument(),
      knowledgeContext: {
        query: "测试",
        summary: "知识上下文摘要",
        strongRules: Array.from({ length: 10 }, (_, index) => ({
          id: `rule-${index + 1}`,
          title: `规则 ${index + 1}`,
          content: "需要遵循的超长规则正文".repeat(500),
          sourceType: "knowledge_base",
        })),
        defaultRules: [],
        referenceCases: [],
        designPatterns: [],
        prdWritingRules: [],
        prototypeRules: [],
        businessConcepts: [],
        conflicts: [],
        unknownAreas: [],
      },
    },
  };
}

function longRequirementDocument() {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "大型 PRD",
    status: "ready",
    sections: Array.from({ length: 30 }, (_, index) => ({
      id: `section-${index + 1}`,
      title: `章节 ${index + 1}`,
      type: "business_rules",
      level: 1,
      order: index + 1,
      content: `第 ${index + 1} 节内容。${"这是一段非常长的 PRD 正文。".repeat(600)}`,
      blocks: [
        {
          id: `block-${index + 1}`,
          type: "paragraph",
          content: "长段落".repeat(600),
          sourcePaths: ["businessRules"],
        },
      ],
      sourcePaths: ["businessRules"],
    })),
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
  };
}

function requirementOutput(title: string) {
  return {
    productDesignDraft: {
      title,
      summary: "用于验证 Codex runtime 产出过程。",
      businessGoal: "确保还在产出时不被中断。",
      targetUsers: [],
      userScenarios: [],
      pages: [],
      features: [],
      backendConfigs: [],
      frontendRules: [],
      businessRules: [],
      stateRules: [],
      exceptionScenarios: [],
      acceptanceCriteria: [],
      assumptions: [],
      knowledgeRefs: [],
      pendingQuestions: [],
      confirmedFacts: [],
    },
    message: "已生成。",
  };
}
