import { nanoid } from "nanoid";
import type { z } from "zod";

export type CursorPageOptions = { cursor?: string; limit?: number };

export type Versioned<T> = {
  value: T;
  etag: string;
};

export type ImmutableVersioned<T> = {
  value: T;
  etag: string;
};

export type ConditionalVersioned<T> =
  | { status: "modified"; representation: Versioned<T> }
  | { status: "not-modified"; etag: string };

export class WorkbenchContractError extends Error {
  readonly operation: string;

  constructor(operation: string, options?: { cause?: unknown }) {
    super(
      "产品工作台 API 返回了不符合合同的响应，请重试",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkbenchContractError";
    this.operation = operation;
  }
}

export class WorkbenchVersionRequiredError extends Error {
  constructor(resource: string, id: string) {
    super(`Load ${resource} ${id} before attempting a versioned mutation`);
    this.name = "WorkbenchVersionRequiredError";
  }
}

export function createIdempotencyKey(scope: string): string {
  if (!/^[A-Za-z0-9._:-]{1,24}$/.test(scope)) {
    throw new Error(`Invalid idempotency scope: ${scope}`);
  }
  return `${scope}:${nanoid(24)}`;
}

export function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new Error("Idempotency-Key must contain 8-128 URL-safe characters");
  }
  return normalized;
}

export function normalizeEtag(value: string): string {
  const normalized = value.trim();
  if (!/^"\d+"$/.test(normalized)) throw new Error(`Invalid ETag: ${value}`);
  return normalized;
}

export function normalizeStrongEtag(value: string): string {
  const normalized = value.trim();
  if (!/^"[A-Za-z0-9._:-]{1,128}"$/.test(normalized)) {
    throw new Error(`Invalid strong ETag: ${value}`);
  }
  return normalized;
}

export function requireData<T>(data: T | undefined, operation: string): T {
  if (data === undefined) throw new WorkbenchContractError(operation);
  return data;
}

export function parseContract<Schema extends z.ZodTypeAny>(
  schema: Schema,
  data: unknown,
  operation: string,
): z.output<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) throw new WorkbenchContractError(operation, { cause: result.error });
  return result.data;
}

export function versioned<Schema extends z.ZodTypeAny>(
  schema: Schema,
  data: unknown,
  response: Response,
  operation: string,
): Versioned<z.output<Schema>> {
  const value = parseContract(schema, data, operation);
  return { value, etag: responseEtag(response, operation) };
}

export function immutableVersioned<Schema extends z.ZodTypeAny>(
  schema: Schema,
  data: unknown,
  response: Response,
  operation: string,
): ImmutableVersioned<z.output<Schema>> {
  const value = parseContract(schema, data, operation);
  const etag = response.headers.get("etag");
  if (!etag) throw new WorkbenchContractError(`${operation} ETag`);
  return { value, etag: normalizeStrongEtag(etag) };
}

export function strongVersioned<Schema extends z.ZodTypeAny>(
  schema: Schema,
  data: unknown,
  response: Response,
  operation: string,
): Versioned<z.output<Schema>> {
  const value = parseContract(schema, data, operation);
  const etag = response.headers.get("etag");
  if (!etag) throw new WorkbenchContractError(`${operation} ETag`);
  return { value, etag: normalizeStrongEtag(etag) };
}

export function responseEtag(response: Response, operation: string): string {
  const etag = response.headers.get("etag");
  if (!etag) throw new WorkbenchContractError(`${operation} ETag`);
  return normalizeEtag(etag);
}
