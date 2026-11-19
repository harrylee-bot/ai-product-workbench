import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/workbench-contracts/src/canonical-json.js";
import {
  MAX_PROTOTYPE_DRAFT_PREVIEW_BYTES,
  projectPrototypeGenerationPreview,
} from "../../../packages/workbench-contracts/src/generation-preview.js";
import {
  assertPrototypePatchPayloadSize,
  runtimePrototypePatchInputSchema,
} from "../../../packages/workbench-contracts/src/prototype-patches.js";
import {
  runtimeResultSchema,
} from "../../../packages/workbench-contracts/src/runtime.js";
import {
  prdSafetyBaselineIntro,
  prdTableOfContentsEntriesForV3,
  type PrdAcceptanceCoverageDiagnostic,
} from "../../../packages/workbench-contracts/src/prd.js";
import { categoryListIssues } from "./prototype-filter-validation.js";

const MAX_INPUT_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_ISSUES = 100;

type ValidationIssue = {
  code: string;
  path: Array<string | number>;
  message: string;
  expectedType?: string;
  expectedValue?: string;
  acceptanceCoverage?: PrdAcceptanceCoverageDiagnostic;
  directoryEntries?: string[];
  authoredTextPaths?: Array<ValidationIssue["path"]>;
};

type DraftRepairHint = {
  artifactIndex: number;
  candidateChecksum: string;
  path: ValidationIssue["path"];
} & (
  { acceptanceCoverage: PrdAcceptanceCoverageDiagnostic }
  | { directoryEntries: string[] }
  | { authoredTextPaths: Array<ValidationIssue["path"]> }
);

async function main() {
  const input = await readFileHandle();
  let candidate: unknown;
  try {
    candidate = JSON.parse(input);
  } catch {
    return writeResult({
      protocol: "workbench.runtime.validation.v1",
      ok: false,
      issues: [{ code: "invalid_json", path: [], message: "Candidate must be valid JSON" }],
      candidateChecksum: null,
      artifactChecksums: [],
    });
  }

  const mode = process.argv[2] ?? "runtime-result";
  const draftPreviewIndex = mode === "draft-preview" ? Number(process.argv[3]) : null;
  if (draftPreviewIndex !== null && (!Number.isInteger(draftPreviewIndex) || draftPreviewIndex < 0 || draftPreviewIndex > 19)) {
    throw new Error("RUNTIME_DRAFT_PREVIEW_INDEX_INVALID");
  }
  const isRuntimeResult = mode === "runtime-result" || mode === "draft-preview";
  const candidateChecksum = canonicalChecksum(candidate);
  const artifactChecksums = isRuntimeResult
    ? candidateArtifacts(candidate).map(canonicalChecksum)
    : [];
  const schema = isRuntimeResult
    ? runtimeResultSchema
    : mode === "prototype-patch"
      ? runtimePrototypePatchInputSchema
      : null;
  if (!schema) throw new Error("RUNTIME_RESULT_VALIDATOR_MODE_INVALID");
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    if ("artifacts" in parsed.data) {
      const issues = parsed.data.artifacts.flatMap((draft, index) => (
        draft.kind === "prototype"
          ? categoryListIssues(draft.content, draft.operation.kind === "revise" ? draft.operation.target.screenIds : [])
              .map((issue) => ({ ...issue, path: ["artifacts", index, ...issue.path] }))
          : []
      )).slice(0, MAX_ISSUES);
      if (issues.length) {
        return writeResult({
          protocol: "workbench.runtime.validation.v1",
          ok: false,
          issues,
          candidateChecksum,
          artifactChecksums,
        }, draftPreviewIndex === null ? undefined : serializePrototypePreview(draftPreviewIndex, candidateArtifacts(candidate)[0]));
      }
    }
    if (mode === "prototype-patch") {
      try {
        assertPrototypePatchPayloadSize(parsed.data);
      } catch (error) {
        return writeResult({
          protocol: "workbench.runtime.validation.v1",
          ok: false,
          candidateChecksum,
          artifactChecksums,
          issues: [{
            code: "too_big",
            path: [],
            message: error instanceof Error ? error.message : "Prototype patch payload is too large",
          }],
        });
      }
    }
    return writeResult({
      protocol: "workbench.runtime.validation.v1",
      ok: true,
      issues: [],
      candidateChecksum,
      artifactChecksums,
    });
  }
  const issues = actionableIssues(parsed.error.issues.map((issue) => normalizeZodIssue(issue)), candidate);
  let repairHintBytes = 0;
  const repairHints = issues.flatMap<DraftRepairHint>((issue) => {
    const [root, index, content] = issue.path;
    if (root !== "artifacts" || typeof index !== "number" || content !== "content") return [];
    const base = {
      artifactIndex: index,
      candidateChecksum: artifactChecksums[index]!,
    };
    if (issue.directoryEntries) {
      return [{ ...base, path: ["content", "tableOfContents", "entries"], directoryEntries: issue.directoryEntries }];
    }
    if (issue.authoredTextPaths) {
      return [{ ...base, path: ["content"], authoredTextPaths: issue.authoredTextPaths.map((path) => ["content", ...path]) }];
    }
    const coverage = issue.acceptanceCoverage;
    if (!coverage) return [];
    return [{ ...base,
      path: issue.path.slice(2),
      acceptanceCoverage: {
        ...coverage,
        rows: coverage.rows.map((row) => ({
          ...row, path: `/content${row.path}`,
          conditionPaths: row.conditionPaths.map((path) => `/content${path}`),
          resultPaths: row.resultPaths.map((path) => `/content${path}`),
        })),
      },
    }];
  }).filter((hint, index, all) => all.findIndex((other) =>
    other.artifactIndex === hint.artifactIndex && other.path[1] === hint.path[1]) === index)
    .filter((hint) => {
      repairHintBytes += Buffer.byteLength(JSON.stringify(hint), "utf8");
      return repairHintBytes <= 24_000;
    });
  return writeResult({
    protocol: "workbench.runtime.validation.v1",
    ok: false,
    candidateChecksum,
    artifactChecksums,
    // Coverage metadata belongs in repair guidance, never in controlled
    // artifact issues (whose strict protocol remains unchanged).
    issues: issues.map(({ acceptanceCoverage: _coverage, directoryEntries: _directory, authoredTextPaths: _textPaths, ...issue }) => issue),
    ...(repairHints.length ? { repairHints } : {}),
  }, draftPreviewIndex === null ? undefined : serializePrototypePreview(draftPreviewIndex, candidateArtifacts(candidate)[0]));
}

