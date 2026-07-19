import {
  canonicalJson,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";

export function prototypeDocumentEditIdempotencyKey(
  baseArtifactVersionId: string,
  document: PrototypeDocument,
): string {
  const serialized = canonicalJson(document);
  const baseSegment = baseArtifactVersionId.slice(0, 80);
  return `prototype-edit:${baseSegment}:${document.revision}:${fnv1a(serialized)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
