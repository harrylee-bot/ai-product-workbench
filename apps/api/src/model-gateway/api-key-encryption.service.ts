import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";

@Injectable()
export class ApiKeyEncryptionService {
  private readonly algorithm = "aes-256-gcm";

  encrypt(plainText: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(
      ":",
    );
  }

  decrypt(cipherText: string) {
    const [version, ivText, tagText, encryptedText] = cipherText.split(":");
    if (version !== "v1" || !ivText || !tagText || !encryptedText) {
      throw new Error("Invalid encrypted API key format");
    }

    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.getKey(),
      Buffer.from(ivText, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  mask(apiKey: string) {
    const value = apiKey.trim();
    if (value.length <= 8) return "****";
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }

  maskEncrypted(cipherText: string) {
    return this.mask(this.decrypt(cipherText));
  }

  private getKey() {
    const configured = process.env.MODEL_GATEWAY_ENCRYPTION_KEY?.trim();
    if (configured) {
      const base64 = this.tryBase64(configured);
      if (base64?.length === 32) return base64;

      if (configured.length === 64 && /^[a-f0-9]+$/i.test(configured)) {
        return Buffer.from(configured, "hex");
      }
    }

    const secret = configured || process.env.JWT_SECRET || "ai-product-workbench-dev-secret";
    return crypto.createHash("sha256").update(secret).digest();
  }

  private tryBase64(value: string) {
    try {
      return Buffer.from(value, "base64");
    } catch {
      return null;
    }
  }
}
