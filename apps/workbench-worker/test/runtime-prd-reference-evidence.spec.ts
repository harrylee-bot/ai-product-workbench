import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assertPrdReferenceReadEvidence,
  PRD_RUNTIME_REFERENCE_FILES,
  type PrdReferenceEvidenceBoundaries,
} from "../src/runtime/runtime-prd-reference-evidence.js";

const SANDBOX_ROOT = "/mnt/skills/public/workbench";
const referenceContent = new Map(PRD_RUNTIME_REFERENCE_FILES.map((reference) => [
  reference.relativePath,
  readFileSync(new URL(
    `../../../integrations/deerflow/skills/workbench/${reference.relativePath}`,
    import.meta.url,
  ), "utf8"),
]));

type Fixture = {
  state: { messages: unknown[] };
  boundaries: PrdReferenceEvidenceBoundaries;
};

describe("PRD Runtime reference evidence", () => {
  it("accepts exactly one verified read of every pinned reference across DeerFlow path shapes", () => {
    const fixture = validFixture();
    const messages = fixture.state.messages as Array<Record<string, unknown>>;
    const qualityCall = messages.find((message) => (
      JSON.stringify(message.tool_calls ?? []).includes("read-reference-1")
    ));
    const qualityToolCall = (qualityCall?.tool_calls as Array<Record<string, unknown>>)[0]!;
    qualityToolCall.args = {
      description: "Read quality rules",
      path: "/mnt/skills/public/workbench/references/requirement-doc-template/./quality-standards.md",
    };
    const exampleCall = messages.find((message) => (
      JSON.stringify(message.tool_calls ?? []).includes("read-reference-2")
    ));
    const exampleToolCall = (exampleCall?.tool_calls as Array<Record<string, unknown>>)[0]!;
    delete exampleToolCall.name;
    delete exampleToolCall.args;
    exampleToolCall.function = {
      name: "read_file",
      arguments: JSON.stringify({
        description: "Read complete envelope",
        path: "/mnt/skills/public/workbench/references/requirement-doc-template/../prd-runtime-result.example.json",
      }),
    };
    const exampleResponse = messages.find((message) => message.tool_call_id === "read-reference-2")!;
    const exampleContent = exampleResponse.content as string;
    exampleResponse.content = [
      { type: "text", text: exampleContent.slice(0, 10_000) },
      { type: "text", text: exampleContent.slice(10_000) },
    ];

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries)).not.toThrow();
  });

  it("accepts LangChain constructor messages whose fields are serialized under kwargs", () => {
    const fixture = validFixture();
    fixture.state.messages = fixture.state.messages.map((messageValue) => {
      const message = messageValue as Record<string, unknown>;
      if (message.type === "human") {
        return {
          lc: 1,
          type: "constructor",
          id: ["langchain", "schema", "messages", "HumanMessage"],
          kwargs: { content: message.content },
        };
      }
      if (message.type === "ai") {
        return {
          lc: 1,
          type: "constructor",
          id: ["langchain", "schema", "messages", "AIMessage"],
          kwargs: { content: message.content, tool_calls: message.tool_calls },
        };
      }
      return {
        lc: 1,
        type: "constructor",
        id: ["langchain", "schema", "messages", "ToolMessage"],
        kwargs: {
          content: message.content,
          name: message.name,
          status: message.status,
          tool_call_id: message.tool_call_id,
        },
      };
    });

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries)).not.toThrow();
  });

  it("accepts standard OpenAI tool responses that omit the optional tool name", () => {
    const fixture = validFixture();
    for (const messageValue of fixture.state.messages) {
      const message = messageValue as Record<string, unknown>;
      if (message.type === "tool") delete message.name;
    }

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries)).not.toThrow();
  });

  it("rejects a missing or duplicate required read", () => {
    const missing = validFixture();
    missing.state.messages = missing.state.messages.filter((message) => (
      !JSON.stringify(message).includes("read-reference-2")
    ));
    expect(() => assertPrdReferenceReadEvidence(missing.state, missing.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_MISSING");

    const duplicate = validFixture();
    const structuringIndex = duplicate.boundaries.structuringDeclarationIndex;
    duplicate.state.messages.splice(
      structuringIndex,
      0,
      ...referenceReadPair(PRD_RUNTIME_REFERENCE_FILES[0], "read-reference-duplicate"),
    );
    expect(() => assertPrdReferenceReadEvidence(duplicate.state, {
      ...duplicate.boundaries,
      structuringDeclarationIndex: duplicate.boundaries.structuringDeclarationIndex + 2,
      draftingDeclarationIndex: duplicate.boundaries.draftingDeclarationIndex + 2,
      artifactDeclarationIndex: duplicate.boundaries.artifactDeclarationIndex + 2,
    })).toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_DUPLICATE");
  });

  it("allows a failed, wrong-root, or ranged attempt to be corrected by one verified read", () => {
    const retries = [
      (() => {
        const pair = referenceReadPair(PRD_RUNTIME_REFERENCE_FILES[0], "failed-reference-retry");
        (pair[1] as Record<string, unknown>).status = "error";
        (pair[1] as Record<string, unknown>).content = "Error: retry with the complete reference";
        return { pair, beforeCollecting: true };
      })(),
      (() => {
        const pair = referenceReadPair(PRD_RUNTIME_REFERENCE_FILES[0], "wrong-root-reference-retry");
        const declaration = pair[0] as { tool_calls: Array<{ args: { path: string } }> };
        declaration.tool_calls[0]!.args.path =
          "/app/skills/public/workbench/references/requirement-doc-template/structure.md";
        (pair[1] as Record<string, unknown>).status = "error";
        (pair[1] as Record<string, unknown>).content = "Error: use the /mnt skill path";
        return { pair, beforeCollecting: false };
      })(),
      (() => {
        const pair = referenceReadPair(PRD_RUNTIME_REFERENCE_FILES[0], "ranged-reference-retry");
        const declaration = pair[0] as {
          tool_calls: Array<{ args: Record<string, unknown> }>;
        };
        declaration.tool_calls[0]!.args.start_line = 1;
        declaration.tool_calls[0]!.args.end_line = 10;
        (pair[1] as Record<string, unknown>).content = referenceContent
          .get(PRD_RUNTIME_REFERENCE_FILES[0].relativePath)!
          .split("\n")
          .slice(0, 10)
          .join("\n");
        return { pair, beforeCollecting: false };
      })(),
    ];

    for (const retry of retries) {
      const fixture = validFixture();
      const firstValidRead = declarationIndex(fixture.state.messages, "read-reference-0");
      fixture.state.messages.splice(retry.beforeCollecting ? 1 : firstValidRead, 0, ...retry.pair);
      const shiftedBoundaries = {
        ...fixture.boundaries,
        collectingResponseIndex: fixture.boundaries.collectingResponseIndex
          + (retry.beforeCollecting ? 2 : 0),
        structuringDeclarationIndex: fixture.boundaries.structuringDeclarationIndex + 2,
        draftingDeclarationIndex: fixture.boundaries.draftingDeclarationIndex + 2,
        artifactDeclarationIndex: fixture.boundaries.artifactDeclarationIndex + 2,
      };

      expect(() => assertPrdReferenceReadEvidence(fixture.state, shiftedBoundaries)).not.toThrow();
    }
  });

  it("rejects a matching reference suffix under an untrusted root", () => {
    const fixture = validFixture();
    replaceReferencePath(
      fixture,
      "structure.md",
      "/mnt/user-data/uploads/references/requirement-doc-template/structure.md",
    );

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_PATH_INVALID");
  });

  it("rejects ranged reads even when their response happens to contain the complete file", () => {
    const fixture = validFixture();
    const declaration = fixture.state.messages.find((message) => (
      JSON.stringify(message).includes("read-reference-0")
    )) as { tool_calls: Array<{ args: Record<string, unknown> }> };
    declaration.tool_calls[0]!.args.start_line = 1;
    declaration.tool_calls[0]!.args.end_line = 100_000;

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_RANGE_INVALID");
  });

  it("requires one matching ToolMessage for every declared reference read", () => {
    const missing = validFixture();
    missing.state.messages = missing.state.messages.filter((message) => (
      !(message as Record<string, unknown>).tool_call_id
      || (message as Record<string, unknown>).tool_call_id !== "read-reference-1"
    ));
    expect(() => assertPrdReferenceReadEvidence(missing.state, missing.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_TOOL_MESSAGE_MISSING");

    const multiple = validFixture();
    const response = multiple.state.messages.find((message) => (
      (message as Record<string, unknown>).tool_call_id === "read-reference-1"
    ));
    multiple.state.messages.splice(
      multiple.boundaries.structuringDeclarationIndex,
      0,
      structuredClone(response),
    );
    expect(() => assertPrdReferenceReadEvidence(multiple.state, {
      ...multiple.boundaries,
      structuringDeclarationIndex: multiple.boundaries.structuringDeclarationIndex + 1,
      draftingDeclarationIndex: multiple.boundaries.draftingDeclarationIndex + 1,
      artifactDeclarationIndex: multiple.boundaries.artifactDeclarationIndex + 1,
    })).toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_TOOL_MESSAGE_MULTIPLE");
  });

  it("rejects failed reads and tool-error text even when LangChain omits an error status", () => {
    const failed = validFixture();
    const failedResponse = readResponse(failed, "read-reference-0");
    failedResponse.status = "error";
    expect(() => assertPrdReferenceReadEvidence(failed.state, failed.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_FAILED");

    const errorText = validFixture();
    readResponse(errorText, "read-reference-0").content = "Error: File not found";
    expect(() => assertPrdReferenceReadEvidence(errorText.state, errorText.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_FAILED");
  });

  it("rejects reference content that does not match the pinned SHA-256", () => {
    const fixture = validFixture();
    readResponse(fixture, "read-reference-0").content += "\nchanged";

    expect(() => assertPrdReferenceReadEvidence(fixture.state, fixture.boundaries))
      .toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_CONTENT_INVALID");
  });

  it("rejects reads before collecting or after structuring begins", () => {
    const beforeCollecting = validFixture();
    expect(() => assertPrdReferenceReadEvidence(beforeCollecting.state, {
      ...beforeCollecting.boundaries,
      collectingResponseIndex: beforeCollecting.boundaries.structuringDeclarationIndex - 1,
    })).toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_ORDER_INVALID");

    const afterStructuring = validFixture();
    expect(() => assertPrdReferenceReadEvidence(afterStructuring.state, {
      ...afterStructuring.boundaries,
      structuringDeclarationIndex: afterStructuring.boundaries.collectingResponseIndex + 1,
    })).toThrow("RUNTIME_ARTIFACT_PRD_REFERENCE_ORDER_INVALID");
  });
});

function validFixture(): Fixture {
  const messages = [
    { type: "human", content: "current PRD turn" },
    ...toolPair("workbench_generation_stage_update", "collecting-stage", {}, "ok"),
    ...PRD_RUNTIME_REFERENCE_FILES.flatMap((reference, index) => (
      referenceReadPair(reference, `read-reference-${index}`)
    )),
    ...toolPair("workbench_generation_stage_update", "structuring-stage", {}, "ok"),
    ...toolPair("workbench_generation_stage_update", "drafting-stage", {}, "ok"),
    ...toolPair("workbench_artifact_draft_publish", "prd-checkpoint", {}, "ok"),
  ];
  return {
    state: { messages },
    boundaries: {
      collectingResponseIndex: responseIndex(messages, "collecting-stage"),
      structuringDeclarationIndex: declarationIndex(messages, "structuring-stage"),
      draftingDeclarationIndex: declarationIndex(messages, "drafting-stage"),
      artifactDeclarationIndex: declarationIndex(messages, "prd-checkpoint"),
    },
  };
}

function referenceReadPair(
  reference: (typeof PRD_RUNTIME_REFERENCE_FILES)[number],
  toolCallId: string,
) {
  return toolPair(
    "read_file",
    toolCallId,
    {
      description: `Read ${reference.relativePath}`,
      path: `${SANDBOX_ROOT}/${reference.relativePath}`,
    },
    referenceContent.get(reference.relativePath)!,
  );
}

function toolPair(
  name: string,
  toolCallId: string,
  args: Record<string, unknown>,
  content: string,
) {
  return [
    {
      type: "ai",
      content: "",
      tool_calls: [{ id: toolCallId, name, args }],
    },
    {
      type: "tool",
      name,
      tool_call_id: toolCallId,
      content,
      status: "success",
    },
  ];
}

function replaceReferencePath(fixture: Fixture, suffix: string, path: string) {
  const declaration = fixture.state.messages.find((message) => JSON.stringify(message).includes(suffix)) as {
    tool_calls: Array<{ args: { path: string } }>;
  };
  declaration.tool_calls[0]!.args.path = path;
}

function readResponse(fixture: Fixture, toolCallId: string) {
  return fixture.state.messages.find((message) => (
    (message as Record<string, unknown>).tool_call_id === toolCallId
  )) as Record<string, unknown>;
}

function declarationIndex(messages: unknown[], toolCallId: string) {
  return messages.findIndex((message) => JSON.stringify(message).includes(`\"id\":\"${toolCallId}\"`));
}

function responseIndex(messages: unknown[], toolCallId: string) {
  return messages.findIndex((message) => (
    (message as Record<string, unknown>).tool_call_id === toolCallId
  ));
}
