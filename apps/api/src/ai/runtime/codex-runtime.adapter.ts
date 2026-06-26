import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { ExternalRuntimeConfigService } from "./external-runtime-config.service";
import type {
  RequirementRuntimeInput,
  RequirementRuntimeOutput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeResult,
  RuntimeTask,
} from "./external-runtime.types";
import type {
  AssumptionReference,
  ClarificationQuestionReference,
  ProductDesignDraft,
  PrototypeArtifactDraft,
  PrototypeSpec,
  RequirementDocumentDraft,
  RequirementDocSection,
} from "../ai-vibe.types";

@Injectable()
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly provider = "codex" as const;

  constructor(private readonly config: ExternalRuntimeConfigService) {}

  async runTask<TInput, TOutput>(task: RuntimeTask<TInput>): Promise<RuntimeResult<TOutput>> {
    if (task.taskType === "intake_requirement") {
      return this.runRequirementIntake(task as RuntimeTask<RequirementRuntimeInput>) as Promise<RuntimeResult<TOutput>>;
    }
    if (task.taskType === "prototype_code_generation") {
      return this.runPrototypeCode(task as RuntimeTask<PrototypeCodeRuntimeInput>) as Promise<RuntimeResult<TOutput>>;
    }
    if (
      task.taskType === "generate_prototype" ||
      task.taskType === "patch_prd" ||
      task.taskType === "patch_prototype" ||
      task.taskType === "qa_review"
    ) {
      return this.runStructuredJson(task as RuntimeTask<unknown>) as Promise<RuntimeResult<TOutput>>;
    }
    throw new Error(`Codex runtime 暂不支持任务类型：${task.taskType}`);
  }

  private async runRequirementIntake(
    task: RuntimeTask<RequirementRuntimeInput>,
  ): Promise<RuntimeResult<RequirementRuntimeOutput>> {
    const workspace = await this.createWorkspace(task);
    const inputPath = join(workspace, "runtime-input.json");
    const promptPath = join(workspace, "prompt.md");
    const outputPath = join(workspace, "runtime-output.json");
    const events: RuntimeEvent[] = [
      event(task, "runtime_task_started", "Codex runtime 已创建需求规划任务。"),
    ];

    const runtimeInput = prepareRuntimeInput(task);
    await writeFile(inputPath, JSON.stringify(runtimeInput.input, null, 2), "utf8");
    await writeFile(promptPath, requirementPrompt(task.input), "utf8");
    events.push(event(task, "runtime_file_changed", `已写入 ${basename(inputPath)} 和 ${basename(promptPath)}。`, {
      files: [inputPath, promptPath],
      inputCompaction: runtimeInput.meta,
    }));

    const rawEvents = await this.runCodex(workspace, promptPath, task, events, {
      expectedOutputPath: outputPath,
      outputKind: "json",
    });
    const outputText = await readFile(outputPath, "utf8");
    const output = normalizeRequirementRuntimeOutput(parseJsonText(outputText) ?? outputText, task);
    events.push(event(task, "runtime_artifact_created", "Codex 已生成 runtime-output.json。", {
      filePath: outputPath,
    }));

    return {
      provider: this.provider,
      taskId: task.id,
      runId: task.runId,
      status: "completed",
      output,
      artifacts: [{ path: outputPath, kind: "json", content: JSON.stringify(output) }],
      events: [...events, event(task, "runtime_task_completed", "Codex runtime 需求规划完成。")],
      raw: rawEvents,
    };
  }

  private async runPrototypeCode(
    task: RuntimeTask<PrototypeCodeRuntimeInput>,
  ): Promise<RuntimeResult<PrototypeArtifactDraft>> {
    const prototypeSpec = task.input.prototypeSpec;
    const workspace = await this.createWorkspace(task);
    const specPath = join(workspace, "prototype-spec.json");
    const promptPath = join(workspace, "prompt.md");
    const outputPath = join(workspace, "index.html");
    const events: RuntimeEvent[] = [
      event(task, "runtime_task_started", "Codex runtime 已创建原型生成任务。"),
    ];

    await writeFile(specPath, JSON.stringify(prototypeSpec, null, 2), "utf8");
    await writeFile(promptPath, prototypePrompt(prototypeSpec), "utf8");
    events.push(event(task, "runtime_file_changed", `已写入 ${basename(specPath)} 和 ${basename(promptPath)}。`, {
      files: [specPath, promptPath],
    }));

    const rawEvents = await this.runCodex(workspace, promptPath, task, events, {
      expectedOutputPath: outputPath,
      outputKind: "html",
    });
    const htmlContent = await readFile(outputPath, "utf8");
    events.push(event(task, "runtime_artifact_created", "Codex 已生成 index.html。", {
      filePath: outputPath,
    }));

    return {
      provider: this.provider,
      taskId: task.id,
      runId: task.runId,
      status: "completed",
      output: {
        id: randomUUID(),
        projectId: prototypeSpec.projectId,
        prototypeSpecId: prototypeSpec.id,
        productDesignStateId: prototypeSpec.productDesignStateId,
        productDesignStateVersion: prototypeSpec.productDesignStateVersion,
        title: prototypeSpec.title,
        htmlContent,
        html: htmlContent,
        entryFilePath: "index.html",
        entryFile: "index.html",
        targetDevice: prototypeSpec.targetDevice,
        pageCount: prototypeSpec.pages.length || 1,
        generatedByRunId: task.runId,
        assets: [],
      },
      artifacts: [{ path: outputPath, kind: "html", content: htmlContent }],
      events: [...events, event(task, "runtime_task_completed", "Codex runtime 原型生成完成。")],
      raw: rawEvents,
    };
  }

  private async createWorkspace(task: RuntimeTask<unknown>) {
    const safeId = `${task.runId}_${task.taskType}_${task.id}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const workspace = join(this.config.workspaceRoot(), safeId);
    await mkdir(workspace, { recursive: true });
    return workspace;
  }

  private async runCodex(
    workspace: string,
    promptPath: string,
    task: RuntimeTask<unknown>,
    events: RuntimeEvent[],
    options?: CodexRunOptions,
  ) {
    const prompt = await readFile(promptPath, "utf8");
    const args = [
      "exec",
      "--json",
      "--sandbox",
      this.config.codexSandbox(),
      "--cd",
      workspace,
      "--skip-git-repo-check",
      "--ephemeral",
      ...this.codexConfigArgs(),
      prompt,
    ];
    events.push(event(task, "runtime_tool_called", "正在调用 Codex CLI 执行 runtime task。", {
      command: this.config.codexCommand(),
      args: args.slice(0, -1),
      cwd: workspace,
    }));

    const child = spawn(this.config.codexCommand(), args, {
      cwd: workspace,
      env: this.codexEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rawEvents: unknown[] = [];
    const stderrChunks: string[] = [];
    let lastActivityAt = Date.now();
    let lastOutputSignature = "";
    const touch = () => {
      lastActivityAt = Date.now();
    };
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      touch();
      const parsed = parseJsonLine(line);
      rawEvents.push(parsed ?? line);
      if (parsed) {
        events.push(event(task, eventTypeFromCodex(parsed), summaryFromCodex(parsed), parsed));
      }
    });
    child.stderr.on("data", (chunk) => {
      touch();
      stderrChunks.push(String(chunk));
    });

    let finished = false;
    const closePromise = new Promise<CodexCloseResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const idlePromise = this.waitForIdleTimeout(
      () => finished,
      async () => {
        if (!options?.expectedOutputPath) return;
        const nextSignature = await this.inspectOutputSignature(options.expectedOutputPath);
        if (!nextSignature) return;
        if (nextSignature !== lastOutputSignature) {
          lastOutputSignature = nextSignature;
          touch();
        }
      },
      () => lastActivityAt,
    );

    const result = await Promise.race([
      closePromise.then((closeResult) => ({ type: "closed" as const, closeResult })),
      idlePromise.then(() => ({ type: "idle_timeout" as const })),
    ]);
    finished = true;

    if (result.type === "idle_timeout") {
      const outputReady = options?.expectedOutputPath ? await this.inspectExpectedOutput(options) : undefined;
      if (outputReady?.ready) {
        const idleTimeoutMs = this.config.codexIdleTimeoutMs();
        events.push(event(task, "runtime_warning", `Codex runtime 已 ${idleTimeoutMs}ms 无新增输出，预期产物已可用，已结束子进程并继续。`, {
          filePath: outputReady.path,
          size: outputReady.size,
          idleTimeoutMs,
        }));
        await this.stopCodexChild(child, closePromise);
        return rawEvents;
      }
      await this.stopCodexChild(child, closePromise);
      const stderr = stderrChunks.join("").replace(/\s+/g, " ").trim();
      throw new Error(`Codex runtime 空闲超时（${this.config.codexIdleTimeoutMs()}ms 无新增输出）${stderr ? `：${stderr}` : ""}`);
    }

    const { exitCode } = result.closeResult;

    if (exitCode !== 0) {
      const stderr = stderrChunks.join("").replace(/\s+/g, " ").trim();
      throw new Error(`Codex runtime 执行失败（exit ${exitCode ?? "unknown"}）${stderr ? `：${stderr}` : ""}`);
    }

    return rawEvents;
  }

  private async waitForIdleTimeout(
    shouldStop: () => boolean,
    inspectActivity: () => Promise<void>,
    lastActivityAt: () => number,
  ) {
    const idleTimeoutMs = this.config.codexIdleTimeoutMs();
    const pollMs = this.config.codexIdlePollMs();
    while (!shouldStop()) {
      await inspectActivity();
      if (Date.now() - lastActivityAt() >= idleTimeoutMs) return;
      await sleep(pollMs);
    }
  }

  private async inspectOutputSignature(filePath: string) {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size <= 0) return undefined;
      return `${fileStat.size}:${fileStat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  private async inspectExpectedOutput(options: CodexRunOptions): Promise<CodexOutputReady | undefined> {
    if (!options.expectedOutputPath) return undefined;
    try {
      const fileStat = await stat(options.expectedOutputPath);
      if (!fileStat.isFile() || fileStat.size <= 0) return undefined;
      const content = await readFile(options.expectedOutputPath, "utf8");
      if (!isExpectedOutputReady(content, options.outputKind)) return undefined;
      return {
        path: options.expectedOutputPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ready: true,
      };
    } catch {
      return undefined;
    }
  }

  private async stopCodexChild(
    child: ChildProcess,
    closePromise: Promise<CodexCloseResult>,
  ) {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const closed = await Promise.race([
      closePromise.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    if (!closed && child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        closePromise,
        sleep(1_000),
      ]);
    }
  }

  private codexConfigArgs() {
    const model = this.config.codexModel();
    const baseUrl = this.config.codexBaseUrl();
    const args: string[] = [];
    if (model) args.push("--model", model);
    if (baseUrl) {
      const providerId = this.config.codexModelProviderId();
      args.push(
        "--config",
        `model_provider=${tomlString(providerId)}`,
        "--config",
        `model_providers.${providerId}.name=${tomlString(this.config.codexModelProviderName())}`,
        "--config",
        `model_providers.${providerId}.base_url=${tomlString(baseUrl)}`,
        "--config",
        `model_providers.${providerId}.wire_api=${tomlString("responses")}`,
        "--config",
        `model_providers.${providerId}.env_key=${tomlString("CODEX_API_KEY")}`,
        "--config",
        `model_providers.${providerId}.supports_websockets=${this.config.codexSupportsWebsockets() ? "true" : "false"}`,
      );
    }
    return args;
  }

  private codexEnv(): NodeJS.ProcessEnv {
    const apiKey = this.config.codexApiKey();
    return {
      ...process.env,
      ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {}),
    };
  }

  private async runStructuredJson(task: RuntimeTask<unknown>): Promise<RuntimeResult<unknown>> {
    const workspace = await this.createWorkspace(task);
    const inputPath = join(workspace, "runtime-input.json");
    const promptPath = join(workspace, "prompt.md");
    const outputPath = join(workspace, "runtime-output.json");
    const events: RuntimeEvent[] = [
      event(task, "runtime_task_started", `Codex runtime 已创建 ${task.taskType} 任务。`),
    ];

    const runtimeInput = prepareRuntimeInput(task);
    await writeFile(inputPath, JSON.stringify(runtimeInput.input, null, 2), "utf8");
    await writeFile(promptPath, structuredPrompt(task.taskType), "utf8");
    events.push(event(task, "runtime_file_changed", `已写入 ${basename(inputPath)} 和 ${basename(promptPath)}。`, {
      files: [inputPath, promptPath],
      inputCompaction: runtimeInput.meta,
    }));

    const rawEvents = await this.runCodex(workspace, promptPath, task, events, {
      expectedOutputPath: outputPath,
      outputKind: "json",
    });
    const outputText = await readFile(outputPath, "utf8");
    const output = parseJsonText(outputText);
    if (!output) {
      throw new Error("Codex runtime 未生成有效 runtime-output.json");
    }
    events.push(event(task, "runtime_artifact_created", "Codex 已生成 runtime-output.json。", {
      filePath: outputPath,
    }));

    return {
      provider: this.provider,
      taskId: task.id,
      runId: task.runId,
      status: "completed",
      output,
      artifacts: [{ path: outputPath, kind: "json", content: outputText }],
      events: [...events, event(task, "runtime_task_completed", `Codex runtime ${task.taskType} 任务完成。`)],
      raw: rawEvents,
    };
  }
}

