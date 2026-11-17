"use client";
import { RequirementDiscussion } from "./requirement-discussion";
import { StudioComposer, type StudioComposerProps } from "./composer";
import type { ComponentProps } from "react";

/** Shares the Onlook-derived input, attachments, model/output selection and
 * fixed version/feedback context. The supplied submit handler is discussion
 * only; the single explicit confirm callback owns generation. */
export function RequirementInput({
  discussion,
  composer,
}: {
  discussion: ComponentProps<typeof RequirementDiscussion>;
  composer: StudioComposerProps;
}) {
  return (
    <div className="studio-requirement-input">
      <RequirementDiscussion {...discussion} />
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
    </div>
  );
}
