import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  KeyObject,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import path from "node:path";
import { canonicalJson } from "@workbench/workbench-contracts";

export const runtimeWorkerExecutionProtocol = "workbench.runtime-worker-execution.v2" as const;
export const runtimeWorkerExecutionScopeId = "production-runtime.worker-execution" as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const jobIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumPrivateKeyBytes = 64 * 1024;
const signingEnvironmentVariables = [
  "WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH",
  "WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID",
  "WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID",
  "WORKBENCH_ENVIRONMENT_ID",
  "WORKBENCH_SOURCE_COMMIT",
  "WORKBENCH_RUNTIME_WORKER_IMAGE_REF",
] as const;

export type RuntimeWorkerExecutionStatement = Readonly<{
  candidateCommit: string;
  containerHostname: string;
  environmentId: string;
  jobId: string;
  resultSha256: string;
  runtimeAttemptId: string | null;
  runtimeWorkerImageDigest: string;
  scopeId: typeof runtimeWorkerExecutionScopeId;
  signedAtUtc: string;
  signerId: string;
}>;

export type RuntimeWorkerExecutionReceipt = Readonly<{
  protocol: typeof runtimeWorkerExecutionProtocol;
  statement: RuntimeWorkerExecutionStatement;
  signature: Readonly<{
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  }>;
}>;

export type RuntimeWorkerExecutionSigner = Readonly<{
  keyId: string;
  signerId: string;
  environmentId: string;
  candidateCommit: string;
  runtimeWorkerImageDigest: string;
  attest: <T extends Record<string, unknown>>(
    result: T,
    input: RuntimeWorkerExecutionAttestationInput,
  ) => Readonly<T & { workerExecution: RuntimeWorkerExecutionReceipt }>;
}>;

export type RuntimeWorkerExecutionAttestationInput = Readonly<{
  jobId: string;
  runtimeAttemptId: string | null;
  containerHostname?: string;
  signedAtUtc?: string;
}>;

export type RuntimeWorkerExecutionSignerOptions = Readonly<{
  privateKey: KeyObject | string | Buffer;
  signerId: string;
  environmentId: string;
  candidateCommit: string;
  runtimeWorkerImageDigest: string;
  expectedKeyId?: string;
}>;

/** Creates a deterministic, side-effect-free signer for one worker deployment identity. */
export function createRuntimeWorkerExecutionSigner(
  options: RuntimeWorkerExecutionSignerOptions,
): RuntimeWorkerExecutionSigner {
  const privateKey = parseEd25519PrivateKey(options?.privateKey);
  const signerId = assertIdentifier(options?.signerId);
  const environmentId = assertIdentifier(options?.environmentId);
  const candidateCommit = assertCommit(options?.candidateCommit);
  const runtimeWorkerImageDigest = assertDigest(options?.runtimeWorkerImageDigest);
  const keyId = spkiKeyId(privateKey);
  if (options.expectedKeyId !== undefined && options.expectedKeyId !== keyId) {
    throw invalidAttestation();
  }

  return Object.freeze({
    keyId,
    signerId,
    environmentId,
    candidateCommit,
    runtimeWorkerImageDigest,
    attest<T extends Record<string, unknown>>(result: T, input: RuntimeWorkerExecutionAttestationInput) {
      if (!isRecord(result) || Object.prototype.hasOwnProperty.call(result, "workerExecution")) {
        throw invalidAttestation();
      }
      const jobId = assertJobId(input?.jobId);
      const runtimeAttemptId = assertRuntimeAttemptId(input?.runtimeAttemptId);
      const containerHostname = assertHostname(input?.containerHostname ?? systemHostname());
      const signedAtUtc = assertUtc(input?.signedAtUtc ?? new Date().toISOString());
      let resultSha256: string;
      try {
        resultSha256 = createHash("sha256").update(canonicalJson(result)).digest("hex");
      } catch {
        throw invalidAttestation();
      }
      const statement = Object.freeze({
        candidateCommit,
        containerHostname,
        environmentId,
        jobId,
        resultSha256,
        runtimeAttemptId,
        runtimeWorkerImageDigest,
        scopeId: runtimeWorkerExecutionScopeId,
        signedAtUtc,
        signerId,
      });
      const signaturePayload = canonicalJson({ protocol: runtimeWorkerExecutionProtocol, statement });
      const signature = Object.freeze({
        algorithm: "Ed25519" as const,
        keyId,
        value: sign(null, Buffer.from(signaturePayload), privateKey).toString("base64url"),
      });
      return Object.freeze({
        ...result,
        workerExecution: Object.freeze({ protocol: runtimeWorkerExecutionProtocol, statement, signature }),
      });
    },
  });
}

export async function loadRuntimeWorkerExecutionSignerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeWorkerExecutionSigner> {
  const configured = signingEnvironmentVariables.map((name) => [name, trimmed(environment[name])] as const);
  const present = configured.filter(([, value]) => value !== undefined);
  const production = trimmed(environment.NODE_ENV) === "production";
  if (production && present.length !== configured.length) throw invalidAttestation();
  if (!production && present.length === 0) {
    const ephemeral = generateKeyPairSync("ed25519");
    return createRuntimeWorkerExecutionSigner({
      privateKey: ephemeral.privateKey,
      signerId: "local-ephemeral",
      environmentId: "local",
      candidateCommit: "0".repeat(40),
      runtimeWorkerImageDigest: `sha256:${"0".repeat(64)}`,
    });
  }
  if (present.length !== configured.length) throw invalidAttestation();

  const values = Object.fromEntries(configured) as Record<(typeof signingEnvironmentVariables)[number], string>;
  const privateKey = await loadPrivateKeyFile(values.WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH);
  return createRuntimeWorkerExecutionSigner({
    privateKey,
    expectedKeyId: values.WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID,
    signerId: values.WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID,
    environmentId: values.WORKBENCH_ENVIRONMENT_ID,
    candidateCommit: values.WORKBENCH_SOURCE_COMMIT,
    runtimeWorkerImageDigest: imageDigest(values.WORKBENCH_RUNTIME_WORKER_IMAGE_REF),
  });
}

async function loadPrivateKeyFile(value: string): Promise<KeyObject> {
  if (!path.isAbsolute(value)) throw invalidAttestation();
  let metadata;
  try {
    metadata = await lstat(value);
  } catch {
    throw invalidAttestation();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumPrivateKeyBytes) {
    throw invalidAttestation();
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if ((metadata.mode & 0o077) !== 0 || (processUid !== null && metadata.uid !== processUid)) {
    throw invalidAttestation();
  }
  try {
    return parseEd25519PrivateKey(await readFile(value));
  } catch {
    throw invalidAttestation();
  }
}

function parseEd25519PrivateKey(value: KeyObject | string | Buffer | undefined): KeyObject {
  try {
    const key = value instanceof KeyObject ? value : createPrivateKey(value!);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
    return key;
  } catch {
    throw invalidAttestation();
  }
}

function spkiKeyId(privateKey: KeyObject): string {
  return `sha256:${createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex")}`;
}

function imageDigest(value: string): string {
  const match = /@(?<digest>sha256:[0-9a-f]{64})$/u.exec(value);
  if (!match?.groups?.digest) throw invalidAttestation();
  return match.groups.digest;
}

function assertIdentifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw invalidAttestation();
  return value;
}

function assertJobId(value: unknown): string {
  if (typeof value !== "string" || !jobIdPattern.test(value)) throw invalidAttestation();
  return value;
}

function assertRuntimeAttemptId(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || !jobIdPattern.test(value))) throw invalidAttestation();
  return value;
}

function assertHostname(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidAttestation();
  }
  return value;
}

function assertCommit(value: unknown): string {
  if (typeof value !== "string" || !commitPattern.test(value)) throw invalidAttestation();
  return value;
}

function assertDigest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw invalidAttestation();
  return value;
}

function assertUtc(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) throw invalidAttestation();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidAttestation();
  return value;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidAttestation(): Error {
  return new Error("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
}
