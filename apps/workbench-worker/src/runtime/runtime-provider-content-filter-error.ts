export class RuntimeProviderContentFilterError extends Error {
  readonly code = "RUNTIME_PROVIDER_CONTENT_FILTERED";
  readonly retryable = false;

  constructor() {
    super("模型服务商拦截了本次输出，任务已停止。");
    this.name = "RuntimeProviderContentFilterError";
  }
}
