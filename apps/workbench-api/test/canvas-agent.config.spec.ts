import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { CanvasAgentConfig } from "../src/modules/canvas-agent/canvas-agent.config.js";

const secret = Buffer.alloc(32, 19).toString("base64url");

describe("CanvasAgentConfig", () => {
  it("uses bounded defaults for an unconfigured local deployment", () => {
    const config = createConfig();

    expect(config.grantSecret).toBeNull();
    expect(config.grantMaximumTtlSeconds).toBe(300);
    expect(config.commandTtlSeconds).toBe(60);
    expect(config.invocationLeaseSeconds).toBe(30);
    expect(config.expiryReconciliationBatchSize).toBe(100);
    expect(config.expiryReconciliationIntervalMs).toBe(5_000);
  });

  it("loads the independent secret and explicit Canvas timing values", () => {
    const config = createConfig({
      WORKBENCH_CANVAS_TOOL_SECRET: secret,
      WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "600",
      WORKBENCH_CANVAS_COMMAND_TTL_SECONDS: "120",
      WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "45",
      WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_BATCH_SIZE: "250",
      WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_INTERVAL_MS: "1500",
    });

    expect(Buffer.from(config.grantSecret!)).toEqual(Buffer.from(secret, "base64url"));
    expect(config.grantMaximumTtlSeconds).toBe(600);
    expect(config.commandTtlSeconds).toBe(120);
    expect(config.invocationLeaseSeconds).toBe(45);
    expect(config.expiryReconciliationBatchSize).toBe(250);
    expect(config.expiryReconciliationIntervalMs).toBe(1_500);
  });

  it("bounds the invocation lease independently from command lifetime", () => {
    expect(() => createConfig({
      WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "4",
    })).toThrow(/between 5 and 300/u);
    expect(() => createConfig({
      WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "301",
    })).toThrow(/between 5 and 300/u);
  });

  it("bounds expiry reconciliation work independently", () => {
    expect(() => createConfig({
      WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_BATCH_SIZE: "0",
    })).toThrow(/between 1 and 1000/u);
    expect(() => createConfig({
      WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_INTERVAL_MS: "99",
    })).toThrow(/between 100 and 300000/u);
  });
});

function createConfig(overrides: Record<string, string> = {}) {
  return new CanvasAgentConfig(new ConfigService(overrides));
}
