// ai-chatbot 前端数据类型（与 NestJS 后端对接，不依赖 drizzle）。
// 替代原 lib/db/schema.ts 的类型导出，保持组件 import 路径兼容。

import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";

export type Visibility = VisibilityType;

export type User = {
  id: string;
  email: string | null;
  name?: string | null;
  emailVerified?: boolean;
  image?: string | null;
  isAnonymous?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type Chat = {
  id: string;
  createdAt: string;
  title: string;
  userId: string;
  visibility: Visibility;
};

export type DBMessage = {
  id: string;
  chatId: string;
  role: string;
  parts: unknown;
  attachments: unknown;
  createdAt: string;
};

export type Vote = {
  chatId: string;
  messageId: string;
  isUpvoted: boolean;
};

export type Document = {
  id: string;
  createdAt: string;
  title: string;
  content: string | null;
  kind: ArtifactKind;
  userId: string;
};

export type Suggestion = {
  id: string;
  documentId: string;
  documentCreatedAt: string;
  originalText: string;
  suggestedText: string;
  description?: string | null;
  isResolved: boolean;
  userId: string;
  createdAt: string;
};

export type Stream = {
  id: string;
  chatId: string;
  createdAt: string;
};
