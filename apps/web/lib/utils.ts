import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ChatbotError, type ErrorCode } from './errors';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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

export function sanitizeText(text: string) {
  return text.replace('<has_function_call>', '');
}
