import { describe, expect, it } from "vitest";

import { prototypeEditorDocumentFixture } from "../prototype-editor/test-fixtures";
import { prototypeDocumentEditIdempotencyKey } from "./prototype-edit";

describe("prototype edit idempotency", () => {
  it("is stable for one immutable base and canonical document", () => {
    const document = prototypeEditorDocumentFixture();
    const key = prototypeDocumentEditIdempotencyKey("version-1", document);

    expect(key).toMatch(/^prototype-edit:version-1:1:[a-f0-9]{8}$/);
    expect(prototypeDocumentEditIdempotencyKey("version-1", structuredClone(document))).toBe(key);
    expect(prototypeDocumentEditIdempotencyKey("version-2", document)).not.toBe(key);
  });
});
