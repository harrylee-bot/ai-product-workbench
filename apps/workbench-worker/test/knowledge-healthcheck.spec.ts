import {
  assertKnowledgeToolHealth,
  knowledgeToolIsRequired,
} from "../src/knowledge-healthcheck.js";

describe("Runtime Worker Knowledge health", () => {
  it("does not require a Knowledge tool before any release is serviceable", async () => {
    const db = database(null);

    await expect(knowledgeToolIsRequired(db as never)).resolves.toBe(false);
    expect(() => assertKnowledgeToolHealth({ knowledgeTool: null }, false)).not.toThrow();
  });

  it("fails closed when a ready or active-Run-pinned release has no Knowledge tool", async () => {
    const db = database({ id: "release_1" });

    await expect(knowledgeToolIsRequired(db as never)).resolves.toBe(true);
    expect(db.knowledgeRelease.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: "ready" },
          {
            runs: {
              some: {
                status: { in: ["queued", "running", "waiting_input", "cancelling"] },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    expect(() => assertKnowledgeToolHealth({ knowledgeTool: null }, true))
      .toThrow("KNOWLEDGE_TOOL_REQUIRED_FOR_SERVICEABLE_RELEASE");
  });

  it("accepts a configured capability when Knowledge serviceability requires it", () => {
    expect(() => assertKnowledgeToolHealth({
      knowledgeTool: {
        endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
        secret: Buffer.alloc(32, 7),
        maximumTtlSeconds: 900,
      },
    }, true)).not.toThrow();
  });
});

function database(result: { id: string } | null) {
  return {
    knowledgeRelease: {
      findFirst: vi.fn().mockResolvedValue(result),
    },
  };
}
