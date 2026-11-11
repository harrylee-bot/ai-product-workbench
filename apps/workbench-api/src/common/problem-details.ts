import { HttpException, HttpStatus } from "@nestjs/common";
import type { ProblemDetails } from "@workbench/workbench-contracts";

export class ProblemException extends HttpException {
  constructor(problem: Omit<ProblemDetails, "type"> & { type?: string }) {
    super({ type: "about:blank", ...problem }, problem.status);
  }
}

export function validationProblem(detail: string, errors?: Record<string, string[]>) {
  return new ProblemException({
    title: "Invalid request",
    status: HttpStatus.BAD_REQUEST,
    detail,
    code: "VALIDATION_ERROR",
    errors,
  });
}

export function sourcePrototypeBuildProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Source prototype build failed",
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    detail,
    code,
  });
}

export function notFoundProblem(resource: string) {
  return new ProblemException({
    title: "Resource not found",
    status: HttpStatus.NOT_FOUND,
    detail: `${resource} was not found`,
    code: "RESOURCE_NOT_FOUND",
  });
}

export function forbiddenProblem() {
  return new ProblemException({
    title: "Forbidden",
    status: HttpStatus.FORBIDDEN,
    detail: "The current principal cannot access this resource",
    code: "FORBIDDEN",
  });
}

export function preconditionRequiredProblem() {
  return new ProblemException({
    title: "Precondition required",
    status: HttpStatus.PRECONDITION_REQUIRED,
    detail: "This mutation requires a valid If-Match header",
    code: "IF_MATCH_REQUIRED",
  });
}

export function revisionConflictProblem() {
  return new ProblemException({
    title: "Precondition failed",
    status: HttpStatus.PRECONDITION_FAILED,
    detail: "The resource changed after it was read",
    code: "REVISION_MISMATCH",
  });
}

export function idempotencyConflictProblem() {
  return new ProblemException({
    title: "Idempotency conflict",
    status: HttpStatus.CONFLICT,
    detail: "The Idempotency-Key was already used with a different request",
    code: "IDEMPOTENCY_KEY_REUSED",
  });
}

export function artifactVersionWriteConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Artifact version conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function artifactCreationConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Artifact creation conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function prototypePatchCheckpointConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Prototype patch checkpoint conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function activeRunConflictProblem(runId: string) {
  return new ProblemException({
    title: "Run conflict",
    status: HttpStatus.CONFLICT,
    detail: `Thread already has an active Run: ${runId}`,
    code: "THREAD_HAS_ACTIVE_RUN",
  });
}

export function runStateConflictProblem(status: string) {
  return new ProblemException({
    title: "Run state conflict",
    status: HttpStatus.CONFLICT,
    detail: `The command is not valid while the Run is ${status}`,
    code: "RUN_STATE_CONFLICT",
  });
}

export function runRetryConflictProblem(detail: string) {
  return new ProblemException({
    title: "Run retry conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "RUN_RETRY_NOT_ALLOWED",
  });
}

export function runImportSourceStateConflictProblem() {
  return new ProblemException({
    title: "Run import source state conflict",
    status: HttpStatus.CONFLICT,
    detail: "One or more Import Sources are missing, deleted, or not ready",
    code: "RUN_IMPORT_SOURCE_NOT_READY",
  });
}

export function runDesignStyleStateConflictProblem() {
  return new ProblemException({
    title: "Run design style conflict",
    status: HttpStatus.CONFLICT,
    detail: "The selected Design System version is not a valid immutable runtime source",
    code: "RUN_DESIGN_STYLE_INVALID",
  });
}

export function submissionIntentStateConflictProblem(detail: string, code = "SUBMISSION_INTENT_STATE_CONFLICT") {
  return new ProblemException({
    title: "Submission intent conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function designPresetSelectionProblem(
  code: string,
  detail: string,
  errors: Record<string, string[]>,
) {
  return new ProblemException({
    title: "Invalid design preset",
    status: HttpStatus.BAD_REQUEST,
    detail,
    code,
    errors,
  });
}

export function designSystemImportConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Design System import conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function designSystemCreationConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Design System creation conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function threadStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Thread state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "THREAD_STATE_CONFLICT",
  });
}

export function projectStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Project state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "PROJECT_STATE_CONFLICT",
  });
}

export function projectInvitationStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Project invitation conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "PROJECT_INVITATION_STATE_CONFLICT",
  });
}

export function releaseStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Project release state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "PROJECT_RELEASE_STATE_CONFLICT",
  });
}

export function shareStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Share state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "SHARE_STATE_CONFLICT",
  });
}

export function exportStateConflictProblem(detail: string) {
  return new ProblemException({
    title: "Export state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "EXPORT_STATE_CONFLICT",
  });
}

export function approvalStateConflictProblem(status: string) {
  return new ProblemException({
    title: "Approval state conflict",
    status: HttpStatus.CONFLICT,
    detail: `The approval cannot be decided while it is ${status}`,
    code: "APPROVAL_STATE_CONFLICT",
  });
}

export function runtimeModelCatalogUnavailableProblem() {
  return new ProblemException({
    title: "Runtime model catalog unavailable",
    status: HttpStatus.BAD_GATEWAY,
    detail: "The runtime model catalog could not be loaded",
    code: "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
  });
}

export function runtimeModelCatalogTimeoutProblem() {
  return new ProblemException({
    title: "Runtime model catalog timeout",
    status: HttpStatus.GATEWAY_TIMEOUT,
    detail: "The runtime model catalog did not respond before the deadline",
    code: "RUNTIME_MODEL_CATALOG_TIMEOUT",
  });
}

export function runtimeModelNotFoundProblem() {
  return new ProblemException({
    title: "Invalid runtime model",
    status: HttpStatus.BAD_REQUEST,
    detail: "The selected runtime model is not present in the current DeerFlow catalog",
    code: "RUNTIME_MODEL_NOT_FOUND",
  });
}

export function knowledgeGrantUnauthorizedProblem() {
  return new ProblemException({
    title: "Invalid Knowledge capability",
    status: HttpStatus.UNAUTHORIZED,
    detail: "The Knowledge retrieval capability is missing, invalid, or expired",
    code: "KNOWLEDGE_TOOL_GRANT_INVALID",
  });
}

export function knowledgeRetrievalUnavailableProblem(code: string, detail: string, status = HttpStatus.SERVICE_UNAVAILABLE) {
  return new ProblemException({
    title: "Knowledge retrieval unavailable",
    status,
    detail,
    code,
  });
}

export function knowledgeInvocationConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Knowledge invocation conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function knowledgeProfileStateConflictProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Knowledge Profile state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function knowledgeQuotaProblem(code: string, detail: string) {
  return new ProblemException({
    title: "Knowledge retrieval limit reached",
    status: HttpStatus.TOO_MANY_REQUESTS,
    detail,
    code,
  });
}
