import { createHash } from "node:crypto";
import { canonicalJson as canonicalizeJson } from "@workbench/workbench-contracts";
import { validationProblem } from "./problem-details.js";

export function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw validationProblem("Idempotency-Key must be 8-128 URL-safe characters");
  }
}

export function hashRequest(request: unknown) {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  try {
    return canonicalizeJson(value);
  } catch {
    throw validationProblem("Request values must be valid JSON");
  }
}
