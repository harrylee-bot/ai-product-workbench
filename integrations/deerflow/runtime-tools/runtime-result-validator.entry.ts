import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/workbench-contracts/src/canonical-json.js";
import {
  assertPrototypePatchPayloadSize,
  runtimePrototypePatchInputSchema,
} from "../../../packages/workbench-contracts/src/prototype-patches.js";
import {
  runtimeResultSchema,
} from "../../../packages/workbench-contracts/src/runtime.js";

const MAX_INPUT_BYTES = 2_000_000;
const MAX_ISSUES = 100;

type ValidationIssue = {
  code: string;
  path: Array<string | number>;
  message: string;
};

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
  const candidateChecksum = canonicalChecksum(candidate);
  const artifactChecksums = mode === "runtime-result"
    ? candidateArtifacts(candidate).map(canonicalChecksum)
    : [];
  const schema = mode === "runtime-result"
    ? runtimeResultSchema
    : mode === "prototype-patch"
      ? runtimePrototypePatchInputSchema
      : null;
  if (!schema) throw new Error("RUNTIME_RESULT_VALIDATOR_MODE_INVALID");
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
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
  return writeResult({
    protocol: "workbench.runtime.validation.v1",
    ok: false,
    candidateChecksum,
    artifactChecksums,
    issues: parsed.error.issues.slice(0, MAX_ISSUES).map((issue): ValidationIssue => ({
      code: issue.code,
      path: issue.path,
      message: issue.message,
    })),
  });
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
}) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
