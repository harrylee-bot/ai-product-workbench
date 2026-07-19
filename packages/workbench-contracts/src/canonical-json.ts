import canonicalizeModule from "canonicalize";

import { jsonValueSchema } from "./common.js";

const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;

export class CanonicalJsonError extends TypeError {
  constructor() {
    super("VALUE_NOT_JSON");
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: unknown): string {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new CanonicalJsonError();
  const result = canonicalize(parsed.data);
  if (result === undefined) throw new CanonicalJsonError();
  return result;
}
