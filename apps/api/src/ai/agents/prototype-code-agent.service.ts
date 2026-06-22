import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { agentSystemPrompt } from "../agent-charter";
import { agentSkillSystemPromptFromKnowledgeRefs } from "../agent-skill-instructions";
import type { PrototypeArtifactDraft, PrototypeComponentSpec, PrototypePageSpec, PrototypeSpec } from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrototypeCodeInput = {
  prototypeSpec: PrototypeSpec;
  mode: "single_html";
  generatedByRunId?: string;
};

@Injectable()
export class PrototypeCodeAgentService extends BaseAgentService<PrototypeCodeInput, PrototypeArtifactDraft> {
  readonly agentName = AgentName.prototype_code_agent;
  readonly taskType = ModelTaskType.prototype_code_generation;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrototypeCodeInput) {
    return [
      {
        role: "system" as const,
        content: [
          agentSystemPrompt(
            this.agentName,
            "你是 Prototype Code Agent。只能根据 PrototypeSpec 输出 PrototypeArtifactDraft JSON。htmlContent 必须是单文件完整 HTML，内联 CSS/少量原生 JS，不访问真实接口，不引入远程脚本，关键元素必须带 data-page-id/data-component-id。",
          ),
          agentSkillSystemPromptFromKnowledgeRefs(this.agentName, this.taskType, input.prototypeSpec.knowledgeRefs),
        ].filter(Boolean).join("\n\n"),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrototypeCodeInput): PrototypeArtifactDraft {
    const html = renderHtmlFromPrototypeSpec(input.prototypeSpec);
    return {
      id: randomUUID(),
      projectId: input.prototypeSpec.projectId,
      prototypeSpecId: input.prototypeSpec.id,
      productDesignStateId: input.prototypeSpec.productDesignStateId,
      productDesignStateVersion: input.prototypeSpec.productDesignStateVersion,
      title: input.prototypeSpec.title,
      htmlContent: html,
      html,
      entryFilePath: "index.html",
      entryFile: "index.html",
      targetDevice: input.prototypeSpec.targetDevice,
      pageCount: input.prototypeSpec.pages.length || 1,
      generatedByRunId: input.generatedByRunId,
      assets: [],
    };
  }

  protected normalize(output: PrototypeArtifactDraft, input: PrototypeCodeInput): PrototypeArtifactDraft {
    const fallback = this.fallback(input);
    const html = safeText(output.htmlContent) || safeText(output.html) || fallback.htmlContent;
    return {
      id: safeText(output.id) || fallback.id,
      projectId: input.prototypeSpec.projectId,
      prototypeSpecId: input.prototypeSpec.id,
      productDesignStateId: input.prototypeSpec.productDesignStateId,
      productDesignStateVersion: input.prototypeSpec.productDesignStateVersion,
      title: safeText(output.title) || fallback.title,
      status: output.status,
      htmlContent: ensureCompleteHtml(html ?? ""),
      html: ensureCompleteHtml(html ?? ""),
      entryFilePath: safeText(output.entryFilePath) || safeText(output.entryFile) || "index.html",
      entryFile: safeText(output.entryFilePath) || safeText(output.entryFile) || "index.html",
      previewUrl: safeText(output.previewUrl) || undefined,
      targetDevice: output.targetDevice === "desktop" || output.targetDevice === "mobile" || output.targetDevice === "both"
        ? output.targetDevice
        : input.prototypeSpec.targetDevice,
      pageCount: typeof output.pageCount === "number" && output.pageCount > 0
        ? output.pageCount
        : input.prototypeSpec.pages.length || 1,
      generatedByRunId: input.generatedByRunId ?? output.generatedByRunId,
      errorMessage: safeText(output.errorMessage) || undefined,
      assets: Array.isArray(output.assets) ? output.assets : [],
    };
  }
}

export function renderHtmlFromPrototypeSpec(spec: PrototypeSpec) {
  const firstPageId = spec.pages[0]?.id ?? "page_main";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.title)}</title>
  <style>
    * { box-sizing: border-box; }
    :root { --ink: #111827; --muted: #5b6472; --line: #e5e7eb; --bg: ${escapeHtml(spec.styleGuide.backgroundColor ?? "#f6f7f8")}; --card: #fff; --primary: ${escapeHtml(spec.styleGuide.primaryColor ?? "#111827")}; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-family: ${escapeHtml(spec.styleGuide.typography?.fontFamily ?? "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, sans-serif")}; letter-spacing: 0; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    nav { border-right: 1px solid var(--line); background: rgba(255,255,255,.78); padding: 22px 16px; }
    nav strong { display: block; margin-bottom: 14px; font-size: 14px; }
    nav button { width: 100%; margin-bottom: 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; padding: 10px 12px; text-align: left; color: var(--muted); cursor: pointer; }
    nav button.active { border-color: var(--line); background: #fff; color: var(--ink); font-weight: 700; }
    main { min-width: 0; padding: 28px; }
    .page { display: none; max-width: 1120px; margin: 0 auto; }
    .page.active { display: block; }
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.25; }
    p { color: var(--muted); line-height: 1.7; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .component { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 16px; box-shadow: 0 8px 22px rgba(15,23,42,.05); }
    .component strong { display: block; margin-bottom: 8px; font-size: 14px; }
    .primary-action { height: 42px; border: 0; border-radius: 8px; background: var(--primary); color: white; padding: 0 18px; font-weight: 700; cursor: pointer; }
    .list-item { border-radius: 8px; background: #f8fafc; padding: 10px 12px; color: #334155; margin-top: 8px; }
    .toast { position: fixed; right: 24px; bottom: 24px; display: none; max-width: 320px; border: 1px solid #bbf7d0; border-radius: 8px; background: #f0fdf4; color: #047857; padding: 12px 14px; box-shadow: 0 12px 30px rgba(15,23,42,.12); }
    .toast.show { display: block; }
    @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--line); } .grid { grid-template-columns: 1fr; } main { padding: 18px; } .page-header { display: block; } }
  </style>
</head>
<body>
  <div class="shell">
    <nav aria-label="原型页面导航">
      <strong>${escapeHtml(spec.title)}</strong>
      ${spec.pages.map((page) => `<button type="button" data-nav-target="${escapeHtml(page.id)}" class="${page.id === firstPageId ? "active" : ""}">${escapeHtml(page.name)}</button>`).join("")}
    </nav>
    <main>
      ${spec.pages.map((page) => renderPage(page, firstPageId)).join("")}
    </main>
  </div>
  <div id="prototypeToast" class="toast">操作成功，页面状态已更新。</div>
  <script>
    (function () {
      var toast = document.getElementById("prototypeToast");
      document.querySelectorAll("[data-nav-target]").forEach(function (button) {
        button.addEventListener("click", function () {
          var target = button.getAttribute("data-nav-target");
          document.querySelectorAll("[data-nav-target]").forEach(function (item) { item.classList.remove("active"); });
          document.querySelectorAll("[data-page-id]").forEach(function (page) { page.classList.remove("active"); });
          button.classList.add("active");
          var page = document.querySelector('[data-page-id="' + target + '"]');
          if (page) page.classList.add("active");
        });
      });
      document.querySelectorAll("[data-action='show-toast']").forEach(function (button) {
        button.addEventListener("click", function () {
          toast.textContent = button.getAttribute("data-result") || "操作成功，页面状态已更新。";
          toast.classList.add("show");
          window.setTimeout(function () { toast.classList.remove("show"); }, 2200);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderPage(page: PrototypePageSpec, firstPageId: string) {
  const header = page.components.find((component) => component.type === "header");
  const rest = page.components.filter((component) => component.type !== "header");
  return `<section class="page ${page.id === firstPageId ? "active" : ""}" data-page-id="${escapeHtml(page.id)}">
    <div class="page-header" data-page-id="${escapeHtml(page.id)}" data-component-id="${escapeHtml(header?.id ?? `${page.id}_header`)}">
      <div>
        <h1>${escapeHtml(header?.content ?? page.name)}</h1>
        <p>${escapeHtml(header?.description ?? page.description ?? "用于产品评审的 HTML 原型页面。")}</p>
      </div>
      ${renderPrimaryButton(page)}
    </div>
    <div class="grid">
      ${rest.map((component) => renderComponent(page.id, component)).join("")}
    </div>
  </section>`;
}

function renderPrimaryButton(page: PrototypePageSpec) {
  const action = page.components.find((component) => component.type === "button");
  if (!action) return "";
  return `<button class="primary-action" type="button" data-action="show-toast" data-page-id="${escapeHtml(page.id)}" data-component-id="${escapeHtml(action.id)}" data-result="${escapeHtml(action.content ?? "操作成功，页面状态已更新。")}">${escapeHtml(action.content ?? action.name)}</button>`;
}

function renderComponent(pageId: string, component: PrototypeComponentSpec) {
  if (component.type === "button") return "";
  const content = component.content || component.description || "待补充内容";
  if (component.type === "list") {
    const items = content.split(/\/|,|，|\n/).map((item) => item.trim()).filter(Boolean);
    return `<article class="component" data-page-id="${escapeHtml(pageId)}" data-component-id="${escapeHtml(component.id)}">
      <strong>${escapeHtml(component.name)}</strong>
      ${items.length ? items.map((item) => `<div class="list-item">${escapeHtml(item)}</div>`).join("") : `<p>${escapeHtml(content)}</p>`}
    </article>`;
  }
  return `<article class="component" data-page-id="${escapeHtml(pageId)}" data-component-id="${escapeHtml(component.id)}">
    <strong>${escapeHtml(component.name)}</strong>
    <p>${escapeHtml(content)}</p>
  </article>`;
}

function ensureCompleteHtml(value: string) {
  return /^<!doctype html>/i.test(value.trim()) ? value : `<!doctype html>\n${value}`;
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
