"use client";
import { useQuery } from "@tanstack/react-query";
import type {
  PrototypePlan,
  PrototypePlanInput,
} from "@workbench/workbench-contracts";
import { useWorkbenchPrototypeV2Api } from "@/lib/studio/api";

export function PlanInputSummary({
  projectId,
  plan,
  canEdit,
  onAdjust,
}: {
  projectId: string;
  plan: PrototypePlan;
  canEdit: boolean;
  onAdjust: (input: PrototypePlanInput) => void;
}) {
  const api = useWorkbenchPrototypeV2Api();
  const query = useQuery({
    queryKey: ["studio", "plan-input", projectId, plan.id, plan.revision],
    queryFn: () => api.getPlanInput(projectId, plan.id),
  });
  if (query.isPending) return <p role="status">正在读取固定输入…</p>;
  if (!query.data)
    return (
      <p role="alert">
        完整输入读取失败
        <button onClick={() => void query.refetch()}>重试读取</button>
      </p>
    );
  const { request, snapshot } = query.data;
  const design = request.designStyle;
  return (
    <section className="studio-plan-input" aria-label="完整固定输入">
      <dl className="visual-input-summary">
        <dt>输出</dt>
        <dd>
          {request.requestedArtifactKinds
            .map(
              (kind) =>
                ({
                  prd: "需求文档",
                  prototype: "交互原型",
                  document: "文档",
                  image: "图片",
                  code: "代码",
                  data: "数据",
                })[kind] ?? kind,
            )
            .join("＋")}
        </dd>
        <dt>模型</dt>
        <dd>{request.modelId}</dd>
        <dt>终端</dt>
        <dd>{request.targetSurface === "web" ? "Web" : "App"}</dd>
        <dt>设计</dt>
        <dd>
          {design.kind === "automatic"
            ? "自动设计"
            : ((snapshot?.designStyle.snapshot &&
                ("title" in snapshot.designStyle.snapshot
                  ? snapshot.designStyle.snapshot.title
                  : snapshot.designStyle.snapshot.label)) ??
              (design.kind === "preset"
                ? `${design.presetId} · ${design.version}`
                : design.artifactVersionId))}
        </dd>
        <dt>知识</dt>
        <dd>
          {snapshot?.knowledgeReleaseId ?? "尚无可用知识版本，生成前需补齐"}
        </dd>
        <dt>来源</dt>
        <dd>
          {plan.sourceRevisionId
            ? `源版本 ${plan.sourceRevisionId}`
            : "新建计划"}
        </dd>
      </dl>
      <h3>固定引用资料</h3>
      {!request.sourceIds.length ? (
        <p>未引用附件或导入资料</p>
      ) : (
        <ul>
          {request.sourceIds.map((id) => {
            const source = snapshot?.sources.find(
              (item) => item.sourceId === id,
            );
            return (
              <li key={id}>
                {source?.label ?? id}
                {source
                  ? ` · 快照 ${source.snapshot.sourceRevision} · ${source.snapshot.blobs.length} 个文件`
                  : " · 尚未固定"}
              </li>
            );
          })}
        </ul>
      )}
      {request.artifactTargets.length > 0 && (
        <>
          <h3>固定产物版本</h3>
          <ul>
            {request.artifactTargets.map((target) => (
              <li key={target.artifactVersionId}>
                {target.artifactVersionId}
                {target.screenIds.length
                  ? ` · 页面 ${target.screenIds.join("、")}`
                  : " · 完整产物"}
              </li>
            ))}
          </ul>
        </>
      )}
      {request.generationIntent && (
        <p>
          生成意图：
          {
            {
              "followup-design": "衍生设计",
              "interactive-prototype": "交互原型",
              "prd-prototype": "PRD 生成单屏界面",
              "prd-flow": "PRD 生成多屏流程",
            }[request.generationIntent]
          }
        </p>
      )}
      {request.prdScreenPlan && (
        <p>
          固定页面范围：
          {request.prdScreenPlan.map((screen) => screen.title).join(" → ")}
        </p>
      )}
      {!snapshot && (
        <p role="status">此记录尚无草稿快照，请调整并保存完整输入后再审批。</p>
      )}
      <details>
        <summary>输入核对</summary>
        <p className="visual-prose">{request.prompt}</p>
        <small>输入校验：{query.data.sha256}</small>
      </details>
      {plan.status === "draft" && (
        <button disabled={!canEdit} onClick={() => onAdjust(query.data!)}>
          调整完整输入
        </button>
      )}
    </section>
  );
}
