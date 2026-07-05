import { ConversationDesignStateStatus, ConversationStatus } from "@prisma/client";
import type { ConversationDesignState, QAReport, QAReportStatus } from "./ai-vibe.types";

type DesignStateLike = Pick<ConversationDesignState, "status"> | null | undefined;

export function conversationStatusFromDesignState(
  state: DesignStateLike,
  fallback: ConversationStatus = ConversationStatus.active,
): ConversationStatus {
  return conversationStatusFromDesignStateStatus(state?.status, fallback);
}

export function conversationStatusFromDesignStateStatus(
  status: ConversationDesignStateStatus | ConversationDesignState["status"] | null | undefined,
  fallback: ConversationStatus = ConversationStatus.active,
): ConversationStatus {
  if (!status) return fallback;
  return isLifecycleLockedConversationStatus(fallback) ? fallback : ConversationStatus.active;
}

export function conversationStatusAfterQa(input: {
  qaStatus: QAReportStatus;
  currentConversationStatus: ConversationStatus;
  conversationDesignState?: DesignStateLike;
}): ConversationStatus {
  if (isLifecycleLockedConversationStatus(input.currentConversationStatus)) return input.currentConversationStatus;
  return conversationStatusFromDesignState(input.conversationDesignState, input.currentConversationStatus);
}

export function conversationStatusForCompletedArtifacts(input: {
  conversationDesignState?: DesignStateLike;
  qaReport?: Pick<QAReport, "status"> | null;
  fallback?: ConversationStatus;
}): ConversationStatus {
  return conversationStatusFromDesignState(input.conversationDesignState, input.fallback ?? ConversationStatus.active);
}

function isLifecycleLockedConversationStatus(status: ConversationStatus) {
  return status === ConversationStatus.archived || status === ConversationStatus.deleted;
}
