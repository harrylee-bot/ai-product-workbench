import type { ModelGatewayErrorCode } from "./model-gateway.types";

export class ModelGatewayError extends Error {
  constructor(
    public readonly code: ModelGatewayErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}
