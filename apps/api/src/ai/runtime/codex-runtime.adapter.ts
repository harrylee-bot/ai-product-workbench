import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { ExternalRuntimeConfigService } from "./external-runtime-config.service";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeResult,
  RuntimeTask,
} from "./external-runtime.types";
import type { PrototypeArtifactDraft, PrototypeSpec } from "../ai-vibe.types";

@Injectable()
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly provider = "codex" as const;

  constructor(private readonly config: ExternalRuntimeConfigService) {}

  async runTask<TInput, TOutput>(task: RuntimeTask<TInput>): Promise<RuntimeResult<TOutput>> {
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

    const rawEvents = await this.runCodex(workspace, promptPath, task, events);
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
  ) {
    const prompt = await readFile(promptPath, "utf8");
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--cd",
      workspace,
      prompt,
    ];
    events.push(event(task, "runtime_tool_called", "正在调用 Codex CLI 生成 HTML。", {
      command: this.config.codexCommand(),
      args: args.slice(0, -1),
      cwd: workspace,
    }));

    const child = spawn(this.config.codexCommand(), args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rawEvents: unknown[] = [];
    const stderrChunks: string[] = [];
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const parsed = parseJsonLine(line);
      rawEvents.push(parsed ?? line);
      if (parsed) {
        events.push(event(task, eventTypeFromCodex(parsed), summaryFromCodex(parsed), parsed));
      }
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    if (exitCode !== 0) {
      const stderr = stderrChunks.join("").replace(/\s+/g, " ").trim();
      throw new Error(`Codex runtime 执行失败（exit ${exitCode ?? "unknown"}）${stderr ? `：${stderr}` : ""}`);
    }

    return rawEvents;
  }

  private async runStructuredJson(task: RuntimeTask<unknown>): Promise<RuntimeResult<unknown>> {
    const workspace = await this.createWorkspace(task);
    const inputPath = join(workspace, "runtime-input.json");
    const promptPath = join(workspace, "prompt.md");
    const outputPath = join(workspace, "runtime-output.json");
    const events: RuntimeEvent[] = [
      event(task, "runtime_task_started", `Codex runtime 已创建 ${task.taskType} 任务。`),
    ];

    await writeFile(inputPath, JSON.stringify(task.input, null, 2), "utf8");
    await writeFile(promptPath, structuredPrompt(task.taskType), "utf8");
    events.push(event(task, "runtime_file_changed", `已写入 ${basename(inputPath)} 和 ${basename(promptPath)}。`, {
      files: [inputPath, promptPath],
    }));

    const rawEvents = await this.runCodex(workspace, promptPath, task, events);
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
