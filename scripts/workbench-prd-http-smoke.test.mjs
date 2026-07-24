import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { canonicalJson } from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  assertPrdSmokeBusinessSemantics,
  assertPrdV2Structure,
  executePrdHttpSmoke,
} from "./workbench-prd-http-smoke.mjs";

const fixedNow = () => new Date("2026-07-23T09:00:00.000Z");
const smokeUuid = "11111111-2222-4333-8444-555555555555";
const email = "prd-smoke@example.test";
const password = "email-password-must-not-leak";
const existingCookie = "workbench.session_token=existing-session-must-not-leak";
const prdGenerationStages = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
];

test("runs the isolated PRD v2 HTTP flow through Better Auth email sign-in", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_EMAIL: email,
      WORKBENCH_PRD_SMOKE_PASSWORD: password,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true, `${result.failure?.code}: ${result.failure?.message}`);
  assert.equal(result.evidence.result, "PASS");
  assert.equal(result.evidence.authMode, "email");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assert.equal(result.evidence.checks.at(-1)?.name, "prd-board-node-verified");
  assert.equal(fake.state.authCalls, 1);
  assert.equal(fake.state.projectTitle.startsWith("[SMOKE] PRD HTTP "), true);
  assert.deepEqual(fake.state.submissionBody.request.requestedArtifactKinds, ["prd"]);
  assert.deepEqual(fake.state.submissionBody.attachments, []);
  assert.equal(fake.state.submissionBody.request.artifactTargets.length, 0);
  assert.equal(fake.state.submissionBody.request.canvasSnapshot, null);
  assert.equal(fake.state.selectedModelId, "model-generate");
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === "workbench.session_token=fake-session"));
  assert.ok(fake.state.mutationOrigins.every((origin) => origin === fake.origin));
  assertNoSecretOrPrdBody(result, [email, password, "existing-session-must-not-leak"]);
});

test("uses an explicit existing session cookie without calling the sign-in route", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true, `${result.failure?.code}: ${result.failure?.message}`);
  assert.equal(result.evidence.authMode, "session-cookie");
  assert.equal(fake.state.authCalls, 0);
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === existingCookie));
  assertNoSecretOrPrdBody(result, [existingCookie, email, password]);
});

test("fails the end-to-end HTTP smoke when the generated PRD violates source boundaries", async (t) => {
  const invalidDocument = orderNotificationPrdFixture();
  invalidDocument.assumptions.push({
    id: "assumption-runtime-metadata-http",
    statement: "无需产出原型。",
    status: "open",
    impact: "low",
    owner: "需求方",
    introducedInRevision: 1,
    citationIds: [],
  });
  const fake = await startFakeWorkbench({ prdDocument: invalidDocument });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_EMAIL: email,
      WORKBENCH_PRD_SMOKE_PASSWORD: password,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "PRD_SMOKE_SOURCE_BOUNDARY_INVALID");
});

