import { ConversationDesignStateStatus, ConversationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  conversationStatusAfterQa,
  conversationStatusForCompletedArtifacts,
  conversationStatusFromDesignStateStatus,
} from "../src/ai/workspace-state-machine";

describe("workspace state machine", () => {
  it("derives visible conversation status from ConversationDesignState status", () => {
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.clarifying)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.intake)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.format_check)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.scoring)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.optimizing)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.doc_ready)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.doc_confirmed)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.prd_ready)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.prototype_ready)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.qa_failed)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.confirmed)).toBe(ConversationStatus.active);
    expect(conversationStatusFromDesignStateStatus(ConversationDesignStateStatus.design_ready)).toBe(ConversationStatus.active);
  });

  it("keeps conversation lifecycle status independent from QA artifact readiness", () => {
    expect(conversationStatusForCompletedArtifacts({
      conversationDesignState: { status: "prototype_ready" },
      qaReport: { status: "failed" },
    })).toBe(ConversationStatus.active);
  });

  it("returns to ConversationDesignState-derived status after QA passes or warns", () => {
    expect(conversationStatusAfterQa({
      qaStatus: "passed",
      currentConversationStatus: ConversationStatus.active,
      conversationDesignState: { status: "doc_ready" },
    })).toBe(ConversationStatus.active);

    expect(conversationStatusAfterQa({
      qaStatus: "warning",
      currentConversationStatus: ConversationStatus.active,
      conversationDesignState: { status: "prototype_ready" },
    })).toBe(ConversationStatus.active);
  });

  it("does not unlock archived or deleted conversations", () => {
    expect(conversationStatusAfterQa({
      qaStatus: "passed",
      currentConversationStatus: ConversationStatus.archived,
      conversationDesignState: { status: "prototype_ready" },
    })).toBe(ConversationStatus.archived);

    expect(conversationStatusAfterQa({
      qaStatus: "failed",
      currentConversationStatus: ConversationStatus.deleted,
      conversationDesignState: { status: "prototype_ready" },
    })).toBe(ConversationStatus.deleted);
  });
});
