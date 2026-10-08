import path from "node:path";

export const KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES = Object.freeze(["imports", "source-assets"]);

const allowedCategories = new Set(KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES);

export function collectKnowledgeStorageDeclarations(documents) {
  const rawReferences = documents.flatMap(({ relativePath, raw, header }) =>
    extractStorageReferences(raw, header ?? frontmatterHeader(raw), relativePath));
  const directoryReferences = [];
  const rejectedReferences = [];
  const issues = [];
  const referencesByPath = new Map();

  for (const reference of rawReferences) {
    const normalized = normalizeKnowledgeStorageReference(reference.raw);
    if (!normalized.ok) {
      rejectedReferences.push({ ...reference, reason: normalized.reason });
      issues.push({
        code: "INVALID_STORAGE_REFERENCE",
        file: reference.file,
        line: reference.line,
        path: reference.raw,
        detail: normalized.reason,
      });
      continue;
    }
    if (normalized.directory) {
      directoryReferences.push({ ...reference, path: normalized.logicalPath });
      continue;
    }
    const existing = referencesByPath.get(normalized.logicalPath) ?? {
      path: normalized.logicalPath,
      references: [],
      declarations: [],
    };
    existing.references.push({ file: reference.file, line: reference.line, kind: reference.kind });
    referencesByPath.set(normalized.logicalPath, existing);
  }

  bindIntegrityDeclarations(documents, referencesByPath, issues);
  const assets = [...referencesByPath.values()]
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .map((entry) => {
      const sha256 = unique(entry.declarations.filter((item) => item.kind === "sha256").map((item) => item.value));
      const byteSize = unique(entry.declarations.filter((item) => item.kind === "byteSize").map((item) => item.value));
      if (sha256.length > 1) {
        issues.push({
          code: "STORAGE_INTEGRITY_CONFLICT",
          file: entry.declarations.find((item) => item.kind === "sha256")?.file ?? entry.references[0]?.file ?? "",
          line: entry.declarations.find((item) => item.kind === "sha256")?.line ?? entry.references[0]?.line ?? 1,
          path: entry.path,
          detail: `SHA-256 declarations conflict: ${sha256.join(", ")}`,
        });
      }
      if (byteSize.length > 1) {
        issues.push({
          code: "STORAGE_INTEGRITY_CONFLICT",
          file: entry.declarations.find((item) => item.kind === "byteSize")?.file ?? entry.references[0]?.file ?? "",
          line: entry.declarations.find((item) => item.kind === "byteSize")?.line ?? entry.references[0]?.line ?? 1,
          path: entry.path,
          detail: `byteSize declarations conflict: ${byteSize.join(", ")}`,
        });
      }
      return {
        path: entry.path,
        references: sortReferences(entry.references),
        declaredIntegrity: {
          sha256,
          byteSize,
          sources: entry.declarations
            .map(({ file, line, kind, value }) => ({ file, line, kind, value }))
            .sort(compareSourceLocations),
        },
      };
    });

  return {
    assets,
    directoryReferences: directoryReferences.sort(compareSourceLocations),
    rejectedReferences: rejectedReferences.sort(compareSourceLocations),
    issues: issues.sort(compareSourceLocations),
  };
}

export function normalizeKnowledgeStorageReference(raw) {
  let value = unquote(raw.trim());
  if (!value) return { ok: false, reason: "空路径" };
  if (/^file:/i.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    return { ok: false, reason: "禁止绝对路径或 file URI" };
  }
  if (value.includes("\\")) return { ok: false, reason: "storage 路径必须使用 /" };
  try {
    value = decodeURIComponent(value);
  } catch {
    return { ok: false, reason: "路径包含无效的百分号编码" };
  }
  if (value.includes("\\")) return { ok: false, reason: "storage 路径必须使用 /" };
  value = value.replace(/^\.\//, "");
  const hadTrailingSlash = value.endsWith("/");
  const segments = value.split("/").filter((segment, index, all) => segment || index === all.length - 1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "禁止路径穿越" };
  }
  if (segments[0] !== "storage") return { ok: false, reason: "路径必须从 storage/ 开始" };
  if (segments.length === 1 || (segments.length === 2 && !segments[1])) {
    return { ok: true, logicalPath: "storage", directory: true };
  }
  const category = segments[1];
  if (!allowedCategories.has(category)) {
    return { ok: false, reason: `不允许引用 storage/${category || "<empty>"}` };
  }
  const cleanSegments = segments.filter(Boolean);
  const logicalPath = cleanSegments.join("/").normalize("NFC");
  if (cleanSegments.length === 2 || hadTrailingSlash) {
    return { ok: true, logicalPath, directory: true };
  }
  return { ok: true, logicalPath, directory: false };
}