type PrototypeCodeRuntimeInput = {
  prototypeSpec: PrototypeSpec;
  mode: "single_html";
  generatedByRunId?: string;
};

type CodexRunOptions = {
  expectedOutputPath?: string;
  outputKind: "json" | "html";
};

type CodexOutputReady = {
  path: string;
  size: number;
  mtimeMs: number;
  ready: true;
};

type CodexCloseResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type RuntimeInputCompactionResult = {
  input: unknown;
  meta: {
    taskType: RuntimeTask["taskType"];
    originalBytes: number;
    compactedBytes: number;
    reducedBytes: number;
    reductionPercent: number;
    wasCompacted: boolean;
    limits: typeof RUNTIME_INPUT_COMPACTION_LIMITS;
  };
};

type CompactOptions = {
  stringChars: number;
  arrayItems: number;
  depth: number;
};

type CompactContext = {
  selectedRegion?: Record<string, unknown>;
  embedded?: boolean;
};

const RUNTIME_INPUT_COMPACTION_LIMITS = {
  userInputChars: 12_000,
  recentMessages: 8,
  recentMessageChars: 1_200,
  attachmentItems: 8,
  attachmentTextChars: 1_500,
  stateArrayItems: 32,
  stateStringChars: 1_500,
  knowledgeItems: 6,
  knowledgeTextChars: 1_200,
  prdSections: 18,
  prdSectionChars: 1_800,
  selectedPrdSectionChars: 7_000,
  prototypePages: 12,
  prototypeComponents: 24,
  prototypeStringChars: 1_200,
  selectedPrototypeStringChars: 4_000,
} as const;

