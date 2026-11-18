"use client";
import { RequirementDiscussion } from "./requirement-discussion";
import { StudioComposer, type StudioComposerProps } from "./composer";
import type { ComponentProps, ReactNode } from "react";

/** Shares the Onlook-derived input, attachments, model/output selection and
 * fixed version/feedback context. The supplied submit handler is discussion
 * only; the single explicit confirm callback owns generation. */
export function RequirementInput({
  discussion,
  generationActive = false,
  composer,
  children,
}: {
  discussion: ComponentProps<typeof RequirementDiscussion>;
  generationActive?: boolean;
} & (
  | { composer: StudioComposerProps; children?: never }
  | { composer?: never; children: ReactNode }
)) {
  const { view } = discussion;
  const compact = generationActive &&
    (view.status === "discussing" || view.status === "generating") &&
    !view.questions.length && !view.confirmationPending && !view.generationStarting;
  return (
    <div className="studio-requirement-input">
      {compact ? (
        <details key={view.scopeKey} className="studio-generation-discussion">
          <summary>查看需求讨论</summary>
          <RequirementDiscussion {...discussion} />
        </details>
      ) : <RequirementDiscussion {...discussion} />}
      {children}
      {composer && (
        <StudioComposer
          {...composer}
          discussion
          intentControl={
            <>
              {composer.intentControl}
              <p className="studio-muted">
                {discussion.view.status === "generating"
                  ? "发送会保存到后续讨论，不会改变正在生成的需求。"
                  : "先交流本次需求，审阅改动后再确认生成。"}
              </p>
            </>
          }
        />
      )}
    </div>
  );
}
