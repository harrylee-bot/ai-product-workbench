import type {
  UIMessage,
  UIMessagePart,
} from 'ai';
import { type ClassValue, clsx } from 'clsx';
import { formatISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';
import type { DBMessage, Document } from '@/lib/api/types';
import { ChatbotError, type ErrorCode } from './errors';
import type { ChatMessage, ChatTools, CustomUIDataTypes } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url, { credentials: 'include' });

  if (!response.ok) {
    const error = await createChatbotError(response);
    throw error;
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const error = await createChatbotError(response);
      throw error;
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ChatbotError('offline:chat');
    }

    throw error;
  }
}

type ErrorResponseBody = {
  code?: unknown;
  cause?: unknown;
  message?: unknown;
  error?: unknown;
};

async function createChatbotError(response: Response) {
  const body = await readErrorResponseBody(response);
  const message = readString(body.message) ?? readString(body.error);
  const cause = readString(body.cause);
  const code = readString(body.code) ?? getErrorCodeByStatus(response.status);

  return new ChatbotError(code, cause, message);
}

async function readErrorResponseBody(response: Response): Promise<ErrorResponseBody> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      return body as ErrorResponseBody;
    }
  } catch {
    // Keep the original status-derived fallback when the server returns no JSON.
  }

  return {};
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(value)) {
    return readString(value[0]);
  }

  return undefined;
}

function getErrorCodeByStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized:api';
    case 403:
      return 'forbidden:api';
    case 404:
      return 'not_found:api';
    case 429:
      return 'rate_limit:api';
    case 503:
      return 'offline:api';
    default:
      return 'bad_request:api';
  }
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getDocumentTimestampByIndex(
  documents: Document[],
  index: number,
) {
  if (!documents) { return new Date(); }
  if (index > documents.length) { return new Date(); }

  return documents[index].createdAt;
}

export function sanitizeText(text: string) {
  return text.replace('<has_function_call>', '');
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as 'user' | 'assistant' | 'system',
    parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt: formatISO(message.createdAt),
    },
  }));
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string}).text)
    .join('');
}
