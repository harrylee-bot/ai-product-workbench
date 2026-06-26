import {
  ProjectStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderHtmlFromPrototypeSpec,
  renderPrototypeSpecFromState,
} from "../src/ai/runtime/local-protocol-renderers";
import type { ProductDesignState, PrototypeArtifactDraft } from "../src/ai/ai-vibe.types";
import { PrototypeService, replacePrototypeComponentHtml, validateHtmlSafety } from "../src/ai/prototype.service";

describe("HTML prototype artifact module", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    prototypeSpecRecord: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    prototypeArtifact: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    prototypeVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const stateService = {
    getCurrentState: vi.fn(),
    getStateByIdForProject: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
  };
  const productRuntime = {
    generatePrototypeSpec: vi.fn(),
    generatePrototypeHtml: vi.fn(),
  };
  const qaService = { assertGateAllows: vi.fn() };
  const service = new PrototypeService(
    prisma as never,
    stateService as never,
    productRuntime as never,
    undefined,
    qaService as never,
  );
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue(baseProject());
    prisma.project.update.mockResolvedValue({});
    prisma.prototypeVersion.findFirst.mockResolvedValue(null);
    prisma.prototypeVersion.create.mockImplementation(async ({ data }) => ({
      id: `prototype-version-${data.version}`,
      ...data,
      reason: data.reason ?? null,
      createdAt: now,
    }));
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    stateService.attachGeneratedArtifacts.mockImplementation(async (_stateId, input) => ({
      ...state,
      version: 4,
      status: input.status,
      prototypeSpec: input.prototypeSpec,
    }));
    productRuntime.generatePrototypeSpec.mockResolvedValue({ data: spec });
    productRuntime.generatePrototypeHtml.mockResolvedValue({
      data: {
        projectId: state.projectId,
        prototypeSpecId: spec.id,
        htmlContent: renderHtmlFromPrototypeSpec(spec),
        entryFilePath: "index.html",
        targetDevice: "both",
        pageCount: 1,
      },
    });
  });

  it("renders PrototypeSpec from ProductDesignState with source refs and state version", () => {
    const spec = renderPrototypeSpecFromState(baseState(), "both", "run-1");

    expect(spec.productDesignStateId).toBe("state-1");
    expect(spec.productDesignStateVersion).toBe(3);
    expect(spec.pages[0]).toEqual(
      expect.objectContaining({
        id: "page_home",
        sourcePaths: ["pages[0]"],
      }),
    );
    expect(spec.pages[0].components[0].sourcePaths).toContain("pages[0]");
    expect(spec.interactions[0]).toEqual(
      expect.objectContaining({
        event: "click",
        action: "show_toast",
      }),
    );
  });

  it("renders safe single-file HTML with stable data ids", () => {
    const spec = renderPrototypeSpecFromState(baseState(), "desktop");
    const html = renderHtmlFromPrototypeSpec(spec);

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('data-page-id="page_home"');
    expect(html).toContain('data-component-id="page_home_goal_card"');
    expect(html).not.toMatch(/\bfetch\s*\(|eval\s*\(|<script[^>]+src=/i);
    expect(validateHtmlSafety(html)).toEqual({ ok: true });
  });

  it("saves generated prototype, creates version, and updates project pointer", async () => {
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    const draft: PrototypeArtifactDraft = {
      projectId: state.projectId,
      prototypeSpecId: spec.id,
      htmlContent: renderHtmlFromPrototypeSpec(spec),
      entryFilePath: "index.html",
      targetDevice: "both",
      pageCount: 1,
    };
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) => specRecord(data));
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) => artifactRecord({ id: "artifact-1", ...data }));

    const result = await service.saveGeneratedPrototype(state, spec, draft, {
      userId: "user-1",
      runId: "run-1",
      reason: "Prototype Code Agent 生成 HTML 原型",
    });

    expect(result.artifact.id).toBe("artifact-1");
    expect(result.artifact.status).toBe("ready");
    expect(result.artifact.productDesignStateVersion).toBe(3);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentPrototypeArtifactId: "artifact-1" },
    });
    expect(prisma.prototypeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact-1",
        version: 1,
        createdBy: "user-1",
      }),
    });
  });

  it("derives PrototypeState from current artifact and PrototypeSpec without mutating state", async () => {
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    prisma.project.findUnique.mockResolvedValue(baseProject({ currentPrototypeArtifactId: "artifact-1" }));
    prisma.prototypeArtifact.findFirst.mockResolvedValue(artifactRecord({
      id: "artifact-1",
      prototypeSpecId: spec.id,
      productDesignStateId: state.id,
      productDesignStateVersion: state.version,
      htmlContent: renderHtmlFromPrototypeSpec(spec),
    }));
    prisma.prototypeSpecRecord.findUnique.mockResolvedValue(specRecord(spec as unknown as Record<string, unknown>));

    const result = await service.getPrototypeStateForUser(user, { projectId: "project-1" });

    expect(result.prototypeState).toEqual(
      expect.objectContaining({
        id: "artifact-1",
        version: 3,
        root: expect.objectContaining({
          type: "prototype",
          children: expect.arrayContaining([
            expect.objectContaining({
              id: "page_home",
              type: "page",
            }),
          ]),
        }),
      }),
    );
    expect(prisma.prototypeArtifact.update).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("rejects unsafe HTML before allowing preview", async () => {
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) => specRecord(data));
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) => artifactRecord({ id: "artifact-unsafe", ...data }));

    await expect(
      service.saveGeneratedPrototype(
        state,
        spec,
        {
          projectId: state.projectId,
          prototypeSpecId: spec.id,
          htmlContent: '<!doctype html><script src="https://example.com/tracker.js"></script>',
        },
        { userId: "user-1" },
      ),
    ).rejects.toThrow("PROTOTYPE_HTML_UNSAFE");
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(validateHtmlSafety("<script>window.parent.postMessage('x','*')</script>")).toEqual({
      ok: false,
      reason: "PROTOTYPE_HTML_PARENT_ACCESS",
    });
  });

  it("replaces only the targeted component html by data-component-id", () => {
    const html = '<!doctype html><main><article data-component-id="keep"><strong>保留</strong></article><button data-component-id="target"><span>旧文案</span></button></main>';
    const next = replacePrototypeComponentHtml(
      html,
      "target",
      '<button data-component-id="target">新文案</button>',
    );

    expect(next).toContain('<article data-component-id="keep"><strong>保留</strong></article>');
    expect(next).toContain('<button data-component-id="target">新文案</button>');
    expect(next).not.toContain("旧文案");
  });

  it("creates a new artifact by locally regenerating the selected prototype component", async () => {
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-local");
    const action = spec.pages[0].components.find((component) => component.id === "page_home_primary_action");
    if (action) action.content = "立即签到";
    const beforeHtml = '<!doctype html><main><article data-component-id="page_home_goal_card"><strong>保留目标卡片</strong></article><button data-component-id="page_home_primary_action">旧按钮</button></main>';
    prisma.prototypeArtifact.findFirst.mockResolvedValue(artifactRecord({
      id: "artifact-before",
      prototypeSpecId: "spec-before",
      productDesignStateId: state.id,
      productDesignStateVersion: state.version,
      htmlContent: beforeHtml,
    }));
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) => specRecord(data));
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) => artifactRecord({ id: "artifact-local", ...data }));

    const result = await service.trySaveLocalizedGeneratedPrototype(state, spec, {
      userId: "user-1",
      runId: "run-local",
      sourceArtifactId: "artifact-before",
      selectedRegion: {
        type: "prototype",
        targetId: "artifact-before",
        artifactId: "artifact-before",
        pageId: "page_home",
        componentId: "page_home_primary_action",
      },
    });

    expect(result?.artifact.id).toBe("artifact-local");
    expect(result?.artifact.htmlContent).toContain("保留目标卡片");
    expect(result?.artifact.htmlContent).toContain("立即签到");
    expect(result?.artifact.htmlContent).not.toContain("旧按钮");
    expect(result?.localPatch).toEqual(expect.objectContaining({
      mode: "component",
      componentId: "page_home_primary_action",
      sourceArtifactId: "artifact-before",
    }));
    expect(productRuntime.generatePrototypeHtml).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentPrototypeArtifactId: "artifact-local" },
    });
  });

  it("syncs manual prototype generation back into ProductDesignState", async () => {
    const state = baseState({
      status: "doc_confirmed",
      prdDocument: basePrd({ status: "confirmed" }),
    });
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    stateService.getCurrentState.mockResolvedValue(state);
    productRuntime.generatePrototypeSpec.mockResolvedValue({ data: spec });
    productRuntime.generatePrototypeHtml.mockResolvedValue({
      data: {
        projectId: state.projectId,
        prototypeSpecId: spec.id,
        htmlContent: renderHtmlFromPrototypeSpec(spec),
        entryFilePath: "index.html",
        targetDevice: "both",
        pageCount: 1,
      },
    });
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) => specRecord(data));
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) => artifactRecord({ id: "artifact-manual", ...data }));

    const result = await service.generateForUser(user, "project-1", { targetDevice: "both" });

    expect(result.artifact.id).toBe("artifact-manual");
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith("state-1", expect.objectContaining({
      prototypeSpec: expect.objectContaining({ id: spec.id }),
      status: "prototype_ready",
      reason: "手动生成 HTML 原型后同步 ProductDesignState",
    }));
    expect(result.productDesignState.prototypeSpec.id).toBe(spec.id);
  });

  it("blocks manual prototype generation before the PRD confirmation gate", async () => {
    const state = baseState({
      status: "doc_ready",
      prdDocument: basePrd({ status: "ready" }),
    });
    stateService.getCurrentState.mockResolvedValue(state);

    await expect(
      service.generateForUser(user, "project-1", { targetDevice: "both" }),
    ).rejects.toThrow("PROTOTYPE_PRD_NOT_CONFIRMED");

    expect(productRuntime.generatePrototypeSpec).not.toHaveBeenCalled();
    expect(productRuntime.generatePrototypeHtml).not.toHaveBeenCalled();
    expect(stateService.attachGeneratedArtifacts).not.toHaveBeenCalled();
  });

  it("hides a stale current prototype artifact when it no longer matches ProductDesignState", async () => {
    const state = baseState();
    const currentSpec = renderPrototypeSpecFromState(state, "both", "run-current");
    stateService.getCurrentState.mockResolvedValue(baseState({ prototypeSpec: currentSpec }));
    prisma.project.findUnique.mockResolvedValue(baseProject({ currentPrototypeArtifactId: "artifact-stale" }));
    prisma.prototypeArtifact.findFirst.mockResolvedValue(artifactRecord({
      id: "artifact-stale",
      prototypeSpecId: "spec-stale",
      productDesignStateId: state.id,
      productDesignStateVersion: state.version,
    }));

    const result = await service.getCurrentForUser(user, "project-1");

    expect(result.artifact).toBeNull();
  });

  it("confirms a ready prototype and syncs confirmed status into ProductDesignState", async () => {
    const state = baseState();
    const spec = renderPrototypeSpecFromState(state, "both", "run-1");
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        productDesignStateId: state.id,
        htmlContent: renderHtmlFromPrototypeSpec(spec),
      }),
      project: baseProject({ status: ProjectStatus.prototype_ready }),
    });
    prisma.prototypeSpecRecord.findUniqueOrThrow.mockResolvedValue(specRecord(spec as unknown as Record<string, unknown>));
    prisma.prototypeArtifact.update.mockImplementation(async ({ data }) =>
      artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        productDesignStateId: state.id,
        htmlContent: renderHtmlFromPrototypeSpec(spec),
        updatedBy: data.updatedBy,
      }),
    );

    const result = await service.confirmForUser(user, "artifact-1", "确认原型");

    expect(result.productDesignState.status).toBe("confirmed");
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith("state-1", expect.objectContaining({
      prototypeSpec: expect.objectContaining({ id: spec.id }),
      status: "confirmed",
      reason: "确认原型，同步原型确认状态到 ProductDesignState",
    }));
    expect(prisma.prototypeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact-1",
        reason: "确认原型",
      }),
    });
  });

  it("blocks prototype confirmation when the artifact is not ready", async () => {
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: "spec-1",
        status: PrototypeArtifactStatus.failed,
        htmlContent: null,
      }),
      project: baseProject({ status: ProjectStatus.prototype_ready }),
    });

    await expect(service.confirmForUser(user, "artifact-1", "确认原型")).rejects.toThrow("PROTOTYPE_CONFIRM_NOT_READY");

    expect(qaService.assertGateAllows).not.toHaveBeenCalled();
    expect(stateService.attachGeneratedArtifacts).not.toHaveBeenCalled();
  });

  it("blocks prototype confirmation when QA gate does not allow artifact confirmation", async () => {
    qaService.assertGateAllows.mockRejectedValue(new Error("QA_GATE_BLOCKED"));
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: "spec-1",
        htmlContent: "<!doctype html>",
      }),
      project: baseProject({ status: ProjectStatus.qa_failed }),
    });

    await expect(service.confirmForUser(user, "artifact-1", "确认原型")).rejects.toThrow("QA_GATE_BLOCKED");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(user, "project-1", "confirm_artifacts");
    expect(prisma.prototypeSpecRecord.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.prototypeArtifact.update).not.toHaveBeenCalled();
    expect(prisma.prototypeVersion.create).not.toHaveBeenCalled();
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.draft,
    deletedAt: null,
    currentPrototypeArtifactId: null,
    ...overrides,
  };
}

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [{ id: "target_user_1", name: "普通用户", description: "参与日常签到的用户" }],
    userScenarios: [{ id: "scenario_1", title: "每日签到", description: "用户进入页面后完成签到" }],
    pages: [{ id: "page_home", name: "签到页", description: "展示签到状态和奖励" }],
    features: [{ id: "feature_checkin", name: "签到", description: "用户点击后完成当日签到" }],
    backendConfigs: [{ id: "config_reward", name: "奖励配置", description: "配置每日奖励额度" }],
    frontendRules: [{ id: "front_status", title: "状态展示", description: "已签到后按钮置灰" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次", description: "每个用户每天只能签到一次" }],
    stateRules: [{ id: "state_signed", name: "已签到", description: "用户当天完成签到后的状态" }],
    exceptionScenarios: [{ id: "exception_repeat", title: "重复签到", expectedBehavior: "提示今日已签到" }],
    acceptanceCriteria: [{ id: "accept_once", title: "每日签到限制", description: "重复签到不会重复发奖" }],
    assumptions: [{ id: "assumption_reward", content: "默认奖励为积分", status: "pending" }],
    knowledgeRefs: [{ id: "knowledge_1", title: "活动规范", content: "活动必须展示奖励说明" }],
    pendingQuestions: [{ id: "question_reward", question: "积分额度是多少？", status: "pending" }],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function basePrd(overrides: Record<string, unknown> = {}) {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动 PRD",
    status: "confirmed",
    sections: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function specRecord(input: Record<string, unknown>) {
  return {
    id: String(input.id),
    projectId: String(input.projectId ?? "project-1"),
    productDesignStateId: String(input.productDesignStateId ?? "state-1"),
    productDesignStateVersion: Number(input.productDesignStateVersion ?? 3),
    title: String(input.title ?? "签到活动 HTML 原型"),
    targetDevice: input.targetDevice ?? PrototypeTargetDevice.both,
    styleGuide: input.styleGuide ?? {},
    pages: input.pages ?? [],
    navigation: input.navigation ?? [],
    interactions: input.interactions ?? [],
    assumptions: input.assumptions ?? [],
    knowledgeRefs: input.knowledgeRefs ?? [],
    generatedByRunId: input.generatedByRunId ?? null,
    createdAt: nowDate(input.createdAt),
    updatedAt: nowDate(input.updatedAt),
  };
}

function artifactRecord(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? "artifact-1"),
    projectId: String(input.projectId ?? "project-1"),
    prototypeSpecId: String(input.prototypeSpecId),
    productDesignStateId: String(input.productDesignStateId ?? "state-1"),
    productDesignStateVersion: Number(input.productDesignStateVersion ?? 3),
    title: String(input.title ?? "签到活动 HTML 原型"),
    status: input.status ?? PrototypeArtifactStatus.ready,
    htmlContent: typeof input.htmlContent === "string" ? input.htmlContent : null,
    entryFilePath: typeof input.entryFilePath === "string" ? input.entryFilePath : null,
    previewUrl: typeof input.previewUrl === "string" ? input.previewUrl : null,
    targetDevice: input.targetDevice ?? PrototypeTargetDevice.both,
    pageCount: Number(input.pageCount ?? 1),
    generatedByRunId: input.generatedByRunId ?? null,
    errorMessage: typeof input.errorMessage === "string" ? input.errorMessage : null,
    createdBy: String(input.createdBy ?? "user-1"),
    updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    createdAt: nowDate(input.createdAt),
    updatedAt: nowDate(input.updatedAt),
  };
}

function nowDate(value: unknown) {
  return value instanceof Date ? value : new Date("2026-06-20T08:00:00Z");
}
