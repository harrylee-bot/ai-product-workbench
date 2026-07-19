import { createHash } from "node:crypto";
import serialize from "canonicalize";

import type { JsonValue } from "./types.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  const canonicalize = serialize as unknown as (input: unknown) => string | undefined;
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError("VALUE_NOT_CANONICAL_JSON");
  return result;
}

export function canonicalSha256(value: JsonValue): string {
  return sha256(canonicalJson(value));
}
