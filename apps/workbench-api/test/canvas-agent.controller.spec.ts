import { StreamableFile } from "@nestjs/common";

import { CanvasAgentController } from "../src/modules/canvas-agent/canvas-agent.controller.js";

describe("CanvasAgentController visual capability", () => {
  it("returns a no-store image response with immutable integrity headers", async () => {
    const expiresAt = new Date("2026-07-19T12:00:00.000Z");
    const body = Buffer.from("visual-bytes");
    const getVisual = vi.fn().mockResolvedValue({
      body,
      mediaType: "image/webp",
      byteSize: body.byteLength,
      etag: '"sha256-visual"',
      sha256: "a".repeat(64),
      capabilityExpiresAt: expiresAt,
      notModified: false,
    });
    const response = responseFixture();
    const controller = new CanvasAgentController({ getVisual } as never);

    const result = await controller.getVisual(
      "Bearer command-bound-token",
      "visual_1",
      undefined,
      response.value as never,
    );

    expect(getVisual).toHaveBeenCalledWith("Bearer command-bound-token", "visual_1", undefined);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(response.headers).toEqual(new Map([
      ["Cache-Control", "no-store, private"],
      ["Content-Type", "image/webp"],
      ["Content-Length", String(body.byteLength)],
      ["ETag", '"sha256-visual"'],
      ["X-Content-SHA256", "a".repeat(64)],
      ["X-Canvas-Visual-Expires-At", expiresAt.toISOString()],
    ]));
    expect(response.status).not.toHaveBeenCalled();
  });

  it("returns 304 without materializing a response body", async () => {
    const getVisual = vi.fn().mockResolvedValue({
      body: undefined,
      mediaType: "image/webp",
      byteSize: 128,
      etag: '"sha256-visual"',
      sha256: "b".repeat(64),
      capabilityExpiresAt: new Date("2026-07-19T12:00:00.000Z"),
      notModified: true,
    });
    const response = responseFixture();
    const controller = new CanvasAgentController({ getVisual } as never);

    await expect(controller.getVisual(
      "Bearer command-bound-token",
      "visual_1",
      '"sha256-visual"',
      response.value as never,
    )).resolves.toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(304);
  });
});

function responseFixture() {
  const headers = new Map<string, string>();
  const status = vi.fn();
  return {
    headers,
    status,
    value: {
      setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
      status,
    },
  };
}
