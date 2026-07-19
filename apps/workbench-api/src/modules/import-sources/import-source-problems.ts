import { HttpStatus } from "@nestjs/common";
import { ProblemException } from "../../common/problem-details.js";

export function importSourceStateConflictProblem(detail: string, code = "IMPORT_SOURCE_STATE_CONFLICT") {
  return new ProblemException({
    title: "Import source state conflict",
    status: HttpStatus.CONFLICT,
    detail,
    code,
  });
}
