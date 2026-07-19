import { HttpStatus } from "@nestjs/common";
import { ProblemException } from "./problem-details.js";

export class UnsatisfiedByteRangeProblem extends ProblemException {
  constructor(readonly byteSize: number) {
    super({
      title: "Range not satisfiable",
      status: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      detail: `The requested byte range is outside a ${byteSize}-byte resource`,
      code: "BYTE_RANGE_NOT_SATISFIABLE",
    });
  }
}

export function parseByteRange(value: string | undefined, byteSize: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new UnsatisfiedByteRangeProblem(byteSize);
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new UnsatisfiedByteRangeProblem(byteSize);
    }
    start = Math.max(0, byteSize - suffixLength);
    end = byteSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : byteSize - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= byteSize) {
    throw new UnsatisfiedByteRangeProblem(byteSize);
  }
  return { start, end: Math.min(end, byteSize - 1) };
}

export function entityTagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  const candidates = header.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
  return candidates.some((candidate) => candidate === "*" || candidate.replace(/^W\//, "") === etag);
}

export function inlineContentDisposition(fileName: string) {
  return contentDisposition("inline", fileName);
}

export function attachmentContentDisposition(fileName: string) {
  return contentDisposition("attachment", fileName);
}

function contentDisposition(kind: "inline" | "attachment", fileName: string) {
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${kind}; filename*=UTF-8''${encoded}`;
}