function serializePrototypePreview(index: number, draft: unknown): string | undefined {
  const preview = projectPrototypeGenerationPreview(index, draft);
  if (!preview || !preview.screens.some((screen) => screen.nodes.length)) return undefined;
  const bounded = { ...preview, screens: preview.screens.map((screen) => ({ ...screen, nodes: [] as typeof screen.nodes })) };
  const screenBudget = Math.floor((MAX_PROTOTYPE_DRAFT_PREVIEW_BYTES - Buffer.byteLength(JSON.stringify(bounded))) / bounded.screens.length);
  for (const [screenIndex, screen] of preview.screens.entries()) {
    let remaining = screenBudget;
    for (const node of screen.nodes) {
      remaining -= Buffer.byteLength(JSON.stringify(node)) + 1;
      if (remaining < 0) break;
      bounded.screens[screenIndex]!.nodes.push(node);
    }
  }
  return bounded.screens.some((screen) => screen.nodes.length) ? JSON.stringify(bounded) : undefined;
}

function normalizeZodIssue(rawIssue: unknown, parentPath: readonly unknown[] = []): unknown {
  if (!isRecord(rawIssue) || !Array.isArray(rawIssue.path)) return rawIssue;
  const path = [...parentPath, ...rawIssue.path];
  const issue = { ...rawIssue, path };
  // Preserve the runtime.validation.v1 error contract. Zod 4 uses relative
  // branch paths and `errors`, while the repair planner expects absolute paths
  // and the legacy literal/enum distinction.
  if (rawIssue.code === "invalid_union" && Array.isArray(rawIssue.errors)) {
    return {
      ...issue,
      unionErrors: rawIssue.errors.map((branch) => ({
        issues: Array.isArray(branch) ? branch.map((child) => normalizeZodIssue(child, path)) : [],
      })),
    };
  }
  if (rawIssue.code === "invalid_value" && Array.isArray(rawIssue.values)) {
    return { ...issue, code: rawIssue.values.length === 1 ? "invalid_literal" : "invalid_enum_value" };
  }
  return issue;
}