const DEFAULT_COMPACT_OPTIONS: CompactOptions = {
  stringChars: 1_200,
  arrayItems: 24,
  depth: 4,
};

function prepareRuntimeInput(task: RuntimeTask<unknown>): RuntimeInputCompactionResult {
  const originalText = JSON.stringify(task.input) ?? "null";
  const compactedInput = compactRuntimeInput(task);
  const compactedText = JSON.stringify(compactedInput) ?? "null";
  const originalBytes = Buffer.byteLength(originalText, "utf8");
  const compactedBytes = Buffer.byteLength(compactedText, "utf8");
  const reducedBytes = Math.max(0, originalBytes - compactedBytes);
  return {
    input: compactedInput,
    meta: {
      taskType: task.taskType,
      originalBytes,
      compactedBytes,
      reducedBytes,
      reductionPercent: originalBytes > 0 ? Math.round((reducedBytes / originalBytes) * 100) : 0,
      wasCompacted: compactedBytes < originalBytes,
      limits: RUNTIME_INPUT_COMPACTION_LIMITS,
    },
  };
}

function compactRuntimeInput(task: RuntimeTask<unknown>): unknown {
  const input = asRecord(task.input);
  if (!input) return compactUnknown(task.input, DEFAULT_COMPACT_OPTIONS);
  if (task.taskType === "intake_requirement") return compactRequirementRuntimeInput(input);
  if (task.taskType === "generate_prototype") return compactPrototypeSpecRuntimeInput(input);
  if (task.taskType === "patch_prd" || task.taskType === "patch_prototype") return compactPatchRuntimeInput(input);
  if (task.taskType === "qa_review") return compactQaRuntimeInput(input);
  return compactPlainObject(input, DEFAULT_COMPACT_OPTIONS);
}

function compactRequirementRuntimeInput(input: Record<string, unknown>) {
  const selectedRegion = compactSelectedRegion(input.selectedRegion);
  return compactRuntimeObject(input, {
    userInput: compactMaybeString(input.userInput, RUNTIME_INPUT_COMPACTION_LIMITS.userInputChars),
    recentMessages: compactRecentMessages(input.recentMessages),
    attachments: compactAttachments(input.attachments),
    productDesignState: compactProductDesignState(input.productDesignState, { selectedRegion, embedded: true }),
    selectedRegion,
  });
}

function compactPrototypeSpecRuntimeInput(input: Record<string, unknown>) {
  return compactRuntimeObject(input, {
    productDesignState: compactProductDesignState(input.productDesignState, { embedded: true }),
  });
}

