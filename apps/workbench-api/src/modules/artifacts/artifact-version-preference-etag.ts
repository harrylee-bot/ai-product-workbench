import { createHash } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import {
  preconditionRequiredProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";

type ArtifactVersionPreferenceEtagScope = {
  principalId: string;
  artifactId: string;
  artifactVersionId: string;
  screenId: string | null;
};

const scopedEtagPattern = /^"avp1\.(0|[1-9]\d*)\.([A-Za-z0-9_-]{43})"$/u;

export function artifactVersionPreferenceEtag(
  scope: ArtifactVersionPreferenceEtagScope,
  revision: number,
): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("ARTIFACT_VERSION_PREFERENCE_REVISION_INVALID");
  }
  const scopeSha256 = createHash("sha256").update(canonicalJson({
    protocol: "workbench.artifact-version-preference-etag.v1",
    ...scope,
  })).digest("base64url");
  return `"avp1.${revision}.${scopeSha256}"`;
}

export function parseArtifactVersionPreferenceIfMatch(
  value: string | undefined,
  scope: ArtifactVersionPreferenceEtagScope,
): number {
  if (!value) throw preconditionRequiredProblem();
  const match = scopedEtagPattern.exec(value);
  if (!match) {
    throw validationProblem(
      "If-Match must contain one strong ArtifactVersion preference ETag",
    );
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw validationProblem("If-Match revision is outside the safe integer range");
  }
  if (artifactVersionPreferenceEtag(scope, revision) !== value) {
    throw revisionConflictProblem();
  }
  return revision;
}