function actionableIssues(rawIssues: readonly unknown[], candidate: unknown): ValidationIssue[] {
  const unique = new Map<string, ValidationIssue>();
  for (const issue of rawIssues.flatMap((issue) => actionableIssue(issue, candidate))) {
    const key = JSON.stringify([issue.code, issue.path, issue.message]);
    if (!unique.has(key)) unique.set(key, issue);
    if (unique.size >= MAX_ISSUES) break;
  }
  return [...unique.values()];
}

function actionableIssue(rawIssue: unknown, candidate: unknown): ValidationIssue[] {
  if (!isRecord(rawIssue)) return [];
  const fallback = validationIssue(rawIssue, candidate);
  if (rawIssue.code !== "invalid_union" || !Array.isArray(rawIssue.unionErrors)) {
    return fallback ? [fallback] : [];
  }

  const alternative = uniquelyDiscriminatedAlternative(rawIssue);
  return alternative
    ? actionableIssues(alternative, candidate)
    : (fallback ? [fallback] : []);
}

function uniquelyDiscriminatedAlternative(
  unionIssue: Record<string, unknown>,
): readonly unknown[] | null {
  if (!Array.isArray(unionIssue.path) || !Array.isArray(unionIssue.unionErrors)) return null;
  const alternatives = unionIssue.unionErrors.map((error) => (
    isRecord(error) && Array.isArray(error.issues) ? error.issues : []
  ));
  const matching = alternatives.filter((issues) => (
    directDiscriminantMismatchCount(unionIssue.path as unknown[], issues) === 0
  ));
  return matching.length === 1 ? matching[0] ?? null : null;
}

function directDiscriminantMismatchCount(
  unionPath: readonly unknown[],
  rawIssues: readonly unknown[],
): number {
  return rawIssues.filter((rawIssue) => {
    if (
      !isRecord(rawIssue)
      || !["invalid_enum_value", "invalid_literal", "invalid_type", "invalid_union_discriminator"].includes(String(rawIssue.code))
      || !Array.isArray(rawIssue.path)
    ) {
      return false;
    }
    const issuePath = rawIssue.path;
    if (issuePath.length !== unionPath.length + 1) return false;
    if (!unionPath.every((segment, index) => issuePath[index] === segment)) return false;
    return ["kind", "protocol", "schemaVersion", "type"].includes(String(issuePath.at(-1)));
  }).length;
}

function validationIssue(rawIssue: Record<string, unknown>, candidate: unknown): ValidationIssue | null {
  if (
    typeof rawIssue.code !== "string"
    || typeof rawIssue.message !== "string"
    || !Array.isArray(rawIssue.path)
    || rawIssue.path.some((segment) => typeof segment !== "string" && typeof segment !== "number")
  ) {
    return null;
  }
  const issue: ValidationIssue = {
    code: rawIssue.code,
    path: rawIssue.path as Array<string | number>,
    message: rawIssue.message,
  };
  // Only contract-owned guidance is exposed. In particular, do not copy Zod's
  // received value, arbitrary metadata, or candidate-authored text into hints.
  if (rawIssue.code === "invalid_type" && ["object", "array", "string", "number", "boolean", "null"].includes(String(rawIssue.expected))) {
    issue.expectedType = String(rawIssue.expected);
  }
  const fixedValue = prdFixedValue(issue, candidate);
  if (fixedValue !== undefined) issue.expectedValue = fixedValue;
  const directoryEntries = prdDirectoryEntries(issue, candidate);
  if (directoryEntries) issue.directoryEntries = directoryEntries;
  if (rawIssue.code === "custom" && isRecord(rawIssue.params) && isRecord(rawIssue.params.acceptanceCoverage)) {
    // This parameter is produced by the SSOT refinement, never by candidate
    // fields. The normalized union traversal preserves it at the exact path.
    issue.acceptanceCoverage = rawIssue.params.acceptanceCoverage as PrdAcceptanceCoverageDiagnostic;
  }
  if (rawIssue.code === "custom" && isRecord(rawIssue.params) && Array.isArray(rawIssue.params.authoredTextPaths)) {
    issue.authoredTextPaths = rawIssue.params.authoredTextPaths;
  }
  return issue;
}