function compactPatchRuntimeInput(input: Record<string, unknown>) {
  const selectedRegion = compactSelectedRegion(input.selectedRegion);
  return compactRuntimeObject(input, {
    userInput: compactMaybeString(input.userInput, RUNTIME_INPUT_COMPACTION_LIMITS.userInputChars),
    selectedRegion,
    productDesignState: compactProductDesignState(input.productDesignState, { selectedRegion, embedded: true }),
    prdDocument: compactRequirementDocument(input.prdDocument, { selectedRegion }),
    prototypeSpec: compactPrototypeSpec(input.prototypeSpec, { selectedRegion }),
    knowledgeContext: compactKnowledgeContext(input.knowledgeContext),
  });
}

function compactQaRuntimeInput(input: Record<string, unknown>) {
  return compactRuntimeObject(input, {
    productDesignState: compactProductDesignState(input.productDesignState, { embedded: true }),
    prdDocument: compactRequirementDocument(input.prdDocument, {}),
    prototypeSpec: compactPrototypeSpec(input.prototypeSpec, {}),
    patchPlan: compactUnknown(input.patchPlan, DEFAULT_COMPACT_OPTIONS),
    knowledgeContext: compactKnowledgeContext(input.knowledgeContext),
  });
}

function compactProductDesignState(value: unknown, context: CompactContext): unknown {
  const record = asRecord(value);
  if (!record) return compactUnknown(value, DEFAULT_COMPACT_OPTIONS);
  const result: Record<string, unknown> = {};
  for (const key of [
    "id",
    "projectId",
    "version",
    "title",
    "summary",
    "businessGoal",
    "background",
    "status",
    "createdBy",
    "updatedBy",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in record) result[key] = compactMaybeString(record[key], RUNTIME_INPUT_COMPACTION_LIMITS.stateStringChars);
  }
  for (const key of [
    "targetUsers",
    "userScenarios",
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
    "acceptanceCriteria",
    "assumptions",
    "pendingQuestions",
    "confirmedFacts",
  ]) {
    if (key in record) {
      result[key] = compactRecordArray(record[key], RUNTIME_INPUT_COMPACTION_LIMITS.stateArrayItems, {
        stringChars: RUNTIME_INPUT_COMPACTION_LIMITS.stateStringChars,
        arrayItems: 16,
        depth: 3,
      });
    }
  }
  if ("prototypeOutline" in record) {
    result.prototypeOutline = compactUnknown(record.prototypeOutline, {
      stringChars: RUNTIME_INPUT_COMPACTION_LIMITS.prototypeStringChars,
      arrayItems: 16,
      depth: 4,
    });
  }
  if ("knowledgeRefs" in record) result.knowledgeRefs = compactKnowledgeRefs(record.knowledgeRefs);
  if ("prdDocument" in record) {
    result.prdDocument = compactRequirementDocument(record.prdDocument, { ...context, embedded: true });
  }
  if ("prototypeSpec" in record) {
    result.prototypeSpec = compactPrototypeSpec(record.prototypeSpec, { ...context, embedded: true });
  }
  return result;
}

function compactRequirementDocument(value: unknown, context: CompactContext): unknown {
  const record = asRecord(value);
  if (!record) return compactUnknown(value, DEFAULT_COMPACT_OPTIONS);
  const result: Record<string, unknown> = {};
  for (const key of [
    "id",
    "projectId",
    "productDesignStateId",
    "productDesignStateVersion",
    "title",
    "status",
    "generatedByRunId",
    "createdBy",
    "updatedBy",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in record) result[key] = compactMaybeString(record[key], RUNTIME_INPUT_COMPACTION_LIMITS.stateStringChars);
  }
  result.sections = compactRequirementSections(record.sections, context);
  result.assumptions = compactRecordArray(record.assumptions, 16, DEFAULT_COMPACT_OPTIONS);
  result.knowledgeRefs = compactKnowledgeRefs(record.knowledgeRefs);
  result.pendingQuestions = compactRecordArray(record.pendingQuestions, 16, DEFAULT_COMPACT_OPTIONS);
  result.validationNotes = compactStringArray(record.validationNotes, 12, RUNTIME_INPUT_COMPACTION_LIMITS.stateStringChars);
  return result;
}

function compactRequirementSections(value: unknown, context: CompactContext) {
  const sections = recordArray(value);
  const selectedSectionId = text(context.selectedRegion?.sectionId) || text(context.selectedRegion?.targetId);
  const selectedIndex = selectedSectionId
    ? sections.findIndex((section) => text(section.id) === selectedSectionId)
    : -1;
  const indices = selectIndices(sections.length, RUNTIME_INPUT_COMPACTION_LIMITS.prdSections, selectedIndex);
  return indices.map((index) => compactRequirementSection(sections[index], index === selectedIndex));
}

function compactRequirementSection(section: Record<string, unknown>, selected: boolean) {
  const contentChars = selected
    ? RUNTIME_INPUT_COMPACTION_LIMITS.selectedPrdSectionChars
    : RUNTIME_INPUT_COMPACTION_LIMITS.prdSectionChars;
  const result: Record<string, unknown> = {};
  for (const key of ["id", "title", "type", "level", "order", "createdAt", "updatedAt"]) {
    if (key in section) result[key] = compactMaybeString(section[key], 800);
  }
  result.content = compactMaybeString(section.content, contentChars);
  result.blocks = compactSectionBlocks(section.blocks, selected);
  result.sourcePaths = compactStringArray(section.sourcePaths, 12, 400);
  result.sourceStatePaths = compactStringArray(section.sourceStatePaths, 12, 400);
  result.tags = compactStringArray(section.tags, 12, 120);
  return result;
}

