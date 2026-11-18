"use client";

import { useId, useRef, useState } from "react";
import type {
  RequirementDiscussionView,
  RequirementEvidenceView,
  RequirementFactView,
} from "@/lib/studio/requirements-view";
import { requirementConfirmationBlock } from "@/lib/studio/requirements-view";

const provenance = {
  user: "用户已明确",
  knowledge: "知识依据",
  suggestion: "建议，确认后采用",
  analysis: "需求梳理，待确认",
};
const scopes = {
  platform: "平台共性",
  template: "模板规则",
  regional: "区域案例",
  prototype: "原型表现",
  uncertain: "适用范围待核对",
};
const knowledgeLabels = {
  available: "已读取授权知识依据",
  missing: "知识依据不足，未找到不代表平台没有此能力",
  conflict: "知识来源存在差异，请核对各自适用范围",
  restricted: "部分资料无法访问，需要有权限的依据",
  unavailable: "知识检索暂时不可用，请稍后重试本次分析。",
  "source-changed": "选定资料状态已变化，请重新核对资料后再分析。",
  searching: "正在核对平台能力依据…",
  "not-provided": "当前尚未返回可核对的知识引用",
};

function FactList({
  items,
  evidence,
}: {
  items: readonly RequirementFactView[];
  evidence: ReadonlyMap<string, RequirementEvidenceView>;
}) {
  if (!items.length)
    return <p className="studio-muted">当前没有列入此类的改动。</p>;
  return (
    <ul className="studio-requirement-facts">
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.text}</p>
          <span className="studio-requirement-origin" data-origin={item.origin}>
            {provenance[item.origin]}
          </span>
          {item.evidenceIds.map((id) => {
            const source = evidence.get(id);
            return source ? (
              <Evidence key={id} source={source} />
            ) : (
              <span key={id} className="studio-muted">
                该条依据暂不可查看
              </span>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
function Evidence({ source }: { source: RequirementEvidenceView }) {
  return (
    <details className="studio-requirement-evidence">
      <summary>
        {source.title} · {scopes[source.scope]}
      </summary>
      <p>{source.location}</p>
      <p>
        知识发布 {source.release} · 版本 {source.version}
      </p>
      <blockquote>{source.quote}</blockquote>
    </details>
  );
}
function TextList({ items }: { items: readonly string[] }) {
  return items.length ? (
    <ul>
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  ) : (
    <p className="studio-muted">尚未明确。</p>
  );
}

/** Controlled UI; no model calls, local readiness scoring or generation side effects.
 * Backend readiness and fixed input identities are supplied by the adapter. */
type RequirementDiscussionProps = {
  view: RequirementDiscussionView;
  canEdit: boolean;
  dirtyInput: boolean;
  onConfirm: (review: {
    id: string;
    version: number;
    acceptPlatformChanges: boolean;
  }) => Promise<void>;
  onContinue: () => void;
  onRecoverConfirmation: () => Promise<void>;
  onRetryGeneration?: () => Promise<void>;
  onLoadEarlier: () => Promise<void>;
};
export function RequirementDiscussion(props: RequirementDiscussionProps) {
  return <DiscussionBody key={props.view.scopeKey} {...props} />;
}
function DiscussionBody({
  view,
  canEdit,
  dirtyInput,
  onConfirm,
  onContinue,
  onRecoverConfirmation,
  onRetryGeneration,
  onLoadEarlier,
}: RequirementDiscussionProps) {
  const heading = useId(),
    blockId = useId();
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [platformConsent, setPlatformConsent] = useState("");
  const [confirmed, setConfirmed] = useState("");
  const pending = useRef(false);
  const latestScope = useRef(view.scopeKey);
  latestScope.current = view.scopeKey;
  const evidence = new Map(view.evidence.map((item) => [item.id, item]));
  const reviewKey = view.review
    ? `${view.review.id}:${view.review.version}`
    : "";
  const block =
    requirementConfirmationBlock(view, { canEdit, dirtyInput }) ||
    (view.review?.platformChanges.length && platformConsent !== reviewKey
      ? "平台级改造需明确同意后才能纳入生成。"
      : undefined) ||
    (confirmed === reviewKey && reviewKey
      ? "已提交确认，正在等待最新生成状态。"
      : undefined);
  const perform = async (label: string, action: () => Promise<void>) => {
    if (pending.current) return;
    const scope = view.scopeKey;
    pending.current = true;
    setOperation(label);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (latestScope.current === scope)
        setError(
          cause instanceof Error
            ? cause.message
            : "操作未完成，请核对最新状态后重试。",
        );
    } finally {
      pending.current = false;
      if (latestScope.current === scope) setOperation("");
    }
  };
  const review = view.review;
  return (
    <section
      className="studio-requirement-discussion"
      aria-labelledby={heading}
    >
      <header>
        <div>
          <h2 id={heading}>需求交流</h2>
          <p className="studio-muted">{view.contextLabel}</p>
        </div>
        <span className="studio-requirement-state">
          {view.status === "analyzing"
            ? "正在梳理"
            : view.status === "ready"
              ? "待确认改动"
              : view.generationStarting
                ? "已确认，等待生成"
                : view.status === "generating"
                  ? "生成中，可继续讨论"
                  : "梳理本次增量"}
        </span>
      </header>
      <p className="studio-requirement-knowledge">
        {knowledgeLabels[view.knowledgeStatus]}
      </p>
      {view.currentGeneration && (
        <aside className="studio-requirement-current" aria-label="本次生成基线">
          <strong>{view.currentGeneration.label}</strong>
          <p>已确认基线：{view.currentGeneration.baseline}</p>
          <p>后续消息不会修改本次生成；新的改动需重新梳理和确认。</p>
        </aside>
      )}
      <details
        className="studio-requirement-history"
        open={view.messages.length > 0 && !review}
      >
        <summary>本次需求讨论 · {view.messages.length} 条</summary>
        {view.hasEarlierMessages && (
          <button
            type="button"
            disabled={!!operation}
            onClick={() => void perform("读取更多记录", onLoadEarlier)}
          >
            加载更多交流
          </button>
        )}
        <ol>
          {view.messages.map((message) => (
            <li key={message.id} data-speaker={message.speaker}>
              <strong>
                {message.speaker === "user" ? "用户" : "需求助手"}
                {message.afterConfirmation ? " · 后续讨论，未纳入本次生成" : ""}
              </strong>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      </details>
      {view.questions.length > 0 && (
        <section
          className="studio-requirement-questions"
          aria-label="待澄清的问题"
        >
          <h3>先核对这些问题</h3>
          <ul>
            {view.questions.map((question) => (
              <li key={question.id}>
                <strong>{question.question}</strong>
                <p>{question.reason}</p>
                <span>
                  {question.blocking
                    ? "影响关键规则，需先解决"
                    : "建议补充，可继续讨论"}
                </span>
                {question.evidenceIds.map((id) =>
                  evidence.get(id) ? (
                    <Evidence key={id} source={evidence.get(id)!} />
                  ) : (
                    <span key={id}>依据暂不可查看</span>
                  ),
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {review ? (
        <article
          className="studio-requirement-review"
          aria-label="本次改动确认"
        >
          <h3>
            本次改动确认 <span>第 {review.version} 版</span>
          </h3>
          <p className="studio-requirement-goal">{review.goal}</p>
          <dl className="studio-requirement-meta">
            <div>
              <dt>目标平台</dt>
              <dd>{review.platform || "待明确"}</dd>
            </div>
            <div>
              <dt>业务模块</dt>
              <dd>{review.modules.join("、") || "待明确"}</dd>
            </div>
            <div>
              <dt>使用角色</dt>
              <dd>
                {review.roles.join("、") ||
                  (review.rolesUnchanged ? "沿用现有角色及权限边界" : "待明确")}
              </dd>
            </div>
            <div>
              <dt>交付范围</dt>
              <dd>
                {review.outputKinds
                  .map((kind) => (kind === "prd" ? "需求文档" : "原型"))
                  .join("＋")}{" "}
                · {review.target}
              </dd>
            </div>
          </dl>
          <section>
            <h4>已有能力与依据</h4>
            <FactList items={review.existing} evidence={evidence} />
          </section>
          <div className="studio-requirement-columns">
            <section>
              <h4>复用</h4>
              <FactList items={review.reuse} evidence={evidence} />
            </section>
            <section>
              <h4>新增与局部修改</h4>
              <FactList items={review.changes} evidence={evidence} />
            </section>
          </div>
          <details>
            <summary>影响页面、流程及保持的范围</summary>
            <h4>影响页面</h4>
            {review.pagesUnaffected ? (
              <p className="studio-muted">本次不涉及页面改动。</p>
            ) : (
              <TextList items={review.pages} />
            )}
            <h4>影响流程</h4>
            {review.flowsUnaffected ? (
              <p className="studio-muted">本次不涉及流程改动。</p>
            ) : (
              <TextList items={review.flows} />
            )}
            <h4>保持已有能力</h4>
            <TextList items={review.preserved} />
            <h4>设计约束</h4>
            <TextList items={review.design} />
          </details>
          {review.assumptions.length > 0 && (
            <section>
              <h4>本次建议假设</h4>
              <p>这些是建议，尚未作为用户已明确的事实。可以在下方继续修改。</p>
              <FactList items={review.assumptions} evidence={evidence} />
            </section>
          )}
          {review.platformChanges.length > 0 && (
            <section
              className="studio-requirement-platform"
              aria-label="平台级改造"
            >
              <h4>单独核对的平台级改造与成本</h4>
              <TextList items={review.platformChanges} />
              <p>未明确确认的项目不能纳入本次生成。</p>
              <label>
                <input
                  type="checkbox"
                  checked={platformConsent === reviewKey}
                  disabled={!canEdit || !view.reviewCurrent || dirtyInput}
                  onChange={(event) =>
                    setPlatformConsent(event.target.checked ? reviewKey : "")
                  }
                />
                我同意将以上平台级改造纳入本次范围
              </label>
            </section>
          )}
          <footer>
            <p id={blockId}>
              {block || "确认后将固定本次需求和引用版本，按以上范围开始生成。"}
            </p>
            <div>
              <button type="button" disabled={!canEdit} onClick={onContinue}>
                继续调整需求
              </button>
              <button
                type="button"
                className="studio-requirement-confirm"
                aria-describedby={blockId}
                disabled={!!block || !!operation}
                onClick={() => {
                  if (!block)
                    void perform("正在确认需求", async () => {
                      await onConfirm({
                        id: review.id,
                        version: review.version,
                        acceptPlatformChanges:
                          !!review.platformChanges.length &&
                          platformConsent === reviewKey,
                      });
                      setConfirmed(reviewKey);
                    });
                }}
              >
                确认需求并生成
              </button>
            </div>
          </footer>
        </article>
      ) : (
        view.status !== "analyzing" && (
          <p className="studio-muted">
            可以先交流业务目标或询问平台能力，明确关键范围后再确认生成。
          </p>
        )
      )}
      {view.confirmationPending && (
        <div className="studio-requirement-recovery" role="status">
          <p>上次确认的回执尚未核实。恢复结果会沿用原操作，避免重复生成。</p>
          <button
            type="button"
            disabled={!canEdit || !!operation}
            onClick={() =>
              void perform("正在核实确认结果", onRecoverConfirmation)
            }
          >
            恢复确认结果
          </button>
        </div>
      )}
      {view.generationStarting && !view.confirmationPending && (
        <div className="studio-requirement-recovery" role="status">
          <p>
            {view.generationIssue
              ? "需求已确认，生成暂未启动。重试会继续同一份冻结任务。"
              : "需求已确认，正在等待生成启动，无需再次确认。"}
          </p>
          {view.generationIssue && <p>诊断码：{view.generationIssue}</p>}
          {view.generationIssue && onRetryGeneration && (
            <button
              type="button"
              disabled={!canEdit || !!operation}
              onClick={() =>
                void perform("正在恢复已确认任务", onRetryGeneration)
              }
            >
              重试已确认任务
            </button>
          )}
        </div>
      )}
      {operation && <p role="status">{operation}…</p>}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