test("fails closed before any HTTP write without the explicit write confirmation", async () => {
  let requests = 0;
  const result = await executePrdHttpSmoke({
    env: {
      NODE_ENV: "test",
      WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
      WORKBENCH_PRD_SMOKE_BASE_URL: "http://127.0.0.1:9",
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    },
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not be called");
    },
    now: fixedNow,
    randomUUID: () => smokeUuid,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "WRITE_CONFIRMATION_REQUIRED");
  assert.equal(result.evidence.projectUrl, undefined);
  assert.equal(requests, 0);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a Prototype from a PRD-only production Run", async (t) => {
  const fake = await startFakeWorkbench({ artifactKind: "prototype" });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PROTOTYPE_ARTIFACT_FORBIDDEN");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a PRD Run that skips a real template-generation stage", async (t) => {
  const fake = await startFakeWorkbench({
    generationStages: prdGenerationStages.slice(0, -1),
  });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_GENERATION_STAGES_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a PRD Run that reports a Prototype generation stage", async (t) => {
  const fake = await startFakeWorkbench({
    generationStages: [...prdGenerationStages, "generating-ui"],
  });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_GENERATION_STAGES_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects PRD generation events that do not belong to the final Run attempt", async (t) => {
  const fake = await startFakeWorkbench({ eventAttempt: 2 });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_GENERATION_STAGES_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects PRD generation events from a different Runtime request", async (t) => {
  const fake = await startFakeWorkbench({ eventRequestId: "request-other" });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_RUN_EVENT_IDENTITY_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a PRD draft event whose checksum differs from the ready version", async (t) => {
  const fake = await startFakeWorkbench({ eventChecksum: "c".repeat(64) });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_DRAFT_CHECKSUM_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects matching event and version checksums that do not hash the PRD content", async (t) => {
  const forgedChecksum = "c".repeat(64);
  const fake = await startFakeWorkbench({
    eventChecksum: forgedChecksum,
    versionChecksum: forgedChecksum,
  });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_VERSION_CHECKSUM_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects forbidden requirement-document placeholder wording", () => {
  const document = structuredClone(prdDocumentV2Example);
  document.sections.introduction.background.blocks[0].content[0].text = "待确认";

  assert.throws(
    () => assertPrdV2Structure(document),
    (error) => error?.code === "PRD_PLACEHOLDER_FORBIDDEN",
  );
});

test("requires the production smoke PRD revision to remain a draft", () => {
  const document = orderNotificationPrdFixture();
  document.revision.status = "approved";

  assert.throws(
    () => assertPrdV2Structure(document),
    (error) => error?.code === "PRD_REVISION_INVALID",
  );
});

test("requires the production smoke PRD to match the order-notification topic", () => {
  const document = orderNotificationPrdFixture();
  assert.deepEqual(assertPrdSmokeBusinessSemantics(document), {
    theme: "order-status-notification",
    themeRequirementCount: 12,
    unrelatedBusinessMatches: 0,
  });

  document.title = "其他主题需求说明书";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(document),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

test("requires order-notification facts in the business body instead of metadata", () => {
  const document = orderNotificationPrdFixture();
  document.sections.introduction = replaceStringFragments(
    document.sections.introduction,
    "权限",
    "授权",
  );
  document.sections.businessRequirements = replaceStringFragments(
    document.sections.businessRequirements,
    "权限",
    "授权",
  );
  document.sections.degradation = replaceStringFragments(
    document.sections.degradation,
    "权限",
    "授权",
  );
  assert.equal(JSON.stringify(document.assumptions).includes("权限"), true);

  assert.throws(
    () => assertPrdSmokeBusinessSemantics(document),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

test("rejects unrelated task-domain content in the production smoke PRD", () => {
  const unrelated = orderNotificationPrdFixture();
  unrelated.sections.introduction.background.blocks[0].content[0].text =
    "现有产品工作台已提供业务任务处理入口，但处理状态、异常恢复和结果确认信息不完整，用户难以判断任务是否闭环。本需求调整工作台任务页面及配套处理能力，使用户能够提交必要信息、跟踪处理状态并确认最终结果。";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(unrelated),
    (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
  );

  for (const phrase of ["任务页面", "任务执行入口", "任务状态", "任务权限", "任务记录"]) {
    const nearSynonym = orderNotificationPrdFixture();
    nearSynonym.sections.introduction.background.blocks[0].content[0].text += ` ${phrase}`;
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(nearSynonym),
      (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
      phrase,
    );
  }

  const diagramGroupDrift = orderNotificationPrdFixture();
  diagramGroupDrift.sections.businessRequirements.flowAndPages.diagrams[0].nodes[0].group = "任务能力";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(diagramGroupDrift),
    (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
  );
});

test("allows task wording that remains grounded in notification delivery", () => {
  const document = orderNotificationPrdFixture();
  document.sections.degradation.content[0].text += " 通知发送任务由队列调度，失败后生成重试任务。";

  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("rejects safety-row drift in the production smoke PRD", () => {
  const wrongApplicability = orderNotificationPrdFixture();
  wrongApplicability.sections.safetyBaseline.rows[1] = {
    sequence: 2,
    applicability: "不涉及",
    remarks: null,
  };
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(wrongApplicability),
    (error) => error?.code === "PRD_SMOKE_SAFETY_INVALID",
  );

  const shiftedRemark = orderNotificationPrdFixture();
  shiftedRemark.sections.safetyBaseline.rows[2].remarks = "本需求不投放小程序。";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(shiftedRemark),
    (error) => error?.code === "PRD_SMOKE_SAFETY_INVALID",
  );

  const swappedInvolvedRemarks = orderNotificationPrdFixture();
  const rowOneRemark = swappedInvolvedRemarks.sections.safetyBaseline.rows[0].remarks;
  swappedInvolvedRemarks.sections.safetyBaseline.rows[0].remarks =
    swappedInvolvedRemarks.sections.safetyBaseline.rows[1].remarks;
  swappedInvolvedRemarks.sections.safetyBaseline.rows[1].remarks = rowOneRemark;
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(swappedInvolvedRemarks),
    (error) => error?.code === "PRD_SMOKE_SAFETY_INVALID",
  );
});

test("rejects Runtime metadata and unrequested order facts in the production smoke PRD", () => {
  for (const phrase of [
    "本需求仅生成需求说明书，不生成原型。",
    "本次仅交付需求文档（PRD）。",
    "本次只输出 PRD。",
    "交付物仅包含需求文档(PRD)。",
    "本次只需要一份完整中文需求说明书。",
    "本次仅提供 PRD。",
    "本次交付物为完整需求说明书（PRD）。",
    "交付范围：需求文档。",
    "本次产出为 PRD。",
    "输出物是需求说明书。",
    "本需求交付一份需求文档。",
    "本次无需原型。",
    "本次不交付原型。",
    "无需制作原型。",
    "原型、代码不在本次交付范围内。",
    "订单通知开关默认开启。",
    "通知开关默认值为开启。",
    "通知开关默认值：开启。",
    "默认值为“开启”。",
    "通知开关默认状态=开启。",
    "通知开关默认设置成开启。",
    "无需产出原型。",
    "通知开关初始为开启。",
    "开关初始值为关闭。",
    "通知设置缺省为开启。",
    "通知开关预设开启。",
    "首次进入自动开启通知。",
    "订单状态分类包括待付款、待发货、待收货。",
    "订单状态分类包括待发货、待付款、待收货。",
    "订单状态分类包括待付款/已完成。",
    "待付款订单触发通知。",
    "按待支付状态发送提醒。",
    "订单状态按支付、发货、收货分类。",
  ]) {
    const document = orderNotificationPrdFixture();
    document.sections.businessRequirements.coreRules.blocks[2].content[0].text += ` ${phrase}`;
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(document),
      (error) => error?.code === "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
      phrase,
    );
  }

  const metadataOutsideBusinessSections = orderNotificationPrdFixture();
  metadataOutsideBusinessSections.assumptions.push({
    id: "assumption-runtime-metadata",
    statement: "无需产出原型。",
    status: "open",
    impact: "low",
    owner: "需求方",
    introducedInRevision: 1,
    citationIds: [],
  });
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(metadataOutsideBusinessSections),
    (error) => error?.code === "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
  );

  const splitInlineMetadata = orderNotificationPrdFixture();
  splitInlineMetadata.sections.businessRequirements.coreRules.blocks.push({
    id: "split-inline-runtime-metadata",
    type: "paragraph",
    content: [
      { type: "text", text: "本次仅生成", marks: [] },
      { type: "text", text: "需求文档", marks: ["strong"] },
    ],
  });
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(splitInlineMetadata),
    (error) => error?.code === "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
  );

  const tableDefault = orderNotificationPrdFixture();
  tableDefault.sections.businessRequirements.coreRules.blocks.push({
    id: "invented-default-table",
    type: "table",
    columns: [
      { id: "field", label: "字段" },
      { id: "default-value", label: "默认值" },
    ],
    rows: [{
      id: "notification-default-row",
      cells: [
        { columnId: "field", content: [{ type: "text", text: "通知开关", marks: [] }] },
        { columnId: "default-value", content: [{ type: "text", text: "开启", marks: [] }] },
      ],
    }],
  });
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(tableDefault),
    (error) => error?.code === "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
  );

  const tableCategory = orderNotificationPrdFixture();
  tableCategory.sections.businessRequirements.coreRules.blocks.push({
    id: "invented-category-table",
    type: "table",
    columns: [
      { id: "order-status", label: "订单状态" },
      { id: "notification-rule", label: "通知规则" },
    ],
    rows: [{
      id: "invented-completed-status",
      cells: [
        { columnId: "order-status", content: [{ type: "text", text: "已完成", marks: [] }] },
        { columnId: "notification-rule", content: [{ type: "text", text: "发送通知", marks: [] }] },
      ],
    }],
  });
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(tableCategory),
    (error) => error?.code === "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
  );
});

