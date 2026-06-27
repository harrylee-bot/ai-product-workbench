/**
 * 启动期密钥校验：拒绝以弱默认/空密钥启动。
 * 审计发现 deploy-default-secrets / sec-4：部署脚本与应用层都存在可预测默认密钥回退，
 * 一旦运维忘设 .env，生产将以已知密钥运行，JWT 可被伪造。
 */

/** 读取必填环境变量，缺失即抛错（fail-fast），杜绝静默回退到默认值。 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env before starting the API.`,
    );
  }
  return value;
}

/** JWT 签名密钥：必须显式配置，不再回退 "dev-secret-change-me"。 */
export function getJwtSecret(): string {
  return requireEnv("JWT_SECRET");
}

/**
 * 模型网关加密密钥：必须为合法 32 字节 base64 或 64 位 hex。
 * 不再回退到 JWT_SECRET 或硬编码 dev secret（见 api-key-encryption.service.ts）。
 * 返回 32 字节 Buffer。
 */
export function getModelGatewayEncryptionKey(): Buffer {
  const configured = process.env.MODEL_GATEWAY_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new Error(
      "Missing MODEL_GATEWAY_ENCRYPTION_KEY. Provide a 32-byte base64 or 64-char hex key in .env.",
    );
  }
  const base64 = Buffer.from(configured, "base64");
  if (base64.length === 32) return base64;
  if (configured.length === 64 && /^[a-f0-9]+$/i.test(configured)) {
    return Buffer.from(configured, "hex");
  }
  throw new Error(
    "MODEL_GATEWAY_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars. Got an invalid value.",
  );
}

/** 启动期统一校验所有关键密钥，任一缺失/非法即拒绝启动。 */
export function validateSecrets(): void {
  getJwtSecret();
  // MODEL_GATEWAY_ENCRYPTION_KEY 仅在模型网关被使用时必需；admin 配置 provider key 时需要它。
  // 这里不强制（避免不用模型网关的部署被卡），但 api-key-encryption.service 会在使用时 fail-fast。
  // 生产建议显式设置。
}
