import type { NestExpressApplication } from "@nestjs/platform-express";

export const defaultMaximumJsonRequestBytes = 2 * 1024 * 1024;

export function configureWorkbenchRequestBody(
  app: NestExpressApplication,
  maximumRequestBytes = workbenchApiMaximumRequestBytes(),
): void {
  if (!Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes <= 0) {
    throw new RangeError("Workbench API maximum request bytes must be a positive safe integer");
  }
  app.useBodyParser("json", { limit: maximumRequestBytes });
}

export function workbenchApiMaximumRequestBytes(
  raw = process.env.WORKBENCH_API_MAX_REQUEST_BYTES,
): number {
  const normalized = raw?.trim();
  if (!normalized) return defaultMaximumJsonRequestBytes;
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error("WORKBENCH_API_MAX_REQUEST_BYTES must be a positive integer");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new Error("WORKBENCH_API_MAX_REQUEST_BYTES exceeds the safe integer range");
  }
  return value;
}