function compactSectionBlocks(value: unknown, selected: boolean) {
  const blocks = recordArray(value);
  const maxBlocks = selected ? 10 : 4;
  return blocks.slice(0, maxBlocks).map((block) => ({
    ...compactPlainObject(block, {
      stringChars: selected ? 1_000 : 500,
      arrayItems: 8,
      depth: 2,
    }),
    content: compactMaybeString(block.content, selected ? 1_000 : 500),
    sourcePaths: compactStringArray(block.sourcePaths, 8, 300),
    tags: compactStringArray(block.tags, 8, 120),
  }));
}

function compactPrototypeSpec(value: unknown, context: CompactContext): unknown {
  const record = asRecord(value);
  if (!record) return compactUnknown(value, DEFAULT_COMPACT_OPTIONS);
  const result: Record<string, unknown> = {};
  for (const key of [
    "id",
    "projectId",
    "productDesignStateId",
    "productDesignStateVersion",
    "title",
    "targetDevice",
    "generatedByRunId",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in record) result[key] = compactMaybeString(record[key], RUNTIME_INPUT_COMPACTION_LIMITS.prototypeStringChars);
  }
  result.styleGuide = compactUnknown(record.styleGuide, {
    stringChars: 800,
    arrayItems: 8,
    depth: 3,
  });
  result.pages = compactPrototypePages(record.pages, context);
  result.navigation = compactRecordArray(record.navigation, 40, DEFAULT_COMPACT_OPTIONS);
  result.interactions = compactRecordArray(record.interactions, 40, DEFAULT_COMPACT_OPTIONS);
  result.assumptions = compactRecordArray(record.assumptions, 16, DEFAULT_COMPACT_OPTIONS);
  result.knowledgeRefs = compactKnowledgeRefs(record.knowledgeRefs);
  return result;
}

function compactPrototypePages(value: unknown, context: CompactContext) {
  const pages = recordArray(value);
  const selectedPageId = text(context.selectedRegion?.pageId);
  const selectedIndex = selectedPageId
    ? pages.findIndex((page) => text(page.id) === selectedPageId)
    : -1;
  const indices = selectIndices(pages.length, RUNTIME_INPUT_COMPACTION_LIMITS.prototypePages, selectedIndex);
  return indices.map((index) => compactPrototypePage(pages[index], {
    ...context,
    selectedPage: index === selectedIndex,
  }));
}

function compactPrototypePage(page: Record<string, unknown>, context: CompactContext & { selectedPage?: boolean }) {
  const result: Record<string, unknown> = {};
  const stringChars = context.selectedPage
    ? RUNTIME_INPUT_COMPACTION_LIMITS.selectedPrototypeStringChars
    : RUNTIME_INPUT_COMPACTION_LIMITS.prototypeStringChars;
  for (const key of ["id", "name", "route", "sourcePageId", "device", "layout", "description", "order"]) {
    if (key in page) result[key] = compactMaybeString(page[key], stringChars);
  }
  result.components = compactPrototypeComponents(page.components, context, 0);
  result.states = compactRecordArray(page.states, 12, {
    stringChars,
    arrayItems: 12,
    depth: 3,
  });
  result.sourcePaths = compactStringArray(page.sourcePaths, 12, 400);
  return result;
}

function compactPrototypeComponents(value: unknown, context: CompactContext, depth: number) {
  const components = recordArray(value);
  const selectedComponentId = text(context.selectedRegion?.componentId) || text(context.selectedRegion?.targetId);
  const selectedIndex = selectedComponentId
    ? components.findIndex((component) => text(component.id) === selectedComponentId)
    : -1;
  const maxItems = depth === 0
    ? RUNTIME_INPUT_COMPACTION_LIMITS.prototypeComponents
    : Math.max(8, Math.floor(RUNTIME_INPUT_COMPACTION_LIMITS.prototypeComponents / 2));
  const indices = selectIndices(components.length, maxItems, selectedIndex);
  return indices.map((index) => compactPrototypeComponent(components[index], context, depth, index === selectedIndex));
}

function compactPrototypeComponent(
  component: Record<string, unknown>,
  context: CompactContext,
  depth: number,
  selected: boolean,
) {
  const stringChars = selected
    ? RUNTIME_INPUT_COMPACTION_LIMITS.selectedPrototypeStringChars
    : RUNTIME_INPUT_COMPACTION_LIMITS.prototypeStringChars;
  const result: Record<string, unknown> = {};
  for (const key of ["id", "name", "type", "description", "content"]) {
    if (key in component) result[key] = compactMaybeString(component[key], stringChars);
  }
  result.props = compactUnknown(component.props, {
    stringChars,
    arrayItems: 12,
    depth: 3,
  });
  result.states = compactStringArray(component.states, 12, 300);
  result.interactions = compactStringArray(component.interactions, 12, 300);
  result.sourcePaths = compactStringArray(component.sourcePaths, 12, 400);
  if (depth < 4) result.children = compactPrototypeComponents(component.children, context, depth + 1);
  return result;
}

function compactKnowledgeContext(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return compactUnknown(value, DEFAULT_COMPACT_OPTIONS);
  return {
    query: compactMaybeString(record.query, RUNTIME_INPUT_COMPACTION_LIMITS.knowledgeTextChars),
    summary: compactMaybeString(record.summary, 2_500),
    strongRules: compactKnowledgeRefs(record.strongRules),
    defaultRules: compactKnowledgeRefs(record.defaultRules),
    referenceCases: compactKnowledgeRefs(record.referenceCases),
    designPatterns: compactKnowledgeRefs(record.designPatterns),
    prdWritingRules: compactKnowledgeRefs(record.prdWritingRules),
    prototypeRules: compactKnowledgeRefs(record.prototypeRules),
    businessConcepts: compactKnowledgeRefs(record.businessConcepts),
    runtimeSkills: compactRecordArray(record.runtimeSkills, 8, {
      stringChars: 900,
      arrayItems: 8,
      depth: 3,
    }),
    skillRouting: compactRecordArray(record.skillRouting, 8, DEFAULT_COMPACT_OPTIONS),
    conflicts: compactRecordArray(record.conflicts, 8, DEFAULT_COMPACT_OPTIONS),
    unknownAreas: compactStringArray(record.unknownAreas, 12, 500),
  };
}

