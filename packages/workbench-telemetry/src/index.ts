import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const instrumentationName = "@workbench/workbench-telemetry";
const instrumentationVersion = "0.1.0";
const queueTraceField = "__workbench_otel";
const globalStateKey = Symbol.for("workbench.telemetry.runtime.v1");
const traceparentPattern = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u;

type TelemetryGlobal = typeof globalThis & {
  [globalStateKey]?: TelemetryRuntimeState;
};

type TelemetryRuntimeState = {
  serviceName: string;
  provider: NodeTracerProvider;
  shutdownPromise: Promise<void> | null;
};

export type InitializeTelemetryOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter | null;
};

export type TelemetryLifecycle = {
  enabled: boolean;
  exporting: boolean;
  shutdown(): Promise<void>;
};

export type TelemetryConfiguration = {
  disabled: boolean;
  exporterEndpoint: string | null;
  sampler: Sampler;
  batch: {
    maxQueueSize: number;
    maxExportBatchSize: number;
    scheduledDelayMillis: number;
    exportTimeoutMillis: number;
  };
};

export function telemetryConfigurationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfiguration {
  const disabled = booleanEnv(env.OTEL_SDK_DISABLED, false);
  const protocol = firstNonEmpty(
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_PROTOCOL,
  );
  if (protocol && protocol !== "http/protobuf") {
    throw new Error("Product Workbench tracing supports OTLP http/protobuf only");
  }
  const exporterEndpoint = disabled ? null : resolveTraceEndpoint(env);
  const maxQueueSize = positiveIntegerEnv(env.OTEL_BSP_MAX_QUEUE_SIZE, 2_048);
  const maxExportBatchSize = positiveIntegerEnv(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512);
  if (maxExportBatchSize > maxQueueSize) {
    throw new Error("OTEL_BSP_MAX_EXPORT_BATCH_SIZE must not exceed OTEL_BSP_MAX_QUEUE_SIZE");
  }
  return {
    disabled,
    exporterEndpoint,
    sampler: samplerFromEnv(env),
    batch: {
      maxQueueSize,
      maxExportBatchSize,
      scheduledDelayMillis: nonNegativeIntegerEnv(env.OTEL_BSP_SCHEDULE_DELAY, 5_000),
      exportTimeoutMillis: positiveIntegerEnv(env.OTEL_BSP_EXPORT_TIMEOUT, 30_000),
    },
  };
}

export function initializeTelemetry({
  serviceName,
  serviceVersion = "0.1.0",
  environment = process.env.NODE_ENV || "development",
  env = process.env,
  exporter,
}: InitializeTelemetryOptions): TelemetryLifecycle {
  if (!serviceName.trim()) throw new Error("Telemetry serviceName is required");
  const configuration = telemetryConfigurationFromEnv(env);
  if (configuration.disabled) return disabledLifecycle();

  const globalObject = globalThis as TelemetryGlobal;
  const existing = globalObject[globalStateKey];
  if (existing) {
    if (existing.serviceName !== serviceName) {
      throw new Error(`Telemetry is already initialized for ${existing.serviceName}`);
    }
    return lifecycle(existing, Boolean(exporter) || Boolean(configuration.exporterEndpoint));
  }

  const resolvedExporter = exporter === undefined
    ? configuration.exporterEndpoint
      ? new OTLPTraceExporter({ url: configuration.exporterEndpoint })
      : null
    : exporter;
  const spanProcessors = resolvedExporter
    ? [exporter === undefined
      ? new BatchSpanProcessor(resolvedExporter, configuration.batch)
      : new SimpleSpanProcessor(resolvedExporter)]
    : [];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.namespace": "workbench",
      "service.version": serviceVersion,
      "deployment.environment.name": environment,
    }),
    sampler: configuration.sampler,
    spanProcessors,
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  const state: TelemetryRuntimeState = {
    serviceName,
    provider,
    shutdownPromise: null,
  };
  globalObject[globalStateKey] = state;
  return lifecycle(state, Boolean(resolvedExporter));
}

export function shutdownTelemetry(): Promise<void> {
  const state = (globalThis as TelemetryGlobal)[globalStateKey];
  if (!state) return Promise.resolve();
  state.shutdownPromise ??= state.provider.shutdown();
  return state.shutdownPromise;
}

export type HttpServerSpanOptions = {
  method: string;
  route: string;
  headers: Headers | Readonly<Record<string, string | string[] | undefined>>;
};

export type ActiveHttpServerSpan = {
  run<T>(callback: () => T): T;
  end(statusCode: number, aborted?: boolean): void;
  fail(): void;
};

