import { describe, expect, it } from "vitest";

import {
  isEmailLoginIdentifier,
  isWorkbenchEmail,
  isWorkbenchUsername,
  WORKBENCH_PASSWORD_MAX_LENGTH,
  WORKBENCH_PASSWORD_MIN_LENGTH,
  WORKBENCH_USERNAME_MAX_LENGTH,
  WORKBENCH_USERNAME_MIN_LENGTH,
} from "./workbench-auth.shared";

describe("product account authentication policy", () => {
  it("accepts normalized product usernames without requiring an email login", () => {
    expect(isWorkbenchUsername("owner_01")).toBe(true);
    expect(isWorkbenchUsername("Product.Owner-1")).toBe(true);
    expect(isWorkbenchUsername("ab")).toBe(false);
    expect(isWorkbenchUsername("name@example.com")).toBe(false);
    expect(isWorkbenchUsername("含中文")).toBe(false);
  });

  it("routes only email-shaped identifiers to email authentication", () => {
    expect(isEmailLoginIdentifier("owner")).toBe(false);
    expect(isEmailLoginIdentifier("owner@example.com")).toBe(true);
    expect(isWorkbenchEmail("owner@example.com")).toBe(true);
    expect(isWorkbenchEmail("owner@invalid")).toBe(false);
  });

  it("keeps UI limits aligned with Better Auth server limits", () => {
    expect(WORKBENCH_USERNAME_MIN_LENGTH).toBe(3);
    expect(WORKBENCH_USERNAME_MAX_LENGTH).toBe(30);
    expect(WORKBENCH_PASSWORD_MIN_LENGTH).toBe(8);
    expect(WORKBENCH_PASSWORD_MAX_LENGTH).toBe(128);
  });
});
