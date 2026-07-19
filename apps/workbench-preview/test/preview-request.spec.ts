import { describe, expect, it, vi } from "vitest";

import { preparePreviewResponse } from "../src/preview-request.js";

describe("preparePreviewResponse", () => {
  it("does not materialize the HTML body for HEAD", async () => {
    const service = previewService();

    await expect(preparePreviewResponse(service as never, {
      token: "preview-token",
      method: "HEAD",
    })).resolves.toEqual({ status: 200, etag: '"manifest-etag"', head: true });
    expect(service.resolve).toHaveBeenCalledOnce();
    expect(service.render).not.toHaveBeenCalled();
  });

  it("does not materialize the HTML body for a matching conditional GET", async () => {
    const service = previewService();

    await expect(preparePreviewResponse(service as never, {
      token: "preview-token",
      method: "GET",
      ifNoneMatch: '"other", W/"manifest-etag"',
    })).resolves.toEqual({ status: 304, etag: '"manifest-etag"' });
    expect(service.resolve).toHaveBeenCalledOnce();
    expect(service.render).not.toHaveBeenCalled();
  });

  it("renders only an unconditional or changed GET", async () => {
    const service = previewService();

    const result = await preparePreviewResponse(service as never, {
      token: "preview-token",
      method: "GET",
      ifNoneMatch: '"stale"',
    });

    expect(result).toMatchObject({ status: 200, etag: '"manifest-etag"', head: false });
    expect(service.render).toHaveBeenCalledOnce();
  });
});

function previewService() {
  const resolved = {
    capabilityToken: "preview-token",
    identity: {
      storageKey: "blobs/html",
      mediaType: "text/html",
      byteSize: 50 * 1024 * 1024,
      sha256: "a".repeat(64),
    },
    etag: '"manifest-etag"',
  };
  return {
    resolve: vi.fn(async () => resolved),
    render: vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      etag: resolved.etag,
      contentSecurityPolicy: "default-src 'none'",
    })),
  };
}
