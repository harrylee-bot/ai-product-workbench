import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function requirementTask() {
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
    },
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
