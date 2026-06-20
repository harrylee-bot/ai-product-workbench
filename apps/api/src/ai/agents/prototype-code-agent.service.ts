import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { PrototypeArtifact, PrototypeSpec } from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrototypeCodeInput = {
  prototypeSpec: PrototypeSpec;
  mode: "single_html";
};

@Injectable()
export class PrototypeCodeAgentService extends BaseAgentService<PrototypeCodeInput, PrototypeArtifact> {
  readonly agentName = AgentName.prototype_code_agent;
  readonly taskType = ModelTaskType.prototype_code_generation;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrototypeCodeInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Prototype Code Agent。输出 PrototypeArtifact JSON，其中 html 必须是单文件 HTML，内联 CSS/JS，不依赖后端。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrototypeCodeInput): PrototypeArtifact {
    const pageName = String(input.prototypeSpec.pages[0]?.name ?? "产品原型");
    const goal = String(input.prototypeSpec.components[0]?.text ?? "核心产品流程");
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageName)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f6f7f8; color: #111827; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; letter-spacing: 0; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 1px solid #e5e7eb; padding-bottom: 20px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.25; }
    p { color: #52605a; line-height: 1.7; }
    .grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 18px; margin-top: 22px; }
    .panel { border: 1px solid #e2e8f0; border-radius: 8px; background: white; padding: 18px; box-shadow: 0 8px 24px rgba(15,23,42,.06); }
    .states { display: grid; gap: 10px; margin-top: 14px; }
    .state { border-radius: 8px; background: #f8fafc; padding: 12px; color: #334155; }
    button { height: 42px; border: 0; border-radius: 8px; background: #111827; color: white; padding: 0 18px; font-weight: 700; cursor: pointer; }
    button[disabled] { background: #cbd5e1; cursor: not-allowed; }
    .toast { display: none; margin-top: 12px; border-radius: 8px; background: #ecfdf5; color: #047857; padding: 10px 12px; }
    .toast.show { display: block; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } header { display: block; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(pageName)}</h1>
        <p>${escapeHtml(goal)}</p>
      </div>
      <button id="primaryAction">执行核心操作</button>
    </header>
    <section class="grid">
      <div class="panel">
        <strong>关键状态</strong>
        <div class="states">
          ${input.prototypeSpec.states
            .map((state) => `<div class="state">${escapeHtml(String(state.name ?? state.id ?? "状态"))}</div>`)
            .join("")}
        </div>
        <div id="toast" class="toast">操作成功，页面状态已更新。</div>
      </div>
      <div class="panel">
        <strong>评审说明</strong>
        <p>该原型由 PrototypeSpec 渲染，用于业务评审和演示，不作为生产代码。</p>
        <p>组件、状态和交互均保留 sourceStateRef，便于后续局部修改和 QA 校验。</p>
      </div>
    </section>
  </main>
  <script>
    document.getElementById("primaryAction").addEventListener("click", function () {
      document.getElementById("toast").classList.toggle("show");
    });
  </script>
</body>
</html>`;

    return {
      id: randomUUID(),
      projectId: input.prototypeSpec.projectId,
      html,
      entryFile: "index.html",
      assets: [],
    };
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