test("allows explicit no-new-default and existing-setting constraints", () => {
  for (const phrase of [
    "通知开关不默认开启，沿用消费者现有设置。",
    "通知设置不新增默认开启规则。",
    "通知开关没有新的默认关闭状态，沿用现状。",
  ]) {
    const document = orderNotificationPrdFixture();
    document.sections.businessRequirements.coreRules.blocks[2].content[0].text += ` ${phrase}`;
    assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document), phrase);
  }
});

test("allows completion and cancellation wording outside order-category semantics", () => {
  for (const phrase of [
    "通知发送已完成后展示结果记录。",
    "消费者已取消本次通知重试。",
  ]) {
    const document = orderNotificationPrdFixture();
    document.sections.businessRequirements.coreRules.blocks[2].content[0].text += ` ${phrase}`;
    assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document), phrase);
  }
});

test("allows an explicit existing-default constraint beside unrelated boolean cells", () => {
  const document = orderNotificationPrdFixture();
  document.sections.businessRequirements.coreRules.blocks.push({
    id: "existing-default-constraint-table",
    type: "table",
    columns: [
      { id: "field", label: "字段" },
      { id: "rule", label: "规则" },
      { id: "visible", label: "是否展示" },
    ],
    rows: [{
      id: "existing-notification-setting-row",
      cells: [
        { columnId: "field", content: [{ type: "text", text: "通知开关", marks: [] }] },
        { columnId: "rule", content: [{ type: "text", text: "默认状态沿用消费者现有设置", marks: [] }] },
        { columnId: "visible", content: [{ type: "text", text: "是", marks: [] }] },
      ],
    }],
  });
  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("allows requirement-document wording in a legitimate version-history note", () => {
  const document = orderNotificationPrdFixture();
  document.versionHistory[0].notes = "本次产出需求说明书初稿，供业务、研发和测试评审。";
  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("requires every explicit no-invention constraint from the smoke prompt", () => {
  for (const [source, replacement] of [
    ["沿用消费者现有设置", "保留通知设置入口"],
    ["不设新的默认状态", "保持通知设置可配置"],
    ["沿用订单中心既有分类", "提供订单状态分类"],
    ["不新增或枚举分类", "支持状态分类配置"],
  ]) {
    const document = orderNotificationPrdFixture();
    document.sections.businessRequirements.coreRules.blocks[2].content[0].text =
      document.sections.businessRequirements.coreRules.blocks[2].content[0].text.replace(source, replacement);
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(document),
      (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
      source,
    );
  }
});

test("rejects safety remarks with the right nouns but negative or shifted meaning", () => {
  for (const [index, remarks] of [
    [0, "现有功能不发生修改。"],
    [1, "消费者订单由内部客服管理。"],
    [1, "页面不再面向消费者。"],
    [1, "页面尚未面向消费者。"],
    [20, "本次不涉及完整性和一致性校验。"],
  ]) {
    const document = orderNotificationPrdFixture();
    document.sections.safetyBaseline.rows[index].remarks = remarks;
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(document),
      (error) => error?.code === "PRD_SMOKE_SAFETY_INVALID",
      remarks,
    );
  }
});

test("accepts a public-consumer safety remark with an explicit qualifier particle", () => {
  const document = orderNotificationPrdFixture();
  document.sections.safetyBaseline.rows[1].remarks = "订单通知设置功能面向已登录的消费者。";
  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("accepts a row 1 remark that describes construction of the requested capability", () => {
  const document = orderNotificationPrdFixture();
  document.sections.safetyBaseline.rows[0].remarks = "本次建设订单状态通知设置页面及相关业务能力。";
  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("requires the order-notification topic in each critical PRD section", () => {
  for (const mutate of [
    (document) => {
      document.sections.introduction.background = replaceStringFragments(
        replaceStringFragments(document.sections.introduction.background, "订单", "业务"),
        "通知",
        "消息",
      );
    },
    (document) => {
      document.sections.businessRequirements.coreRules = replaceStringFragments(
        replaceStringFragments(document.sections.businessRequirements.coreRules, "订单", "业务"),
        "通知",
        "消息",
      );
    },
    (document) => {
      document.sections.businessRequirements.acceptanceCriteria = replaceStringFragments(
        replaceStringFragments(document.sections.businessRequirements.acceptanceCriteria, "订单", "业务"),
        "通知",
        "消息",
      );
    },
  ]) {
    const document = orderNotificationPrdFixture();
    mutate(document);
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(document),
      (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
    );
  }
});

test("requires both diagrams and degradation to describe order-notification recovery", () => {
  const diagramDrift = orderNotificationPrdFixture();
  diagramDrift.sections.businessRequirements.flowAndPages.diagrams[1] = replaceStringFragments(
    replaceStringFragments(
      replaceStringFragments(diagramDrift.sections.businessRequirements.flowAndPages.diagrams[1], "订单", "业务"),
      "通知",
      "消息",
    ),
    "发送",
    "执行",
  );
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(diagramDrift),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );

  const degradationDrift = orderNotificationPrdFixture();
  degradationDrift.sections.degradation = replaceStringFragments(
    replaceStringFragments(degradationDrift.sections.degradation, "重试", "人工处理"),
    "恢复",
    "人工介入",
  );
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(degradationDrift),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

function smokeEnvironment(origin, auth) {
  return {
    NODE_ENV: "test",
    WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
    WORKBENCH_PRD_SMOKE_BASE_URL: origin,
    WORKBENCH_PRD_SMOKE_CONFIRM_WRITE: "CREATE_ISOLATED_PRD_SMOKE_PROJECT",
    WORKBENCH_PRD_SMOKE_POLL_INTERVAL_MS: "1",
    WORKBENCH_PRD_SMOKE_REQUEST_TIMEOUT_MS: "1000",
    WORKBENCH_PRD_SMOKE_TIMEOUT_MS: "2000",
    ...auth,
  };
}

function assertNoSecretOrPrdBody(result, forbiddenValues) {
  const serialized = JSON.stringify(result);
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("现有产品工作台已提供业务任务处理入口"), false);
  assert.equal(serialized.includes("依赖异常时保留用户输入"), false);
}

async function startFakeWorkbench({
  artifactKind = "prd",
  eventAttempt = 1,
  eventChecksum = null,
  eventRequestId = "request-smoke",
  generationStages = prdGenerationStages,
  prdDocument = orderNotificationPrdFixture(),
  versionChecksum = null,
} = {}) {
  const state = {
    apiCookies: [],
    authCalls: 0,
    bootstrapCalls: 0,
    mutationOrigins: [],
    projectTitle: "",
    runPolls: 0,
    selectedModelId: null,
    submissionBody: null,
  };
  const server = http.createServer((request, response) => {
    void handleFakeRequest(
      request,
      response,
      state,
      artifactKind,
      eventAttempt,
      eventChecksum,
      eventRequestId,
      generationStages,
      prdDocument,
      versionChecksum,
    ).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ code: "FAKE_SERVER_FAILURE" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind TCP");
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    origin: `http://127.0.0.1:${address.port}`,
    state,
  };
}

async function handleFakeRequest(
  request,
  response,
  state,
  artifactKind,
  eventAttempt,
  eventChecksum,
  eventRequestId,
  generationStages,
  prdDocument,
  versionChecksum,
) {
  const url = new URL(request.url ?? "/", "http://fake.test");
  const method = request.method ?? "GET";
  if (!["GET", "HEAD"].includes(method)) state.mutationOrigins.push(request.headers.origin ?? "");

  if (method === "POST" && url.pathname === "/api/auth/sign-in/email") {
    state.authCalls += 1;
    const body = await requestJson(request);
    assert.deepEqual(body, { email, password });
    return sendJson(response, 200, { user: { id: "principal-smoke" } }, {
      "Set-Cookie": "workbench.session_token=fake-session; Path=/; HttpOnly; Secure; SameSite=Lax",
    });
  }

  if (url.pathname.startsWith("/api/v1/")) {
    state.apiCookies.push(request.headers.cookie ?? "");
  }
  if (method === "GET" && url.pathname === "/api/v1/identity/me") {
    return sendJson(response, 200, {
      id: "principal-smoke",
      defaultWorkspaceId: "workspace-smoke",
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runtime/models") {
    return sendJson(response, 200, {
      items: [
        { id: "model-edit", supportedWorkflows: ["edit"] },
        { id: "model-generate", supportedWorkflows: ["generate", "edit"] },
      ],
    });
  }
  if (method === "POST" && url.pathname === "/api/v1/workspaces/workspace-smoke/projects") {
    const body = await requestJson(request);
    state.projectTitle = body.title;
    return sendJson(response, 201, { id: "project-smoke" });
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/bootstrap") {
    state.bootstrapCalls += 1;
    return sendJson(response, 200, state.bootstrapCalls === 1
      ? initialBootstrap()
      : completedBootstrap());
  }
  if (method === "POST" && url.pathname === "/api/v1/threads/thread-smoke/submission-intents") {
    state.submissionBody = await requestJson(request);
    state.selectedModelId = state.submissionBody.request.modelId;
    return sendJson(response, 201, { id: "intent-smoke", status: "pending" });
  }
  if (method === "POST" && url.pathname === "/api/v1/submission-intents/intent-smoke/submit") {
    return sendJson(response, 202, {
      intent: { id: "intent-smoke", runId: "run-smoke", status: "submitted" },
      run: runFixture("queued"),
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runs/run-smoke") {
    state.runPolls += 1;
    return sendJson(response, 200, runFixture(
      state.runPolls === 1 ? "queued" : state.runPolls === 2 ? "running" : "succeeded",
    ));
  }
  if (method === "GET" && url.pathname === "/api/v1/runs/run-smoke/events") {
    const stageEvents = generationStages.map((stage, index) => (
      prdGenerationStageEventFixture(stage, index + 1, eventAttempt, eventRequestId)
    ));
    return sendRunEventStream(response, [
      ...stageEvents,
      prdDraftEventFixture(
        stageEvents.length + 1,
        eventAttempt,
        eventChecksum ?? sha256Canonical(prdDocument),
        eventRequestId,
      ),
    ]);
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/artifacts") {
    return sendJson(response, 200, {
      items: [artifactKind === "prototype" ? prototypeArtifactFixture() : prdArtifactFixture()],
      nextCursor: null,
    });
  }
  if (
    method === "GET"
    && url.pathname === "/api/v1/artifacts/artifact-smoke/versions/version-smoke"
  ) {
    return sendJson(response, 200, prdVersionFixture(prdDocument, versionChecksum));
  }
  return sendJson(response, 404, { code: "FAKE_ROUTE_NOT_FOUND" });
}

function initialBootstrap() {
  return {
    artifacts: [],
    board: { nodes: [] },
    selectedThreadId: "thread-smoke",
    threads: [{ id: "thread-smoke" }],
  };
}

function completedBootstrap() {
  return {
    artifacts: [prdArtifactFixture()],
    board: {
      nodes: [{
        artifactId: "artifact-smoke",
        artifactVersionId: "version-smoke",
        data: { artifactKind: "prd" },
        size: { height: 500, width: 500 },
      }],
    },
    threads: [{ id: "thread-smoke" }],
  };
}

function runFixture(status) {
  return {
    attempt: status === "queued" ? 0 : 1,
    failure: null,
    id: "run-smoke",
    progress: status === "succeeded" ? 1 : status === "running" ? 0.5 : 0,
    projectId: "project-smoke",
    requestedArtifactKinds: ["prd"],
    requestId: "request-smoke",
    status,
    threadId: "thread-smoke",
  };
}

function prdArtifactFixture() {
  return {
    id: "artifact-smoke",
    kind: "prd",
    currentVersion: {
      artifactId: "artifact-smoke",
      artifactVersionId: "version-smoke",
      createdByRunId: "run-smoke",
      kind: "prd",
      schemaVersion: 2,
      status: "ready",
    },
  };
}

function prototypeArtifactFixture() {
  return {
    id: "artifact-prototype",
    kind: "prototype",
    currentVersion: {
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      createdByRunId: "run-smoke",
      kind: "prototype",
      schemaVersion: 1,
      status: "ready",
    },
  };
}

function prdVersionFixture(document = orderNotificationPrdFixture(), checksum = null) {
  return {
    artifactId: "artifact-smoke",
    artifactVersionId: "version-smoke",
    checksum: checksum ?? sha256Canonical(document),
    citations: [],
    content: document,
    contentMode: "inline",
    createdAt: "2026-07-23T09:01:00.000Z",
    createdByRunId: "run-smoke",
    kind: "prd",
    knowledgeReleaseId: null,
    schemaVersion: 2,
    status: "ready",
    version: 1,
  };
}

function orderNotificationPrdFixture() {
  let document = structuredClone(prdDocumentV2Example);
  for (const [source, replacement] of [
    ["产品工作台", "电商订单中心"],
    ["当前项目", "电商订单中心"],
    ["目标业务用户", "已登录消费者"],
    ["提交区", "通知设置区"],
    ["运行状态区", "发送状态区"],
    ["任务处理", "通知发送"],
    ["任务页面", "通知设置页"],
    ["任务状态", "发送状态"],
    ["任务记录", "发送记录"],
    ["任务编号", "通知编号"],
    ["任务", "通知"],
    ["提交", "保存"],
    ["处理", "发送"],
    ["结果", "发送结果"],
    ["输入", "设置内容"],
    ["阶段", "发送阶段"],
    ["重复", "多次"],
  ]) {
    document = replaceStringFragments(document, source, replacement);
  }
  document.documentId = "prd-smoke-order-notification";
  document.title = "电商订单状态通知设置需求说明书";
  document.cover = {
    workOrderName: "电商订单状态通知设置",
    title: "电商订单状态通知设置需求说明书",
  };
  document.sections.introduction.background.blocks[0].content[0].text =
    "电商订单中心当前缺少统一的端内状态通知设置，已登录消费者无法按订单状态管理提醒。本需求新增通知开关、状态分类和发送记录，并补齐失败重试及权限反馈。";
  document.sections.introduction.usageScenarios.blocks[0].content[0].text =
    "已登录消费者从订单中心端内入口进入通知设置页，按订单状态分类开启或关闭通知，并查看发送结果记录。";
  document.sections.introduction.usageScenarios.channelTable.rows = [
    { sequence: 1, channel: "inApp", enabled: true },
    { sequence: 2, channel: "wapH5", enabled: false },
    { sequence: 3, channel: "miniProgram", enabled: false },
  ];
  document.sections.businessRequirements.summary[0].text =
    "总体目标：已登录消费者可配置订单状态通知开关，查看发送结果记录，并在发送失败时重试或获得明确权限反馈。";
  document.sections.businessRequirements.coreRules.blocks[2].content[0].text =
    "本需求修改现有订单通知功能逻辑；通知开关不设新的默认状态，沿用消费者现有设置；订单状态分类沿用订单中心既有分类，不新增或枚举分类；通知设置数据与发送状态均执行完整性和一致性校验。";
  document.sections.safetyBaseline.rows[1] = {
    sequence: 2,
    applicability: "是",
    remarks: "订单通知设置功能面向已登录消费者。",
  };
  return document;
}

function replaceStringFragments(value, source, replacement) {
  if (typeof value === "string") return value.replaceAll(source, replacement);
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringFragments(item, source, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, replaceStringFragments(item, source, replacement)],
    ));
  }
  return value;
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function prdGenerationStageEventFixture(stage, sequence, attempt = 1, requestId = "request-smoke") {
  return {
    protocol: "workbench.run.v1",
    id: `event-stage-${sequence}`,
    projectId: "project-smoke",
    threadId: "thread-smoke",
    runId: "run-smoke",
    requestId,
    sequence,
    occurredAt: `2026-07-23T09:00:0${sequence}.000Z`,
    traceId: "trace-smoke",
    type: "run.generation.stage.changed",
    payload: { attempt, stage },
  };
}

function prdDraftEventFixture(
  sequence,
  attempt = 1,
  checksum = "a".repeat(64),
  requestId = "request-smoke",
) {
  return {
    protocol: "workbench.run.v1",
    id: "event-draft-smoke",
    projectId: "project-smoke",
    threadId: "thread-smoke",
    runId: "run-smoke",
    requestId,
    sequence,
    occurredAt: "2026-07-23T09:00:30.000Z",
    traceId: "trace-smoke",
    type: "artifact.draft.created",
    payload: {
      attempt,
      artifactIndex: 0,
      artifactId: "artifact-smoke",
      artifactVersionId: "version-smoke",
      kind: "prd",
      checksum,
      draftChecksum: "b".repeat(64),
      screens: [],
    },
  };
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendRunEventStream(response, events) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  response.end(events.map((event) => (
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join(""));
}
