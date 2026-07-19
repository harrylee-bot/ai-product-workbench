import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  decodeCanvasToolCapabilitySecret,
} from "@workbench/workbench-canvas-tools";
import { integerValue, optionalString } from "../../platform/config/config-values.js";

/** Configuration for the private Worker -> Workbench Canvas capability endpoint. */
@Injectable()
export class CanvasAgentConfig {
  readonly grantSecret: Uint8Array | null;
  readonly grantMaximumTtlSeconds: number;
  readonly commandTtlSeconds: number;
  readonly invocationLeaseSeconds: number;
  readonly expiryReconciliationBatchSize: number;
  readonly expiryReconciliationIntervalMs: number;

  constructor(config: ConfigService) {
    const encoded = optionalString(config, "WORKBENCH_CANVAS_TOOL_SECRET");
    this.grantSecret = encoded ? decodeCanvasToolCapabilitySecret(encoded) : null;
    this.grantMaximumTtlSeconds = integerValue(
      config,
      "WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS",
      300,
      30,
      3_600,
    );
    this.commandTtlSeconds = integerValue(
      config,
      "WORKBENCH_CANVAS_COMMAND_TTL_SECONDS",
      60,
      5,
      300,
    );
    this.invocationLeaseSeconds = integerValue(
      config,
      "WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS",
      30,
      5,
      300,
    );
    this.expiryReconciliationBatchSize = integerValue(
      config,
      "WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_BATCH_SIZE",
      100,
      1,
      1_000,
    );
    this.expiryReconciliationIntervalMs = integerValue(
      config,
      "WORKBENCH_CANVAS_EXPIRY_RECONCILIATION_INTERVAL_MS",
      5_000,
      100,
      300_000,
    );
  }
}