function prdDirectoryEntries(issue: ValidationIssue, candidate: unknown): string[] | undefined {
  const [root, index, content, tableOfContents, entries] = issue.path;
  if (issue.code !== "custom" || root !== "artifacts" || typeof index !== "number"
    || content !== "content" || tableOfContents !== "tableOfContents" || entries !== "entries") return undefined;
  const draft = candidateArtifacts(candidate)[index];
  if (!isRecord(draft) || draft.kind !== "prd" || draft.schemaVersion !== 3 || !isRecord(draft.content)) return undefined;
  const sections = draft.content.sections;
  const business = isRecord(sections) ? sections.businessRequirements : undefined;
  const functions = isRecord(business) ? business.functionSections : undefined;
  // Zod can reach the directory refinement while the staged body still
  // contains zero functions or an invalid title. Keep its ordinary issues and
  // wait to offer a whole-directory restore until its headings are usable.
  if (!Array.isArray(functions) || functions.length < 1 || functions.length > 50 || !functions.every((section) =>
    isRecord(section) && typeof section.title === "string" && section.title.length > 0 && section.title.length <= 240,
  )) return undefined;
  return prdTableOfContentsEntriesForV3(functions.map((section) => section.title));
}

function prdFixedValue(issue: ValidationIssue, candidate: unknown): string | undefined {
  const [root, index, ...path] = issue.path;
  if (root !== "artifacts" || typeof index !== "number" || !Number.isInteger(index)) return undefined;
  const draft = candidateArtifacts(candidate)[index];
  if (!isRecord(draft) || draft.kind !== "prd" || draft.schemaVersion !== 3 || !isRecord(draft.content)) return undefined;
  if (issue.code === "invalid_literal" && JSON.stringify(path) === '["content","sections","safetyBaseline","intro"]') {
    return prdSafetyBaselineIntro;
  }
  if (issue.code !== "custom" || path.length !== 4 || path[0] !== "content"
    || path[1] !== "tableOfContents" || path[2] !== "entries" || !Number.isInteger(path[3])) return undefined;
  const entryIndex = path[3] as number;
  const sections = draft.content.sections;
  const business = isRecord(sections) ? sections.businessRequirements : undefined;
  const functionSections = isRecord(business) ? business.functionSections : undefined;
  if (!Array.isArray(functionSections)) return undefined;
  // Function headings are authored content, never fixed replacement values.
  const fixedPrefixLength = 6;
  if (entryIndex >= fixedPrefixLength && entryIndex < fixedPrefixLength + functionSections.length) return undefined;
  const fixedEntries = prdTableOfContentsEntriesForV3([]);
  const canonicalIndex = entryIndex < fixedPrefixLength ? entryIndex : entryIndex - functionSections.length;
  return fixedEntries[canonicalIndex];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readFileHandle() {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_INPUT_BYTES) throw new Error("RUNTIME_RESULT_VALIDATOR_INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function writeResult(result: {
  protocol: "workbench.runtime.validation.v1";
  ok: boolean;
  issues: ValidationIssue[];
  candidateChecksum: string | null;
  artifactChecksums: string[];
  repairHints?: unknown[];
}, preview?: string) {
  const withPreview = preview === undefined ? null : JSON.stringify({ ...result, preview });
  const body = withPreview && Buffer.byteLength(withPreview) < MAX_OUTPUT_BYTES ? withPreview : JSON.stringify(result);
  process.stdout.write(`${body}\n`);
}

function canonicalChecksum(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateArtifacts(candidate: unknown): unknown[] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  const artifacts = (candidate as { artifacts?: unknown }).artifacts;
  return Array.isArray(artifacts) ? artifacts : [];
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "RUNTIME_RESULT_VALIDATOR_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
