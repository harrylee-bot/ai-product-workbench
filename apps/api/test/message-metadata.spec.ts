import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantMetadataForOutput,
  sanitizeAssistantMetadataForPersistence,
  sanitizeAssistantParts,
} from "../src/conversations/message-metadata";
import { buildMessagePayload } from "../src/modules/aichat-data/dto";

describe("assistant message metadata", () => {
  const unsafeParts = [
    { type: "reasoning", text: "hidden chain of thought" },
    {
      type: "dynamic-tool",
      toolCallId: "read-1",
      toolName: "read_file",
      state: "output-available",
      input: { path: "SKILL.md" },
      output: "complete runtime skill contents",
    },
    {
      type: "dynamic-tool",
      toolCallId: "todos-1",
      toolName: "write_todos",
      state: "output-available",
      output: "Updated todo list",
    },
    {
      type: "dynamic-tool",
      toolCallId: "write-1",
      toolName: "write_file",
      state: "output-available",
      output: "secret artifact source",
    },
    { type: "text", text: "PRD 和原型已生成", providerMetadata: { hidden: true } },
    {
      type: "tool-createDocument",
      toolCallId: "prd-document-1",
      state: "output-available",
      input: { title: "签到 PRD", kind: "text", prompt: "hidden prompt" },
      output: {
        id: "prd-1",
        title: "签到 PRD",
        kind: "text",
        content: "full document body must not be duplicated into parts",
      },
    },
  ];

  it("keeps only visible text and a bounded createDocument protocol", () => {
    expect(sanitizeAssistantParts(unsafeParts)).toEqual([
      { type: "text", text: "PRD 和原型已生成" },
      {
        type: "tool-createDocument",
        toolCallId: "prd-document-1",
        state: "output-available",
        input: { title: "签到 PRD", kind: "text" },
        output: { id: "prd-1", title: "签到 PRD", kind: "text" },
      },
    ]);
  });

  it("removes hidden reasoning from persisted and returned assistant metadata", () => {
    const metadata = {
      source: "aichat",
      reasoningText: "private model reasoning",
      finalAction: { message: "visible", hiddenPrompt: "system prompt" },
      arbitraryToolOutput: { output: "complete runtime skill" },
      parts: unsafeParts,
    };

    for (const sanitized of [
      sanitizeAssistantMetadataForPersistence(metadata),
      sanitizeAssistantMetadataForOutput(metadata),
    ]) {
      expect(sanitized).not.toHaveProperty("reasoningText");
      expect(JSON.stringify(sanitized)).not.toMatch(
        /read_file|write_file|write_todos|runtime skill|chain of thought|hidden prompt|system prompt|full document body|arbitraryToolOutput|finalAction/,
      );
      expect(sanitized).toMatchObject({ source: "aichat" });
    }
  });

  it("keeps only bounded user-visible runtime event fields", () => {
    const sanitized = sanitizeAssistantMetadataForPersistence({
      runtimeEvents: [
        {
          id: "event-1",
          runId: "run-1",
          kind: "knowledge",
          label: "已用知识库打底",
          detail: "文档规范已命中",
          status: "completed",
          createdAt: "2026-07-11T00:00:00.000Z",
          rawToolOutput: "secret",
        },
        {
          id: "event-2",
          kind: "error",
          label: "生成失败",
          detail: "read_file /Users/private/SKILL.md failed",
          status: "failed",
          createdAt: "2026-07-11T00:00:01.000Z",
        },
      ],
    });

    expect(sanitized).toEqual({
      runtimeEvents: [
        {
          id: "event-1",
          runId: "run-1",
          kind: "knowledge",
          label: "已用知识库打底",
          detail: "文档规范已命中",
          status: "completed",
          createdAt: "2026-07-11T00:00:00.000Z",
        },
        {
          id: "event-2",
          kind: "error",
          label: "生成失败",
          status: "failed",
          createdAt: "2026-07-11T00:00:01.000Z",
        },
      ],
    });
  });

  it("drops a malformed non-array parts payload", () => {
    expect(
      sanitizeAssistantMetadataForPersistence({
        source: "aichat",
        parts: { output: "complete runtime skill" },
      }),
    ).toEqual({ source: "aichat" });
  });

  it("drops non-object assistant metadata instead of returning an untrusted payload", () => {
    expect(sanitizeAssistantMetadataForPersistence([unsafeParts])).toEqual({});
    expect(sanitizeAssistantMetadataForOutput([unsafeParts])).toEqual({});
    expect(sanitizeAssistantMetadataForPersistence("read_file hidden output")).toEqual({});
  });

  it("does not alter ordinary user message parts", () => {
    const userParts = [
      { type: "text", text: "请读取附件" },
      { type: "file", mediaType: "text/plain", url: "/files/1" },
      { type: "data-client-context", data: { source: "composer" } },
    ];
    const payload = buildMessagePayload(
      { role: "user", parts: userParts },
      "conversation-1",
      "user-1",
    );

    expect(payload.content).toBe("请读取附件");
    expect(payload.metadata).toEqual({ parts: userParts });
  });

  it("applies the allowlist to assistant bulk persistence", () => {
    const payload = buildMessagePayload(
      { role: "assistant", parts: unsafeParts },
      "conversation-1",
      "user-1",
    );

    expect(payload.content).toBe("PRD 和原型已生成");
    expect(JSON.stringify(payload.metadata)).not.toMatch(
      /read_file|write_file|write_todos|runtime skill|reasoning/,
    );
  });
});