export function validateKnowledgeStorageIntegrity(asset, actual) {
  const issues = [];
  const expectedSha256 = asset.declaredIntegrity.sha256;
  const expectedByteSizes = asset.declaredIntegrity.byteSize;
  if (expectedSha256.length > 1 || expectedByteSizes.length > 1) return issues;
  if (expectedSha256.length === 1 && expectedSha256[0] !== actual.sha256) {
    issues.push({
      code: "STORAGE_CHECKSUM_MISMATCH",
      file: asset.references[0]?.file ?? "",
      line: asset.references[0]?.line ?? 1,
      path: asset.path,
      detail: `声明 ${expectedSha256[0]}，实际 ${actual.sha256}`,
    });
  }
  if (expectedByteSizes.length === 1 && expectedByteSizes[0] !== actual.byteSize) {
    issues.push({
      code: "STORAGE_BYTE_SIZE_MISMATCH",
      file: asset.references[0]?.file ?? "",
      line: asset.references[0]?.line ?? 1,
      path: asset.path,
      detail: `声明 ${expectedByteSizes[0]}，实际 ${actual.byteSize}`,
    });
  }
  return issues;
}

export function knowledgeStorageMediaType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".css": "text/css",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  })[extension] ?? "application/octet-stream";
}

function extractStorageReferences(raw, header, relativePath) {
  const findings = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  const headerLineCount = header ? header.split(/\r?\n/).length + 1 : 0;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isFrontmatterLine = lineNumber > 1 && lineNumber <= headerLineCount + 1;
    for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
      addReferenceCandidates(findings, seen, match[1], relativePath, lineNumber, "inline-code", true);
    }
    for (const match of line.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*\)/g)) {
      addReferenceCandidates(findings, seen, match[1] ?? match[2], relativePath, lineNumber, "markdown-link", true);
    }
    if (isFrontmatterLine) {
      const scalar = line.match(/^\s*[A-Za-z0-9_-]+:\s*(.*?)\s*$/)?.[1];
      if (scalar) addReferenceCandidates(findings, seen, unquote(scalar), relativePath, lineNumber, "frontmatter", true);
    }

    if (isFrontmatterLine) continue;
    const withoutStructuredReferences = line
      .replace(/`[^`\r\n]+`/g, " ")
      .replace(/\]\(\s*(?:<[^>]+>|[^\s)]+)\s*\)/g, " ");
    addReferenceCandidates(findings, seen, withoutStructuredReferences, relativePath, lineNumber, "bare", false);
  }
  return findings;
}

function addReferenceCandidates(findings, seen, value, file, line, kind, wholeValue) {
  for (const candidate of storageCandidates(value, wholeValue)) {
    const raw = trimReferencePunctuation(candidate);
    if (!raw) continue;
    const key = `${file}\0${line}\0${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ file, line, kind, raw });
  }
}

