import { createHash } from "node:crypto";
import {
  applyPrototypePatch,
  assertPrototypePatchPayloadSize,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  type PrototypeDocument,
  type PrototypePatchBatch,
} from "@workbench/workbench-contracts";

export function applyAndVerifyPrototypePatch(
  document: PrototypeDocument,
  patch: PrototypePatchBatch,
) {
  assertPrototypePatchPayloadSize(patch);
  const applied = applyPrototypePatch(document, patch);
  return {
    ...applied,
    checksum: digestCanonicalProjection(applied.canonicalProjection),
  };
}

export function prototypeScreenProjectionChecksum(
  document: PrototypeDocument,
  screenId: string,
  revision: number,
) {
  const projection = projectPrototypeScreen(document, screenId, revision);
  return computePrototypeScreenProjectionChecksum(projection, digestCanonicalProjection);
}

function digestCanonicalProjection(canonicalProjection: string) {
  return createHash("sha256").update(canonicalProjection).digest("hex");
}
