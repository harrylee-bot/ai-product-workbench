import { HttpStatus } from "@nestjs/common";
import { ProblemException } from "../../common/problem-details.js";

export function canvasUnavailableProblem(detail = "Canvas tool capability verification is not configured") {
  return new ProblemException({
    title: "Canvas tools unavailable",
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail,
    code: "CANVAS_TOOL_NOT_CONFIGURED",
  });
}

export function canvasUnauthorizedProblem() {
  return new ProblemException({
    title: "Canvas capability unauthorized",
    status: HttpStatus.UNAUTHORIZED,
    detail: "The Canvas tool capability is invalid, expired, or revoked",
    code: "CANVAS_TOOL_GRANT_UNAUTHORIZED",
  });
}

export function canvasScopeProblem(detail = "The Canvas tool capability scope is no longer valid") {
  return new ProblemException({
    title: "Canvas capability scope invalid",
    status: HttpStatus.NOT_FOUND,
    detail,
    code: "CANVAS_TOOL_SCOPE_INVALID",
  });
}

export function canvasInvocationConflictProblem(detail = "The Canvas tool invocation is already in progress") {
  return new ProblemException({
    title: "Canvas invocation conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "CANVAS_TOOL_INVOCATION_CONFLICT",
  });
}

export function canvasCommandConflictProblem(detail = "The Canvas client command cannot be acknowledged in its current state") {
  return new ProblemException({
    title: "Canvas command conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code: "CANVAS_CLIENT_COMMAND_CONFLICT",
  });
}

export function canvasRevisionProblem(detail = "The Canvas snapshot is stale") {
  return new ProblemException({
    title: "Canvas revision conflict",
    status: HttpStatus.PRECONDITION_FAILED,
    detail,
    code: "CANVAS_REVISION_MISMATCH",
  });
}

export function canvasReadonlyProblem() {
  return new ProblemException({
    title: "Canvas mutation forbidden",
    status: HttpStatus.FORBIDDEN,
    detail: "The current Canvas capability does not permit mutations",
    code: "CANVAS_READONLY",
  });
}

export function canvasToolValidationProblem(code: string, detail: string, status = HttpStatus.BAD_REQUEST) {
  return new ProblemException({
    title: "Invalid Canvas tool request",
    status,
    detail,
    code,
  });
}
