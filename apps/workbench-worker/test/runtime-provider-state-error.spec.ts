import {
  knownRuntimeProviderStateErrorCode,
} from "../src/runtime/runtime-provider-state-error.js";

describe("knownRuntimeProviderStateErrorCode", () => {
  it("extracts only complete allowlisted codes from direct and wrapped errors", () => {
    expect(knownRuntimeProviderStateErrorCode(
      new Error("RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR"),
    )).toBe("RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR");
    expect(knownRuntimeProviderStateErrorCode(new Error(
      "Database error: RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID (SQLSTATE 23514)",
    ))).toBe("RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID");
    expect(knownRuntimeProviderStateErrorCode(new Error(
      "RUNTIME_PROVIDER_STATE_HASH_MISMATCH_NOT_ALLOWLISTED",
    ))).toBeNull();
    expect(knownRuntimeProviderStateErrorCode(new Error(
      "RUNTIME_PROVIDER_STATE_NOT_A_REAL_CODE",
    ))).toBeNull();
  });

  it("traverses Error causes and nested Prisma metadata without looping", () => {
    const cause: Record<string, unknown> = {
      originalCode: "23514",
      originalMessage: "RUNTIME_PROVIDER_STATE_CURSOR_INVALID",
    };
    cause.self = cause;
    const causeError = Object.assign(new Error("Prisma request failed", {
      cause: new Error("query failed", { cause }),
    }), {
      code: "P2010",
    });
    const metadataError = Object.assign(new Error("Prisma request failed"), {
      code: "P2004",
      meta: {
        driverAdapterError: {
          cause: {
            originalMessage: "RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID",
          },
        },
      },
    });

    expect(knownRuntimeProviderStateErrorCode(causeError))
      .toBe("RUNTIME_PROVIDER_STATE_CURSOR_INVALID");
    expect(knownRuntimeProviderStateErrorCode(metadataError))
      .toBe("RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID");
  });

  it("ignores getters and bounds hostile metadata traversal", () => {
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, "message", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not execute");
      },
    });
    let cursor = meta;
    for (let index = 0; index < 100; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(knownRuntimeProviderStateErrorCode({ meta })).toBeNull();
    expect(knownRuntimeProviderStateErrorCode(new Proxy({}, {
      ownKeys: () => {
        throw new Error("ownKeys trap must be contained");
      },
    }))).toBeNull();
  });
});
