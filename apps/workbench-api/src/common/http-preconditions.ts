import { preconditionRequiredProblem, validationProblem } from "./problem-details.js";

export function parseIfMatch(value: string | undefined) {
  if (!value) throw preconditionRequiredProblem();
  const match = /^"(0|[1-9]\d*)"$/.exec(value);
  if (!match) throw validationProblem("If-Match must contain one strong numeric ETag");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw validationProblem("If-Match revision is outside the safe integer range");
  }
  return revision;
}

export function revisionEtag(revision: number) {
  return `"${revision}"`;
}
