import { z } from "zod";
import { isoDateTimeSchema, revisionSchema } from "./common.js";

export const communicationPreferencesSchema = z.object({
  productUpdatesEmail: z.boolean()
    .describe("Explicit opt-in to product update email; false means no consent"),
  researchInvitations: z.boolean()
    .describe("Explicit opt-in to research invitations; false means no consent"),
  revision: revisionSchema,
  createdAt: isoDateTimeSchema.nullable()
    .describe("Null until the principal persists a preference decision"),
  updatedAt: isoDateTimeSchema.nullable()
    .describe("Null until the principal persists a preference decision"),
}).strict();

export const updateCommunicationPreferencesRequestSchema = z.object({
  productUpdatesEmail: z.boolean(),
  researchInvitations: z.boolean(),
}).strict();

export type CommunicationPreferences = z.infer<typeof communicationPreferencesSchema>;
export type UpdateCommunicationPreferencesRequest = z.infer<
  typeof updateCommunicationPreferencesRequestSchema
>;
