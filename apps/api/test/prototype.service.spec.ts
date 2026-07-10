import {
  KnowledgeCandidateSource,
  ConversationStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDesignState,
  PrototypeArtifactDraft,
  PrototypeSpec,
} from "../src/ai/ai-vibe.types";
import {
  PrototypeService,
  sanitizePrototypeDocumentHtml,
  sanitizePrototypeHtml,
} from "../src/ai/prototype.service";

describe("HTML prototype artifact module", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    conversation: {
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
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    ),
  };
  const stateService = {
    getCurrentState: vi.fn(),
    getStateByIdForConversation: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
  };
  const qaService = { assertGateAllows: vi.fn() };
  const knowledgeCandidateService = { createMany: vi.fn() };
  const service = new PrototypeService(
    prisma as never,
    stateService as never,
    knowledgeCandidateService as never,
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
    prisma.conversation.findUnique.mockResolvedValue(baseProject());
    prisma.conversation.update.mockResolvedValue({});
    prisma.prototypeVersion.findFirst.mockResolvedValue(null);
    prisma.prototypeVersion.create.mockImplementation(async ({ data }) => ({
      id: `prototype-version-${data.version}`,
      ...data,
      reason: data.reason ?? null,
      createdAt: now,
    }));
    stateService.attachGeneratedArtifacts.mockImplementation(
      async (_stateId, input) => ({
        ...baseState(),
        version: 4,
        status: input.status,
        prototypeSpec: input.prototypeSpec,
      }),
    );
    knowledgeCandidateService.createMany.mockResolvedValue({ items: [] });
  });

  it("saves generated prototype, creates version, and updates conversation pointer", async () => {
    const state = baseState();
    const spec = prototypeSpec(state);
    const draft: PrototypeArtifactDraft = {
      conversationId: state.conversationId,
      prototypeSpecId: spec.id,
      htmlContent: prototypeHtml(spec),
      entryFilePath: "index.html",
      targetDevice: "both",
      pageCount: 1,
    };
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) =>
      specRecord(data),
    );
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) =>
      artifactRecord({ id: "artifact-1", ...data }),
    );

    const result = await service.saveGeneratedPrototype(state, spec, draft, {
      userId: "user-1",
      runId: "run-1",
      reason: "DeerFlow 生成 HTML 原型",
    });

    expect(result.artifact.id).toBe("artifact-1");
    expect(result.artifact.status).toBe("ready");
    expect(result.artifact.conversationDesignStateVersion).toBe(3);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
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
    const spec = prototypeSpec(state);
    prisma.conversation.findUnique.mockResolvedValue(
      baseProject({ currentPrototypeArtifactId: "artifact-1" }),
    );
    prisma.prototypeArtifact.findFirst.mockResolvedValue(
      artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        conversationDesignStateId: state.id,
        conversationDesignStateVersion: state.version,
        htmlContent: prototypeHtml(spec),
      }),
    );
    prisma.prototypeSpecRecord.findUnique.mockResolvedValue(
      specRecord(spec as unknown as Record<string, unknown>),
    );

    const result = await service.getPrototypeStateForUser(user, {
      conversationId: "conversation-1",
    });

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
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("sanitizes unsafe HTML before storing and previewing", async () => {
    const state = baseState();
    const spec = prototypeSpec(state);
    prisma.prototypeSpecRecord.create.mockImplementation(async ({ data }) =>
      specRecord(data),
    );
    prisma.prototypeArtifact.create.mockImplementation(async ({ data }) =>
      artifactRecord({ id: "artifact-sanitized", ...data }),
    );

    const result = await service.saveGeneratedPrototype(
      state,
      spec,
      {
        conversationId: state.conversationId,
        prototypeSpecId: spec.id,
        htmlContent:
          '<!doctype html><html><body><button onclick="alert(1)" data-component-id="cta" data-secret="x">提交</button><script src="https://example.com/tracker.js"></script></body></html>',
      },
      { userId: "user-1" },
    );

    expect(result.artifact.status).toBe("ready");
    expect(result.artifact.htmlContent).toContain('data-component-id="cta"');
    expect(result.artifact.htmlContent).not.toContain("onclick");
    expect(result.artifact.htmlContent).not.toContain("data-secret");
    expect(result.artifact.htmlContent).not.toContain("<script");
    expect(prisma.conversation.update).toHaveBeenCalled();
    expect(
      sanitizePrototypeHtml(
        "<script>window.parent.postMessage('x','*')</script>",
      ),
    ).toBe("<html><head></head><body></body></html>");
  });

  it("sanitizePrototypeHtml keeps sandboxed interactions but strips escape and network vectors", () => {
    // javascript: / data: 脚本 URL
    expect(
      sanitizePrototypeHtml('<a href="javascript:alert(1)">x</a>'),
    ).not.toContain("javascript:");
    expect(
      sanitizePrototypeHtml(
        '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      ),
    ).not.toContain("<script");
    // on* 事件处理器（含大小写/前导空格变体）
    expect(
      sanitizePrototypeHtml('<img src="x" onerror="alert(1)">'),
    ).not.toContain("onerror");
    expect(
      sanitizePrototypeHtml('<div OnClick="alert(1)">x</div>'),
    ).not.toMatch(/onclick/i);
    // Cross-frame scripts and embedded active content remain forbidden.
    expect(
      sanitizePrototypeHtml("<script>window.parent.postMessage('secret','*')</script>"),
    ).not.toContain("<script");
    // iframe/object/embed 被 FORBID
    expect(
      sanitizePrototypeHtml('<iframe src="https://evil"></iframe>'),
    ).not.toContain("<iframe");
    expect(
      sanitizePrototypeHtml('<object data="https://evil"></object>'),
    ).not.toContain("<object");
    // 原型选区标记 data-component-id / data-page-id / data-action 必须保留
    const kept = sanitizePrototypeHtml(
      '<button data-component-id="cta" data-page-id="home" data-action="submit">提交</button>',
    );
    expect(kept).toContain('data-component-id="cta"');
    expect(kept).toContain('data-page-id="home"');
    expect(kept).toContain('data-action="submit"');
    // 其它 data-* 因 ALLOW_DATA_ATTR:false 被剥离
    expect(
      sanitizePrototypeHtml('<div data-secret="leak">x</div>'),
    ).not.toContain("data-secret");

    const interactive = sanitizePrototypeHtml([
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<button id="save">保存</button>',
      '<script>document.querySelector("#save").addEventListener("click",()=>{document.body.dataset.saved="true"})</script>',
    ].join(""));
    expect(interactive).toContain('content="width=device-width, initial-scale=1"');
    expect(interactive).toContain("<script>");
    expect(interactive).toContain("addEventListener");
  });

  it("wraps prototype exports as safe standalone documents", () => {
    const html = sanitizePrototypeDocumentHtml(
      '<button onclick="alert(1)" data-component-id="cta">提交</button><script>alert(1)</script>',
      "原型 '标题'",
    );

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain('data-component-id="cta"');
    expect(html).toContain("原型 &#39;标题&#39;");
    expect(html).not.toContain("onclick");
    expect(html).toContain("<script>alert(1)</script>");
  });

  it("hides a stale current prototype artifact when it no longer matches ConversationDesignState", async () => {
    const state = baseState();
    const currentSpec = prototypeSpec(state, "run-current");
    stateService.getCurrentState.mockResolvedValue(
      baseState({ prototypeSpec: currentSpec }),
    );
    prisma.conversation.findUnique.mockResolvedValue(
      baseProject({ currentPrototypeArtifactId: "artifact-stale" }),
    );
    prisma.prototypeArtifact.findFirst.mockResolvedValue(
      artifactRecord({
        id: "artifact-stale",
        prototypeSpecId: "spec-stale",
        conversationDesignStateId: state.id,
        conversationDesignStateVersion: state.version,
      }),
    );

    const result = await service.getCurrentForUser(user, "conversation-1");

    expect(result.artifact).toBeNull();
  });

  it("confirms a ready prototype and syncs confirmed status into ConversationDesignState", async () => {
    const state = baseState();
    const spec = prototypeSpec(state);
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        conversationDesignStateId: state.id,
        htmlContent: prototypeHtml(spec),
      }),
      conversation: baseProject({ status: ConversationStatus.active }),
    });
    prisma.prototypeSpecRecord.findUniqueOrThrow.mockResolvedValue(
      specRecord(spec as unknown as Record<string, unknown>),
    );
    prisma.prototypeArtifact.update.mockImplementation(async ({ data }) =>
      artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        conversationDesignStateId: state.id,
        htmlContent: prototypeHtml(spec),
        updatedBy: data.updatedBy,
      }),
    );

    const result = await service.confirmForUser(user, "artifact-1", "确认原型");

    expect(result.conversationDesignState.status).toBe("confirmed");
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith(
      "state-1",
      expect.objectContaining({
        prototypeSpec: expect.objectContaining({ id: spec.id }),
        status: "confirmed",
        reason: "确认原型，同步原型确认状态到 ConversationDesignState",
      }),
    );
    expect(prisma.prototypeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact-1",
        reason: "确认原型",
      }),
    });
  });

  it("extracts pending knowledge candidates after prototype confirmation", async () => {
    const state = baseState();
    const spec = prototypeSpec(state);
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        conversationDesignStateId: state.id,
        htmlContent: prototypeHtml(spec),
      }),
      conversation: baseProject({ status: ConversationStatus.active }),
    });
    prisma.prototypeSpecRecord.findUniqueOrThrow.mockResolvedValue(
      specRecord(spec as unknown as Record<string, unknown>),
    );
    prisma.prototypeArtifact.update.mockImplementation(async ({ data }) =>
      artifactRecord({
        id: "artifact-1",
        prototypeSpecId: spec.id,
        conversationDesignStateId: state.id,
        htmlContent: prototypeHtml(spec),
        generatedByRunId: "run-1",
        updatedBy: data.updatedBy,
      }),
    );
    qaService.assertGateAllows.mockResolvedValue({
      allowPersistKnowledge: true,
    });
    knowledgeCandidateService.createMany.mockResolvedValue({
      items: [{ id: "candidate-prototype", title: "签到页原型" }],
    });

    const result = await service.confirmForUser(user, "artifact-1", "确认原型");

    expect(knowledgeCandidateService.createMany).toHaveBeenCalledWith(
      "conversation-1",
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringContaining("原型方案"),
          sourcePath: "prototype",
        }),
        expect.objectContaining({
          title: expect.stringContaining("签到页"),
          sourcePath: "pages.page_home",
        }),
      ]),
      {
        source: KnowledgeCandidateSource.prototype,
        sourceRefId: "artifact-1",
        runId: "run-1",
      },
    );
    expect(result.knowledgeCandidates.items).toEqual([
      expect.objectContaining({ id: "candidate-prototype" }),
    ]);
  });

  it("blocks prototype confirmation when QA gate does not allow artifact confirmation", async () => {
    qaService.assertGateAllows.mockRejectedValue(new Error("QA_GATE_BLOCKED"));
    prisma.prototypeArtifact.findUnique.mockResolvedValue({
      ...artifactRecord({
        id: "artifact-1",
        prototypeSpecId: "spec-1",
        htmlContent: "<!doctype html>",
      }),
      conversation: baseProject({ status: ConversationStatus.active }),
    });

    await expect(
      service.confirmForUser(user, "artifact-1", "确认原型"),
    ).rejects.toThrow("QA_GATE_BLOCKED");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(
      user,
      "conversation-1",
      "confirm_artifacts",
    );
    expect(prisma.prototypeSpecRecord.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.prototypeArtifact.update).not.toHaveBeenCalled();
    expect(prisma.prototypeVersion.create).not.toHaveBeenCalled();
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.active,
    deletedAt: null,
    currentPrototypeArtifactId: null,
    ...overrides,
  };
}

