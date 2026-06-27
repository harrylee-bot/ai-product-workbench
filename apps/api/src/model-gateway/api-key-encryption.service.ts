import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { getModelGatewayEncryptionKey } from "../common/secret-config";

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
    // 不再回退到 JWT_SECRET 或硬编码 dev secret。
    // MODEL_GATEWAY_ENCRYPTION_KEY 必须为合法 32 字节 base64 或 64 位 hex，否则启动期 fail-fast。
    // 密钥派生与 JWT_SECRET 解耦：轮换 JWT_SECRET 不会影响已加密 provider key 的可解密性。
    return getModelGatewayEncryptionKey();
  }
}
