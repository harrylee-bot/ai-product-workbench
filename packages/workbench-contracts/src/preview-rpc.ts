import { z } from "zod";

export const workbenchPreviewRpcProtocol = "workbench.preview" as const;
export const workbenchPreviewRpcVersion = 1 as const;
export const workbenchPreviewRpcChannel = `${workbenchPreviewRpcProtocol}.v${workbenchPreviewRpcVersion}`;
export const workbenchPreviewCapabilityIdSchema = z.string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9._-]+$/u);

export const workbenchPreviewHandshakeSchema = z.object({
  protocol: z.literal(workbenchPreviewRpcProtocol),
  version: z.literal(workbenchPreviewRpcVersion),
}).strict();
export const workbenchPreviewHandshake = workbenchPreviewHandshakeSchema.parse({
  protocol: workbenchPreviewRpcProtocol,
  version: workbenchPreviewRpcVersion,
});

export const workbenchPreviewReadyStatusSchema = z.object({
  protocol: z.literal(workbenchPreviewRpcProtocol),
  version: z.literal(workbenchPreviewRpcVersion),
  state: z.literal("ready"),
  errorCode: z.null(),
}).strict();

export const workbenchPreviewErrorStatusSchema = z.object({
  protocol: z.literal(workbenchPreviewRpcProtocol),
  version: z.literal(workbenchPreviewRpcVersion),
  state: z.literal("error"),
  errorCode: z.enum(["PREVIEW_RUNTIME_ERROR", "PREVIEW_BRIDGE_ERROR"]),
}).strict();

export const workbenchPreviewStatusSchema = z.discriminatedUnion("state", [
  workbenchPreviewReadyStatusSchema,
  workbenchPreviewErrorStatusSchema,
]);

export type WorkbenchPreviewStatus = z.infer<typeof workbenchPreviewStatusSchema>;
export type WorkbenchPreviewHandshake = z.infer<typeof workbenchPreviewHandshakeSchema>;

export type WorkbenchPreviewRpcMethods = {
  handshake(request: WorkbenchPreviewHandshake): WorkbenchPreviewStatus | Promise<WorkbenchPreviewStatus>;
};

export function workbenchPreviewRpcChannelForCapability(capabilityId: string) {
  return `${workbenchPreviewRpcChannel}:${workbenchPreviewCapabilityIdSchema.parse(capabilityId)}`;
}
