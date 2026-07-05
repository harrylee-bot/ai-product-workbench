import type { UIMessage } from "ai";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { Suggestion } from "@/lib/api/types";

type MessageMetadata = {
  createdAt: string;
};

// NestJS 桥不发 tool-call（用 data-* artifact parts），无前端工具类型。
type ChatTools = {};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": string;
  "runtime-start": RuntimeProcessSnapshot;
  "runtime-event": RuntimeProcessEvent;
  "runtime-finish": RuntimeProcessSnapshot;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  fileId?: string;
  name: string;
  url: string;
  contentType: string;
  size?: number;
};

type RuntimeProcessStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RuntimeProcessEvent = {
  id: string;
  runId?: string;
  kind:
    | "status"
    | "knowledge"
    | "tool"
    | "artifact"
    | "document"
    | "error";
  label: string;
  detail?: string;
  artifact?: {
    id: string;
    title: string;
    kind: ArtifactKind;
  };
  status: "running" | "completed" | "failed";
  createdAt: string;
};

export type RuntimeProcessSnapshot = {
  runId?: string;
  status: RuntimeProcessStatus;
  startedAt?: string;
  endedAt?: string | null;
  title?: string;
  events?: RuntimeProcessEvent[];
};
