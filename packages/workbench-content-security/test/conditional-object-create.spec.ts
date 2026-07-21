import { describe, expect, it } from "vitest";

import {
  conditionalObjectCreateHeader,
  conditionalObjectCreateInput,
  isConditionalObjectCreateConflict,
  parseConditionalObjectCreateMode,
  setObjectStorageRequestHeader,
} from "../src/conditional-object-create.js";

describe("conditional object creation", () => {
  it("defaults to the portable S3 precondition and validates explicit modes", () => {
    expect(parseConditionalObjectCreateMode(undefined)).toBe("s3-if-none-match");
    expect(parseConditionalObjectCreateMode(" oss-forbid-overwrite ")).toBe("oss-forbid-overwrite");
    expect(() => parseConditionalObjectCreateMode("overwrite")).toThrow(
      "WORKBENCH_S3_CONDITIONAL_CREATE_MODE",
    );
    expect(conditionalObjectCreateInput("s3-if-none-match")).toEqual({ IfNoneMatch: "*" });
    expect(conditionalObjectCreateInput("oss-forbid-overwrite")).toEqual({});
  });

  it("adds the OSS create-only header before request signing", () => {
    const header = conditionalObjectCreateHeader("oss-forbid-overwrite");
    expect(header).toEqual({ name: "x-oss-forbid-overwrite", value: "true" });
    const request = { headers: { host: "bucket.oss.example.test" } };
    setObjectStorageRequestHeader(request, header!);
    expect(request.headers).toEqual({
      host: "bucket.oss.example.test",
      "x-oss-forbid-overwrite": "true",
    });
    expect(() => setObjectStorageRequestHeader({}, header!)).toThrow(
      "OBJECT_STORAGE_HTTP_REQUEST_UNAVAILABLE",
    );
  });

  it("recognizes only S3 precondition and OSS create-conflict responses", () => {
    expect(isConditionalObjectCreateConflict({
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    })).toBe(true);
    expect(isConditionalObjectCreateConflict({
      name: "FileAlreadyExists",
      Code: "FileAlreadyExists",
      $metadata: { httpStatusCode: 409 },
    })).toBe(true);
    expect(isConditionalObjectCreateConflict({
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    })).toBe(false);
    expect(isConditionalObjectCreateConflict({
      name: "Conflict",
      $metadata: { httpStatusCode: 409 },
    })).toBe(false);
  });
});