function compactKnowledgeRefs(value: unknown) {
  return recordArray(value)
    .slice(0, RUNTIME_INPUT_COMPACTION_LIMITS.knowledgeItems)
    .map((reference) => ({
      ...compactPlainObject(reference, {
        stringChars: RUNTIME_INPUT_COMPACTION_LIMITS.knowledgeTextChars,
        arrayItems: 8,
        depth: 3,
      }),
      snippet: compactMaybeString(reference.snippet, 800),
      content: compactMaybeString(reference.content, RUNTIME_INPUT_COMPACTION_LIMITS.knowledgeTextChars),
    }));
}

function compactRecentMessages(value: unknown) {
  return recordArray(value)
    .slice(-RUNTIME_INPUT_COMPACTION_LIMITS.recentMessages)
    .map((message) => ({
      id: compactMaybeString(message.id, 160),
      role: message.role,
      content: compactMaybeString(message.content, RUNTIME_INPUT_COMPACTION_LIMITS.recentMessageChars),
      createdAt: message.createdAt,
    }));
}

function compactAttachments(value: unknown) {
  return recordArray(value)
    .slice(0, RUNTIME_INPUT_COMPACTION_LIMITS.attachmentItems)
    .map((attachment) => ({
      fileId: compactMaybeString(attachment.fileId, 160),
      fileName: compactMaybeString(attachment.fileName, 240),
      fileType: compactMaybeString(attachment.fileType, 160),
      summary: compactMaybeString(attachment.summary, RUNTIME_INPUT_COMPACTION_LIMITS.attachmentTextChars),
      extractedTextPreview: compactMaybeString(
        attachment.extractedTextPreview,
        RUNTIME_INPUT_COMPACTION_LIMITS.attachmentTextChars,
      ),
    }));
}

function compactSelectedRegion(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return compactPlainObject(record, {
    stringChars: 4_000,
    arrayItems: 12,
    depth: 3,
  });
}

function compactRuntimeObject(input: Record<string, unknown>, overrides: Record<string, unknown>) {
  const result = compactPlainObject(input, DEFAULT_COMPACT_OPTIONS);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function compactRecordArray(value: unknown, maxItems: number, options: CompactOptions) {
  return recordArray(value).slice(0, maxItems).map((record) => compactPlainObject(record, options));
}

function compactStringArray(value: unknown, maxItems: number, maxChars: number) {
  return asArray(value)
    .slice(0, maxItems)
    .map((item) => compactMaybeString(item, maxChars))
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function compactPlainObject(value: Record<string, unknown>, options: CompactOptions, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = compactUnknown(item, options, depth + 1);
  }
  return result;
}

function compactUnknown(value: unknown, options: CompactOptions, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, options.stringChars);
  if (Array.isArray(value)) {
    return value.slice(0, options.arrayItems).map((item) => compactUnknown(item, options, depth + 1));
  }
  const record = asRecord(value);
  if (record) {
    if (depth >= options.depth) return compactLeafObject(record, options.stringChars);
    return compactPlainObject(record, options, depth);
  }
  return value;
}

function compactLeafObject(value: Record<string, unknown>, stringChars: number) {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) {
      result[key] = compactMaybeString(item, stringChars);
    }
  }
  return result;
}

function compactMaybeString(value: unknown, maxChars: number): unknown {
  return typeof value === "string" ? truncateString(value, maxChars) : value;
}