function storageCandidates(value, wholeValue) {
  const input = value?.trim();
  if (!input) return [];
  const variants = [input];
  try {
    const decoded = decodeURIComponent(input);
    if (decoded !== input) variants.push(decoded);
  } catch {
    // Normalization reports malformed encoding for extracted storage paths.
  }
  if (wholeValue) {
    const storageValue = variants.find((candidate) => looksLikeStorageReference(candidate));
    if (storageValue) return [storageValue];
  }
  const pattern = /(?:file:\/\/\/[^\s`"'<>|，。；、)]*\/storage\/[^\s`"'<>|，。；、)]*|(?:[A-Za-z]:[\\/]|\/)[^\s`"'<>|，。；、)]*[\\/]storage[\\/][^\s`"'<>|，。；、)]*|(?:\.\.\/[\w.@%+,:=\-\u4e00-\u9fff/]*?)?storage[\\/][^\s`"'<>|，。；、)]*)/giu;
  return variants.flatMap((candidate) => [...candidate.matchAll(pattern)].map((match) => match[0]));
}

function looksLikeStorageReference(value) {
  return /^\.?\/?storage[\\/]/i.test(value)
    || /^(?:\.\.\/[\s\S]*|file:\/\/\/[\s\S]*|[A-Za-z]:[\\/][\s\S]*|\/[\s\S]*)[\\/]storage[\\/]/i.test(value);
}

function bindIntegrityDeclarations(documents, referencesByPath, issues) {
  for (const { relativePath, raw } of documents) {
    const references = [...referencesByPath.values()].filter((entry) =>
      entry.references.some((reference) => reference.file === relativePath));
    if (!references.length) continue;
    const documentPaths = new Set(references.map((entry) => entry.path));
    const referencePathsByLine = new Map();
    for (const entry of references) {
      for (const reference of entry.references.filter((item) => item.file === relativePath)) {
        const paths = referencePathsByLine.get(reference.line) ?? new Set();
        paths.add(entry.path);
        referencePathsByLine.set(reference.line, paths);
      }
    }

    const lines = raw.split(/\r?\n/);
    const declarations = [];
    let activeTablePath = null;
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const isTableRow = /^\s*\|.*\|\s*$/.test(line);
      if (!isTableRow) activeTablePath = null;
      const pathsOnLine = [...(referencePathsByLine.get(lineNumber) ?? [])];
      if (isTableRow && pathsOnLine.length === 1) activeTablePath = pathsOnLine[0];
      const declaration = parseIntegrityDeclaration(line, relativePath, lineNumber);
      if (!declaration) continue;
      if (declaration.invalid) {
        issues.push({
          code: "STORAGE_INTEGRITY_INVALID",
          file: relativePath,
          line: lineNumber,
          detail: declaration.invalid,
        });
        continue;
      }
      const targetPath = pathsOnLine.length === 1
        ? pathsOnLine[0]
        : activeTablePath ?? (documentPaths.size === 1 ? [...documentPaths][0] : null);
      declarations.push({ ...declaration, targetPath });
    }

    for (const declaration of declarations) {
      if (!declaration.targetPath) {
        issues.push({
          code: "STORAGE_INTEGRITY_AMBIGUOUS",
          file: declaration.file,
          line: declaration.line,
          detail: "integrity declaration cannot be bound to exactly one storage asset",
        });
        continue;
      }
      referencesByPath.get(declaration.targetPath)?.declarations.push(declaration);
    }
  }
}

function parseIntegrityDeclaration(line, file, lineNumber) {
  const cells = /^\s*\|.*\|\s*$/.test(line)
    ? line.trim().slice(1, -1).split("|").map((cell) => cell.trim())
    : null;
  const label = cells ? cells[0] : line.match(/^\s*(?:[-*]\s*)?([^:：]+?)\s*[:：]/)?.[1]?.trim();
  const value = cells ? cells.slice(1).join(" | ") : line.replace(/^\s*(?:[-*]\s*)?[^:：]+?\s*[:：]\s*/, "");
  if (!label) return null;
  const normalizedLabel = label.replace(/[`*_\s]/g, "").toLowerCase();
  if (/^(?:sha-?256|文件sha-?256|checksum|校验和)$/.test(normalizedLabel)) {
    const sha256 = value.match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase();
    return sha256
      ? { file, line: lineNumber, kind: "sha256", value: sha256 }
      : { invalid: "SHA-256 must contain exactly 64 hexadecimal characters", file, line: lineNumber };
  }
  if (/^(?:bytesize|byte_size|bytes|文件大小|压缩包大小|归档大小)$/.test(normalizedLabel)) {
    const rawSize = value.match(/\b\d[\d,_ ]*\b/)?.[0]?.replace(/[,_ ]/g, "");
    const byteSize = rawSize === undefined ? Number.NaN : Number(rawSize);
    return Number.isSafeInteger(byteSize) && byteSize >= 0
      ? { file, line: lineNumber, kind: "byteSize", value: byteSize }
      : { invalid: "byteSize must be a non-negative safe integer", file, line: lineNumber };
  }
  return null;
}

function frontmatterHeader(raw) {
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)?.[1] ?? "";
}

function trimReferencePunctuation(value) {
  return unquote(value.trim()).replace(/[.,;:!?，。；：！？」』】]+$/u, "");
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unique(values) {
  return [...new Set(values)];
}

function sortReferences(references) {
  return unique(references.map((item) => JSON.stringify(item)))
    .map((item) => JSON.parse(item))
    .sort(compareSourceLocations);
}

function compareSourceLocations(left, right) {
  return compareCodePoints(left.file, right.file) || left.line - right.line;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
