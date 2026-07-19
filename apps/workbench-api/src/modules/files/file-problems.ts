import { HttpStatus } from "@nestjs/common";
import { ProblemException } from "../../common/problem-details.js";

export function fileStateConflictProblem(detail: string, code = "FILE_STATE_CONFLICT") {
  return new ProblemException({
    title: "File state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}

export function uploadStateConflictProblem(detail: string, code = "UPLOAD_STATE_CONFLICT") {
  return new ProblemException({
    title: "Upload state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}