export function startHttpServerSpan(options: HttpServerSpanOptions): ActiveHttpServerSpan {
  const method = normalizedMethod(options.method);
  const parent = propagation.extract(ROOT_CONTEXT, options.headers, httpHeaderGetter);
  const span = tracer().startSpan(`${method} ${options.route}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": method,
      "http.route": options.route,
    },
  }, parent);
  const activeContext = trace.setSpan(parent, span);
  let ended = false;
  return {
    run<T>(callback: () => T): T {
      return context.with(activeContext, callback);
    },
    end(statusCode: number, aborted = false) {
      if (ended) return;
      ended = true;
      finishHttpSpan(span, statusCode, aborted);
    },
    fail() {
      if (ended) return;
      ended = true;
      recordSanitizedFailure(span, "HTTP server request failed");
      span.end();
    },
  };
}

export async function traceHttpServerRequest<T>(
  options: HttpServerSpanOptions,
  handler: () => Promise<T>,
  statusCode: (result: T) => number,
): Promise<T> {
  const scope = startHttpServerSpan(options);
  return scope.run(async () => {
    try {
      const result = await handler();
      scope.end(statusCode(result));
      return result;
    } catch (error) {
      scope.fail();
      throw error;
    }
  });
}

export async function tracedFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const method = normalizedMethod(init?.method || (input instanceof Request ? input.method : "GET"));
  const target = safeTarget(input);
  return tracer().startActiveSpan(`HTTP ${method} ${target.serverAddress}`, {
    kind: SpanKind.CLIENT,
    attributes: compactAttributes({
      "http.request.method": method,
      "server.address": target.serverAddress,
      "server.port": target.serverPort,
      "url.scheme": target.scheme,
    }),
  }, async (span) => {
    const headers = mergedHeaders(input, init);
    headers.delete("baggage");
    propagation.inject(context.active(), headers, httpHeaderSetter);
    try {
      const response = await fetchImplementation(input, { ...init, headers });
      finishHttpSpan(span, response.status, false, 400);
      return response;
    } catch (error) {
      recordSanitizedFailure(span, "HTTP client request failed");
      span.end();
      throw error;
    }
  });
}

export type QueueConsumerOptions = {
  destination: string;
  messageId: string;
  retryCount?: number;
  retryLimit?: number;
};

export async function traceQueuePublish<TData extends object, TResult>(
  destination: string,
  data: TData,
  publish: (tracedData: TData) => Promise<TResult>,
): Promise<TResult> {
  return tracer().startActiveSpan(`${destination} publish`, {
    kind: SpanKind.PRODUCER,
    attributes: queueAttributes(destination, "publish"),
  }, async (span) => {
    try {
      const result = await publish(withCurrentQueueTrace(data));
      if (typeof result === "string") span.setAttribute("messaging.message.id", result);
      span.end();
      return result;
    } catch (error) {
      recordSanitizedFailure(span, "Queue publish failed");
      span.end();
      throw error;
    }
  });
}

export async function traceQueueConsume<T>(
  options: QueueConsumerOptions,
  data: unknown,
  consume: () => Promise<T>,
): Promise<T> {
  const parent = queueParentContext(data);
  return tracer().startActiveSpan(`${options.destination} process`, {
    kind: SpanKind.CONSUMER,
    attributes: compactAttributes({
      ...queueAttributes(options.destination, "process"),
      "messaging.message.id": options.messageId,
      "messaging.message.retry.count": options.retryCount,
      "messaging.message.retry.limit": options.retryLimit,
    }),
  }, parent, async (span) => {
    try {
      const result = await consume();
      span.end();
      return result;
    } catch (error) {
      recordSanitizedFailure(span, "Queue processing failed");
      span.end();
      throw error;
    }
  });
}

export function queuePayload<T extends object>(data: unknown): T {
  if (!isPlainRecord(data)) return data as T;
  const { [queueTraceField]: _traceContext, ...payload } = data;
  return payload as T;
}

function withCurrentQueueTrace<TData extends object>(data: TData): TData {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, recordSetter);
  const copy = { ...data } as Record<string, unknown>;
  delete copy[queueTraceField];
  if (validQueueTraceContext(carrier)) {
    copy[queueTraceField] = carrier.tracestate
      ? { traceparent: carrier.traceparent, tracestate: carrier.tracestate }
      : { traceparent: carrier.traceparent };
  }
  return copy as TData;
}

function queueParentContext(data: unknown): Context {
  if (!isPlainRecord(data)) return ROOT_CONTEXT;
  const carrier = data[queueTraceField];
  if (!validQueueTraceContext(carrier)) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, carrier, recordGetter);
}

function validQueueTraceContext(value: unknown): value is Record<string, string> & { traceparent: string } {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "traceparent" && key !== "tracestate")) return false;
  if (typeof value.traceparent !== "string" || !traceparentPattern.test(value.traceparent)) return false;
  if (value.traceparent.slice(0, 2) === "ff") return false;
  const [, traceId, spanId] = value.traceparent.split("-");
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return false;
  if (value.tracestate === undefined) return true;
  return typeof value.tracestate === "string"
    && value.tracestate.length > 0
    && value.tracestate.length <= 512
    && !controlCharacters(value.tracestate);
}

function tracer() {
  return trace.getTracer(instrumentationName, instrumentationVersion);
}

function finishHttpSpan(span: Span, statusCode: number, aborted = false, errorThreshold = 500) {
  if (Number.isInteger(statusCode)) span.setAttribute("http.response.status_code", statusCode);
  if (aborted || statusCode >= errorThreshold) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

function recordSanitizedFailure(span: Span, message: string) {
  span.recordException({ name: "OperationalError", message });
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function queueAttributes(destination: string, operation: "publish" | "process"): Attributes {
  return {
    "messaging.system": "pg-boss",
    "messaging.destination.name": destination,
    "messaging.operation.type": operation,
  };
}

function mergedHeaders(input: URL | RequestInfo, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  return headers;
}

function safeTarget(input: URL | RequestInfo) {
  let url: URL;
  try {
    url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  } catch {
    return { serverAddress: "invalid-target", serverPort: undefined, scheme: undefined };
  }
  return {
    serverAddress: url.hostname || "unknown-target",
    serverPort: url.port ? Number(url.port) : undefined,
    scheme: url.protocol.replace(/:$/u, "") || undefined,
  };
}

const httpHeaderGetter: TextMapGetter<Headers | Readonly<Record<string, string | string[] | undefined>>> = {
  get(carrier, key) {
    if (carrier instanceof Headers) return carrier.get(key) ?? undefined;
    const value = Object.entries(carrier).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    return value;
  },
  keys(carrier) {
    return carrier instanceof Headers ? [...carrier.keys()] : Object.keys(carrier);
  },
};

const httpHeaderSetter: TextMapSetter<Headers> = {
  set(carrier, key, value) {
    carrier.set(key, value);
  },
};

const recordGetter: TextMapGetter<Record<string, unknown>> = {
  get(carrier, key) {
    const value = carrier[key];
    return typeof value === "string" ? value : undefined;
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

const recordSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

function lifecycle(state: TelemetryRuntimeState, exporting: boolean): TelemetryLifecycle {
  return {
    enabled: true,
    exporting,
    shutdown: () => shutdownTelemetry(),
  };
}

function disabledLifecycle(): TelemetryLifecycle {
  return {
    enabled: false,
    exporting: false,
    shutdown: async () => undefined,
  };
}

function resolveTraceEndpoint(env: NodeJS.ProcessEnv): string | null {
  const direct = firstNonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const base = direct ? null : firstNonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const candidate = direct || base;
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("OTLP trace endpoint must be an absolute URL");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("OTLP trace endpoint must be an http(s) URL without credentials, query, or fragment");
  }
  if (base) url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/traces`;
  return url.toString();
}

function samplerFromEnv(env: NodeJS.ProcessEnv): Sampler {
  const name = firstNonEmpty(env.OTEL_TRACES_SAMPLER) || "parentbased_always_on";
  const ratio = ratioEnv(env.OTEL_TRACES_SAMPLER_ARG, 1);
  switch (name) {
    case "always_on": return new AlwaysOnSampler();
    case "always_off": return new AlwaysOffSampler();
    case "traceidratio": return new TraceIdRatioBasedSampler(ratio);
    case "parentbased_always_on": return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case "parentbased_always_off": return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio": return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    default: throw new Error(`Unsupported OTEL_TRACES_SAMPLER: ${name}`);
  }
}

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function normalizedMethod(value: string) {
  const method = value.trim().toUpperCase();
  return /^[A-Z]{1,16}$/u.test(method) ? method : "OTHER";
}

function compactAttributes(input: Record<string, string | number | undefined>): Attributes {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number] => entry[1] !== undefined));
}

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (!value?.trim()) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("OTEL_SDK_DISABLED must be true or false");
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = nonNegativeIntegerEnv(value, fallback);
  if (parsed < 1) throw new Error("OpenTelemetry batch values must be positive integers");
  return parsed;
}

function nonNegativeIntegerEnv(value: string | undefined, fallback: number) {
  if (!value?.trim()) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("OpenTelemetry batch values must be non-negative integers");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("OpenTelemetry batch value exceeds the safe integer range");
  return parsed;
}

function ratioEnv(value: string | undefined, fallback: number) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("OTEL_TRACES_SAMPLER_ARG must be between 0 and 1");
  }
  return parsed;
}

function controlCharacters(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