function baseState(
  overrides: Partial<ConversationDesignState> = {},
): ConversationDesignState {
  return {
    id: "state-1",
    conversationId: "conversation-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [
      {
        id: "target_user_1",
        name: "普通用户",
        description: "参与日常签到的用户",
      },
    ],
    userScenarios: [
      {
        id: "scenario_1",
        title: "每日签到",
        description: "用户进入页面后完成签到",
      },
    ],
    pages: [
      { id: "page_home", name: "签到页", description: "展示签到状态和奖励" },
    ],
    features: [
      {
        id: "feature_checkin",
        name: "签到",
        description: "用户点击后完成当日签到",
      },
    ],
    backendConfigs: [
      {
        id: "config_reward",
        name: "奖励配置",
        description: "配置每日奖励额度",
      },
    ],
    frontendRules: [
      {
        id: "front_status",
        title: "状态展示",
        description: "已签到后按钮置灰",
      },
    ],
    businessRules: [
      {
        id: "rule_daily_once",
        title: "每日一次",
        description: "每个用户每天只能签到一次",
      },
    ],
    stateRules: [
      {
        id: "state_signed",
        name: "已签到",
        description: "用户当天完成签到后的状态",
      },
    ],
    exceptionScenarios: [
      {
        id: "exception_repeat",
        title: "重复签到",
        expectedBehavior: "提示今日已签到",
      },
    ],
    acceptanceCriteria: [
      {
        id: "accept_once",
        title: "每日签到限制",
        description: "重复签到不会重复发奖",
      },
    ],
    assumptions: [
      { id: "assumption_reward", content: "默认奖励为积分", status: "pending" },
    ],
    knowledgeRefs: [
      { id: "knowledge_1", title: "活动规范", content: "活动必须展示奖励说明" },
    ],
    pendingQuestions: [
      {
        id: "question_reward",
        question: "积分额度是多少？",
        status: "pending",
      },
    ],
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
    conversationId: "conversation-1",
    conversationDesignStateId: "state-1",
    conversationDesignStateVersion: 3,
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

function prototypeSpec(
  state: ConversationDesignState,
  runId = "run-1",
): PrototypeSpec {
  return {
    id: `spec-${runId}`,
    conversationId: state.conversationId,
    conversationDesignStateId: state.id,
    conversationDesignStateVersion: state.version,
    title: `${state.title} HTML 原型`,
    targetDevice: "both",
    styleGuide: {
      tone: "clean",
      layoutDensity: "comfortable",
      borderRadius: "small",
    },
    pages: [
      {
        id: "page_home",
        name: "签到页",
        device: "responsive",
        layout: "dashboard",
        components: [
          {
            id: "page_home_primary_action",
            name: "签到按钮",
            type: "button",
            content: "立即签到",
            sourcePaths: ["frontendRules"],
          },
        ],
        sourcePaths: ["pages[0]"],
        order: 1,
      },
    ],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [],
    generatedByRunId: runId,
  };
}

function prototypeHtml(spec: PrototypeSpec) {
  return `<!doctype html><main data-page-id="${spec.pages[0].id}"><button data-component-id="page_home_primary_action">立即签到</button></main>`;
}

function specRecord(input: Record<string, unknown>) {
  return {
    id: String(input.id),
    conversationId: String(input.conversationId ?? "conversation-1"),
    conversationDesignStateId: String(
      input.conversationDesignStateId ?? "state-1",
    ),
    conversationDesignStateVersion: Number(
      input.conversationDesignStateVersion ?? 3,
    ),
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
    conversationId: String(input.conversationId ?? "conversation-1"),
    prototypeSpecId: String(input.prototypeSpecId),
    conversationDesignStateId: String(
      input.conversationDesignStateId ?? "state-1",
    ),
    conversationDesignStateVersion: Number(
      input.conversationDesignStateVersion ?? 3,
    ),
    title: String(input.title ?? "签到活动 HTML 原型"),
    status: input.status ?? PrototypeArtifactStatus.ready,
    htmlContent:
      typeof input.htmlContent === "string" ? input.htmlContent : null,
    entryFilePath:
      typeof input.entryFilePath === "string" ? input.entryFilePath : null,
    previewUrl: typeof input.previewUrl === "string" ? input.previewUrl : null,
    targetDevice: input.targetDevice ?? PrototypeTargetDevice.both,
    pageCount: Number(input.pageCount ?? 1),
    generatedByRunId: input.generatedByRunId ?? null,
    errorMessage:
      typeof input.errorMessage === "string" ? input.errorMessage : null,
    createdBy: String(input.createdBy ?? "user-1"),
    updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    createdAt: nowDate(input.createdAt),
    updatedAt: nowDate(input.updatedAt),
  };
}

function nowDate(value: unknown) {
  return value instanceof Date ? value : new Date("2026-06-20T08:00:00Z");
}
