import {
  communicationPreferencesSchema,
  updateCommunicationPreferencesRequestSchema,
} from "../src/identity.js";
import { describe, expect, it } from "vitest";

describe("communication preferences contracts", () => {
  it("represents the unpersisted explicit opt-in defaults", () => {
    expect(communicationPreferencesSchema.parse({
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    })).toEqual({
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("requires an explicit value for both consent decisions", () => {
    expect(updateCommunicationPreferencesRequestSchema.safeParse({
      productUpdatesEmail: true,
    }).success).toBe(false);
    expect(updateCommunicationPreferencesRequestSchema.safeParse({
      productUpdatesEmail: true,
      researchInvitations: false,
      marketingSms: true,
    }).success).toBe(false);
  });
});
