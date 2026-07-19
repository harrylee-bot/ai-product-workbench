import { HttpStatus } from "@nestjs/common";
import { ProblemException } from "../../common/problem-details.js";

export function objectStorageUnavailableProblem() {
  return new ProblemException({
    title: "Object storage unavailable",
    status: HttpStatus.BAD_GATEWAY,
    detail: "The object store could not complete the request",
    code: "OBJECT_STORAGE_UNAVAILABLE",
  });
}