function truncateString(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[已截断 ${value.length - maxChars} 字符]`;
}

function selectIndices(total: number, maxItems: number, selectedIndex: number) {
  const indices = new Set<number>();
  if (selectedIndex >= 0 && selectedIndex < total) indices.add(selectedIndex);
  for (let index = 0; index < total && indices.size < maxItems; index += 1) {
    indices.add(index);
  }
  return Array.from(indices).sort((left, right) => left - right);
}

function prototypePrompt(spec: PrototypeSpec) {
  return [
    "你是 Vibe Coding 的原型代码执行器。",
    "请读取当前目录下的 prototype-spec.json，并只在当前目录生成一个 index.html。",
    "约束：",
    "- 输出必须是单文件完整 HTML，包含 <!doctype html>。",
    "- CSS 和少量原生 JS 必须内联。",
    "- 不得引入远程脚本、远程样式、真实接口、fetch、eval、postMessage、localStorage 或 cookie。",
    "- 每个页面根节点必须带 data-page-id。",
    "- 每个关键组件必须带 data-component-id。",
    "- 文案、页面、组件和交互必须只来自 PrototypeSpec，可做少量评审型补齐。",
    "- 完成后不要输出说明文件，只保存 index.html。",
    "",
    `原型标题：${spec.title}`,
  ].join("\n");
}

function requirementPrompt(input: RequirementRuntimeInput) {
  return [
    "你是 Vibe Coding 的 Codex runtime adapter 执行器。",
    "请读取当前目录下的 runtime-input.json，并只生成 runtime-output.json。",
    "不要修改业务数据库，不要生成其他说明文件，不要执行真实外部副作用。",
    "输出必须是严格 JSON，不要 Markdown，不要代码块。",
    "JSON 顶层结构必须是：",
    "{",
    '  "productDesignDraft": { ...ProductDesignDraft },',
    '  "requirementDocumentDraft": { ...RequirementDocumentDraft },',
    '  "message": "给用户看的简短中文摘要",',
    '  "clarificationQuestions": [],',
    '  "risks": []',
    "}",
    "ProductDesignDraft 必须至少包含：projectId、title、summary、businessGoal、targetUsers、userScenarios、pages、features、backendConfigs、frontendRules、businessRules、stateRules、exceptionScenarios、acceptanceCriteria、assumptions、knowledgeRefs、pendingQuestions、confirmedFacts、createdBy。",
    "RequirementDocumentDraft 必须包含：projectId、title、sections、knowledgeRefs、assumptions、pendingQuestions、validationNotes。",
    "每个 PRD section 必须包含：id、title、type、level、order、content、sourcePaths。",
    "约束：不要把 AI 假设写成用户确认事实；无法确定的信息写入 assumptions 或 pendingQuestions；不要输出真实接口 URL、数据库、SQL、部署方案。",
    "",
    `用户输入：${input.userInput}`,
  ].join("\n");
}

function structuredPrompt(taskType: RuntimeTask["taskType"]) {
  const schemaHint: Partial<Record<RuntimeTask["taskType"], string>> = {
    generate_prototype: "输出必须是 PrototypeSpec JSON：包含 id、projectId、productDesignStateId、productDesignStateVersion、title、targetDevice、styleGuide、pages、navigation、interactions、assumptions、knowledgeRefs。",
    patch_prd: "输出必须是 PatchPlan JSON：包含 patchType、targetNodes、impactScope、operations、regenerationPlan、risks、needUserConfirm、needsUserConfirmation、reason、summary。",
    patch_prototype: "输出必须是 PatchPlan JSON：包含 patchType、targetNodes、impactScope、operations、regenerationPlan、risks、needUserConfirm、needsUserConfirmation、reason、summary。",
    qa_review: "输出必须是 QAProtocolOutput JSON：包含 status、summary、issues。issues 必须包含 id、checkType、severity、title、description、status。",
  };
  return [
    "你是 Vibe Coding 的外部 runtime 执行器。",
    "请读取当前目录下的 runtime-input.json，并只生成 runtime-output.json。",
    "不要修改业务数据库，不要生成其他说明文件，不要执行真实外部副作用。",
    "所有判断和产物必须基于 runtime-input.json 里的产品状态、文档、原型、选区、知识上下文。",
    "输出必须是严格 JSON，不要 Markdown，不要代码块。",
    schemaHint[taskType] ?? "输出必须是严格 JSON。",
    "如果信息不足，用 pending/risks/issues 字段表达，不要编造用户已确认事实。",
  ].join("\n");
}

function normalizeRequirementRuntimeOutput(
  raw: unknown,
  task: RuntimeTask<RequirementRuntimeInput>,
): RequirementRuntimeOutput {
  const parsed = extractRuntimeJson(raw);
  const record = asRecord(parsed);
  const output = firstRecord(
    record?.output,
    record?.data,
    record?.result,
    record?.values,
    record,
  );
  const productSource = firstRecord(
    output?.productDesignDraft,
    output?.productDesignStateDraft,
    output?.productDesignState,
    output?.state,
  );
  if (!productSource) {
    throw new Error("Codex runtime 输出缺少 productDesignDraft");
  }

  const productDesignDraft = normalizeProductDesignDraft(productSource, task);
  const prdSource = firstRecord(
    output?.requirementDocumentDraft,
    output?.prdDraft,
    output?.prdDocumentDraft,
    output?.requirementDocument,
  );
  const requirementDocumentDraft = prdSource
    ? normalizeRequirementDocumentDraft(prdSource, productDesignDraft, task)
    : undefined;

  return {
    productDesignDraft,
    requirementDocumentDraft,
    message: text(output?.message) || text(output?.summary) || undefined,
    clarificationQuestions: recordArray(output?.clarificationQuestions ?? productDesignDraft.pendingQuestions),
    risks: recordArray(output?.risks),
  };
}

function normalizeProductDesignDraft(
  source: Record<string, unknown>,
  task: RuntimeTask<RequirementRuntimeInput>,
): ProductDesignDraft {
  const title = text(source.title) || titleFromUserInput(task.input.userInput);
  return {
    projectId: task.projectId,
    title,
    summary: text(source.summary) || text(source.description) || `根据用户输入生成：${task.input.userInput}`,
    background: optionalText(source.background),
    businessGoal: text(source.businessGoal) || text(source.goal) || "待补充业务目标",
    targetUsers: recordArray(source.targetUsers),
    userScenarios: recordArray(source.userScenarios ?? source.scenarios),
    pages: recordArray(source.pages),
    features: recordArray(source.features),
    backendConfigs: recordArray(source.backendConfigs),
    frontendRules: recordArray(source.frontendRules),
    businessRules: recordArray(source.businessRules),
    stateRules: recordArray(source.stateRules),
    exceptionScenarios: recordArray(source.exceptionScenarios),
    acceptanceCriteria: recordArray(source.acceptanceCriteria),
    prototypeOutline: asRecord(source.prototypeOutline) ?? undefined,
    assumptions: recordArray(source.assumptions),
    knowledgeRefs: recordArray(source.knowledgeRefs),
    pendingQuestions: recordArray(source.pendingQuestions ?? source.clarificationQuestions),
    confirmedFacts: recordArray(source.confirmedFacts),
    createdBy: task.userId ?? "codex",
    updatedBy: task.userId,
  };
}

function normalizeRequirementDocumentDraft(
  source: Record<string, unknown>,
  state: ProductDesignDraft,
  task: RuntimeTask<RequirementRuntimeInput>,
): RequirementDocumentDraft {
  const sections = recordArray(source.sections)
    .map((section, index) => normalizeSection(section, index))
    .filter((section): section is RequirementDocSection => Boolean(section));
  return {
    projectId: task.projectId,
    title: text(source.title) || `${state.title} PRD`,
    sections: sections.length ? sections : fallbackSectionsFromState(state),
    knowledgeRefs: recordArray(source.knowledgeRefs ?? state.knowledgeRefs),
    assumptions: normalizeAssumptions(source.assumptions),
    pendingQuestions: normalizePendingQuestions(source.pendingQuestions ?? state.pendingQuestions),
    validationNotes: stringArray(source.validationNotes).length
      ? stringArray(source.validationNotes)
      : ["PRD 由 Codex runtime 生成，已通过 Vibe 产品协议落库。"],
  };
}

function normalizeSection(section: Record<string, unknown>, index: number): RequirementDocSection | null {
  const content = text(section.content);
  if (!content) return null;
  return {
    id: safeId(text(section.id) || `section_${index + 1}`),
    title: text(section.title) || `章节 ${index + 1}`,
    type: normalizeSectionType(text(section.type)),
    level: normalizeLevel(section.level),
    order: numberValue(section.order) ?? index + 1,
    content,
    blocks: recordArray(section.blocks) as RequirementDocSection["blocks"],
    sourcePaths: stringArray(section.sourcePaths).length ? stringArray(section.sourcePaths) : ["runtime.codex"],
    tags: stringArray(section.tags) as RequirementDocSection["tags"],
  };
}

function fallbackSectionsFromState(state: ProductDesignDraft): RequirementDocSection[] {
  return [
    {
      id: "overview",
      title: "1. 需求概述",
      type: "overview",
      level: 1,
      order: 1,
      content: state.summary || `本需求围绕“${state.title}”生成产品状态和 PRD。`,
      sourcePaths: ["summary"],
    },
    {
      id: "business_goal",
      title: "2. 业务目标",
      type: "business_goal",
      level: 1,
      order: 2,
      content: state.businessGoal,
      sourcePaths: ["businessGoal"],
    },
  ];
}

function normalizeAssumptions(value: unknown): AssumptionReference[] {
  return recordArray(value).map((item, index) => ({
    assumptionId: text(item.assumptionId) || text(item.id) || `assumption_${index + 1}`,
    content: text(item.content) || text(item.description) || text(item.title) || "待确认假设",
    relatedSectionIds: stringArray(item.relatedSectionIds),
    status: normalizeAssumptionStatus(item.status),
  }));
}

function normalizePendingQuestions(value: unknown): ClarificationQuestionReference[] {
  return recordArray(value).map((item, index) => ({
    questionId: text(item.questionId) || text(item.id) || `question_${index + 1}`,
    question: text(item.question) || text(item.title) || text(item.content) || "请补充该需求细节。",
    reason: text(item.reason) || "该信息会影响后续 PRD 或原型生成。",
    relatedSectionIds: stringArray(item.relatedSectionIds),
    status: normalizeQuestionStatus(item.status),
  }));
}

function normalizeAssumptionStatus(value: unknown): AssumptionReference["status"] {
  return value === "confirmed" || value === "rejected" ? value : "pending";
}

function normalizeQuestionStatus(value: unknown): ClarificationQuestionReference["status"] {
  return value === "answered" || value === "skipped" ? value : "pending";
}

function extractRuntimeJson(raw: unknown): unknown {
  const record = asRecord(raw);
  if (record) {
    const direct = firstRecord(record.output, record.data, record.result);
    if (direct) return record;
    const messages = asArray(record.messages ?? record.values);
    const finalMessage = [...messages].reverse()
      .map((item) => text(asRecord(item)?.content ?? item))
      .find(Boolean);
    const parsed = parseJsonText(finalMessage ?? "");
    if (parsed) return parsed;
  }
  if (typeof raw === "string") return parseJsonText(raw) ?? raw;
  return raw;
}

function event(
  task: RuntimeTask<unknown>,
  type: RuntimeEvent["type"],
  content: string,
  payload?: unknown,
): RuntimeEvent {
  return {
    id: randomUUID(),
    provider: "codex",
    taskId: task.id,
    runId: task.runId,
    type,
    content,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function parseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseJsonText(text: string) {
  const textValue = text.trim();
  if (!textValue) return undefined;
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    const fenced = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return parseJsonText(fenced);
    const first = textValue.indexOf("{");
    const last = textValue.lastIndexOf("}");
    if (first >= 0 && last > first) return parseJsonText(textValue.slice(first, last + 1));
    return undefined;
  }
}

function isExpectedOutputReady(content: string, kind: CodexRunOptions["outputKind"]) {
  const textValue = content.trim();
  if (!textValue) return false;
  if (kind === "json") return Boolean(parseJsonText(textValue));
  const lower = textValue.slice(0, 500).toLowerCase();
  return textValue.length >= 200 && (lower.includes("<!doctype html") || lower.includes("<html"));
}

function firstRecord(...values: unknown[]) {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
}

function stringArray(value: unknown): string[] {
  return asArray(value).map(text).filter(Boolean);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
  const result = text(value);
  return result || undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLevel(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function normalizeSectionType(value: string): RequirementDocSection["type"] {
  const allowed: RequirementDocSection["type"][] = [
    "overview",
    "background",
    "business_goal",
    "target_users",
    "user_scenarios",
    "scope",
    "page_requirements",
    "backend_configs",
    "frontend_rules",
    "business_rules",
    "state_rules",
    "exception_scenarios",
    "acceptance_criteria",
    "assumptions",
    "knowledge_refs",
    "pending_questions",
    "appendix",
  ];
  return allowed.includes(value as RequirementDocSection["type"])
    ? value as RequirementDocSection["type"]
    : "appendix";
}

function titleFromUserInput(userInput: string) {
  const compactText = compact(userInput);
  return compactText ? compactText.slice(0, 30) : "产品需求方案";
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 64) || "section";
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function eventTypeFromCodex(value: Record<string, unknown>): RuntimeEvent["type"] {
  const type = typeof value.type === "string" ? value.type : "";
  if (type.includes("command") || type.includes("tool")) return "runtime_tool_called";
  if (type.includes("completed")) return "runtime_step_started";
  if (type.includes("failed") || type === "error") return "runtime_warning";
  return "runtime_message";
}

function summaryFromCodex(value: Record<string, unknown>) {
  const type = typeof value.type === "string" ? value.type : "codex_event";
  const item = value.item && typeof value.item === "object" ? value.item as Record<string, unknown> : undefined;
  const text = typeof item?.text === "string" ? item.text : undefined;
  return text ? text.slice(0, 500) : `Codex event: ${type}`;
}
