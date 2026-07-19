import { describe, expect, it } from "vitest";
import {
  KnowledgeToolGrantError,
  createKnowledgeToolGrant,
  decodeKnowledgeToolSecret,
  verifyKnowledgeToolGrant,
} from "../src/tool-grant.js";

const secret = Buffer.alloc(32, 19);
const now = new Date("2026-07-14T00:00:00.000Z");
const payload = {
  grantId: "grant_123",
  runId: "run_123",
  runtimeAttemptId: "attempt_123",
  principalId: "principal_123",
  projectId: "project_123",
  releaseId: "release_123",
  mode: "hybrid" as const,
  routeScope: "production" as const,
  issuedAt: now,
  expiresAt: new Date(now.getTime() + 5 * 60_000),
};

describe("Knowledge tool grants", () => {
  it("round trips the exact authorized Run and pinned release scope", () => {
    const token = createKnowledgeToolGrant(payload, secret, { now, maximumTtlSeconds: 600 });
    expect(verifyKnowledgeToolGrant(token, secret, { now, maximumTtlSeconds: 600 })).toEqual(payload);
  });

  it("rejects tampering, expiry, excessive ttl, invalid scope and weak secrets", () => {
    const token = createKnowledgeToolGrant(payload, secret, { now, maximumTtlSeconds: 600 });
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => verifyKnowledgeToolGrant(`${token.slice(0, -1)}${replacement}`, secret, { now })).toThrow(
      KnowledgeToolGrantError,
    );
    expect(() => verifyKnowledgeToolGrant(token, secret, {
      now: new Date(payload.expiresAt.getTime()),
    })).toThrow("KNOWLEDGE_TOOL_GRANT_EXPIRED");
    expect(() => verifyKnowledgeToolGrant(token, secret, {
      now: new Date(now.getTime() - 60_000),
      maximumTtlSeconds: 300,
    })).toThrow("KNOWLEDGE_TOOL_GRANT_TTL_EXCEEDED");
    expect(() => createKnowledgeToolGrant({ ...payload, routeScope: "source_lookup" as never }, secret, { now }))
      .toThrow("KNOWLEDGE_TOOL_GRANT_SCOPE_INVALID");
    expect(() => createKnowledgeToolGrant(payload, Buffer.alloc(16), { now }))
      .toThrow("KNOWLEDGE_TOOL_SECRET_INVALID");
  });

  it("decodes only canonical base64url secrets with at least 256 bits", () => {
    expect(decodeKnowledgeToolSecret(secret.toString("base64url"))).toEqual(secret);
    expect(() => decodeKnowledgeToolSecret("not-a-secret")).toThrow("KNOWLEDGE_TOOL_SECRET_INVALID");
  });
});
