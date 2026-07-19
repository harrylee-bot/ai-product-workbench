import {
  canonicalJson,
  type PrdDocument,
} from "@workbench/workbench-contracts";

export function prdDocumentEditIdempotencyKey(
  baseArtifactVersionId: string,
  document: PrdDocument,
): string {
  const baseSegment = baseArtifactVersionId.slice(0, 80);
  return `prd-edit:${baseSegment}:${document.revision.number}:${fnv1a(canonicalJson(document))}`;
}
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
