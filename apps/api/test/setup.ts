/**
 * Vitest 全局 setup：为测试提供必需的环境变量。
 * 生产代码已改为 fail-fast（不再回退弱默认），测试需显式提供密钥。
 */
process.env.JWT_SECRET = "test-jwt-secret-not-for-production-use-32bytes";
process.env.MODEL_GATEWAY_ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
process.env.WEB_ORIGIN = "http://localhost:3000";
