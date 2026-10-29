import { hash } from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

import { verifyWorkbenchPassword } from "./workbench-password";

describe("shared requirement-pool credentials", () => {
  it("accepts the imported native bcrypt password and rejects a wrong password", async () => {
    const encoded = `apitable-bcrypt:${await hash("SharedPassword123", 4)}`;
    expect(await verifyWorkbenchPassword({ hash: encoded, password: "SharedPassword123" })).toBe(true);
    expect(await verifyWorkbenchPassword({ hash: encoded, password: "WrongPassword123" })).toBe(false);
  });

  it("preserves native Workbench scrypt credentials", async () => {
    const encoded = await hashPassword("NativePassword123");
    expect(await verifyWorkbenchPassword({ hash: encoded, password: "NativePassword123" })).toBe(true);
    expect(await verifyWorkbenchPassword({ hash: encoded, password: "WrongPassword123" })).toBe(false);
  });

  it("rejects disabled, malformed, unnamespaced and excessive-cost hashes", async () => {
    const encoded = await hash("SharedPassword123", 4);
    for (const invalid of ["", "apitable-disabled:source-id", encoded, "apitable-bcrypt:invalid",
      `apitable-bcrypt:${encoded.replace("$04$", "$31$")}`]) {
      expect(await verifyWorkbenchPassword({ hash: invalid, password: "SharedPassword123" })).toBe(false);
    }
  });

  it("rejects bcrypt truncation collisions including multibyte passwords", async () => {
    const password = "A".repeat(72);
    const encoded = `apitable-bcrypt:${await hash(password, 4)}`;
    expect(await verifyWorkbenchPassword({ hash: encoded, password: password + "B" })).toBe(false);
    const multibyte = "密".repeat(24);
    const unicodeHash = `apitable-bcrypt:${await hash(multibyte, 4)}`;
    expect(await verifyWorkbenchPassword({ hash: unicodeHash, password: multibyte + "码" })).toBe(false);
  });
});
