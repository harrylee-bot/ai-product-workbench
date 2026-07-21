export const conditionalObjectCreateModes = [
  "s3-if-none-match",
  "oss-forbid-overwrite",
] as const;

export type ConditionalObjectCreateMode = typeof conditionalObjectCreateModes[number];

export function parseConditionalObjectCreateMode(
  value: string | undefined,
): ConditionalObjectCreateMode {
  const normalized = value?.trim() || "s3-if-none-match";
  if (conditionalObjectCreateModes.includes(normalized as ConditionalObjectCreateMode)) {
    return normalized as ConditionalObjectCreateMode;
  }
  throw new Error(
    `WORKBENCH_S3_CONDITIONAL_CREATE_MODE must be ${conditionalObjectCreateModes.join(" or ")}`,
  );
}

export function conditionalObjectCreateInput(mode: ConditionalObjectCreateMode) {
  return mode === "s3-if-none-match" ? { IfNoneMatch: "*" as const } : {};
}

export function conditionalObjectCreateHeader(mode: ConditionalObjectCreateMode) {
  return mode === "oss-forbid-overwrite"
    ? { name: "x-oss-forbid-overwrite", value: "true" } as const
    : null;
}

export function setObjectStorageRequestHeader(
  request: unknown,
  header: { name: string; value: string },
) {
  if (!isRecord(request) || !isRecord(request.headers)) {
    throw new Error("OBJECT_STORAGE_HTTP_REQUEST_UNAVAILABLE");
  }
  request.headers[header.name] = header.value;
}

export function isConditionalObjectCreateConflict(error: unknown) {
  if (!isRecord(error)) return false;
  const name = typeof error.name === "string" ? error.name : undefined;
  const code = typeof error.Code === "string" ? error.Code : undefined;
  const metadata = isRecord(error.$metadata) ? error.$metadata : null;
  const status = typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
  return name === "PreconditionFailed"
    || code === "PreconditionFailed"
    || status === 412
    || ((name === "FileAlreadyExists" || code === "FileAlreadyExists") && status === 409);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
