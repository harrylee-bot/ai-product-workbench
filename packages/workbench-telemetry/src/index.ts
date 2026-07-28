import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
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
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
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
  meterProvider: MeterProvider;
  shutdownPromise: Promise<void> | null;
};

export type InitializeTelemetryOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter | null;
  metricExporter?: PushMetricExporter | null;
};

export type TelemetryLifecycle = {
  enabled: boolean;
  exporting: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type TelemetryConfiguration = {
  disabled: boolean;
  exporterEndpoint: string | null;
  metricExporterEndpoint: string | null;
  sampler: Sampler;
  batch: {
    maxQueueSize: number;
    maxExportBatchSize: number;
    scheduledDelayMillis: number;
    exportTimeoutMillis: number;
  };
  metrics: {
    exportIntervalMillis: number;
    exportTimeoutMillis: number;
    cardinalityLimit: number;
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
    throw new Error("Product Workbench telemetry supports OTLP http/protobuf only");
  }
  const exporterEndpoint = disabled ? null : resolveTraceEndpoint(env);
  const metricProtocol = firstNonEmpty(
    env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_PROTOCOL,
  );
  if (metricProtocol && metricProtocol !== "http/protobuf") {
    throw new Error("Product Workbench metrics supports OTLP http/protobuf only");
  }
  const metricExporterEndpoint = disabled ? null : resolveMetricEndpoint(env);
  const maxQueueSize = positiveIntegerEnv(env.OTEL_BSP_MAX_QUEUE_SIZE, 2_048);
  const maxExportBatchSize = positiveIntegerEnv(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512);
  if (maxExportBatchSize > maxQueueSize) {
    throw new Error("OTEL_BSP_MAX_EXPORT_BATCH_SIZE must not exceed OTEL_BSP_MAX_QUEUE_SIZE");
  }
  return {
    disabled,
    exporterEndpoint,
    metricExporterEndpoint,
    sampler: samplerFromEnv(env),
    batch: {
      maxQueueSize,
      maxExportBatchSize,
      scheduledDelayMillis: nonNegativeIntegerEnv(env.OTEL_BSP_SCHEDULE_DELAY, 5_000),
      exportTimeoutMillis: positiveIntegerEnv(env.OTEL_BSP_EXPORT_TIMEOUT, 30_000),
    },
    metrics: {
      exportIntervalMillis: positiveIntegerEnv(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
      exportTimeoutMillis: positiveIntegerEnv(env.OTEL_METRIC_EXPORT_TIMEOUT, 30_000),
      cardinalityLimit: positiveIntegerEnv(env.WORKBENCH_OTEL_METRIC_CARDINALITY_LIMIT, 64),
    },
  };
}

export function initializeTelemetry({
  serviceName,
  serviceVersion = "0.1.0",
  environment = process.env.NODE_ENV || "development",
  env = process.env,
  exporter,
  metricExporter,
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
    return lifecycle(
      existing,
      Boolean(exporter) || Boolean(configuration.exporterEndpoint)
        || Boolean(metricExporter) || Boolean(configuration.metricExporterEndpoint),
    );
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
  const resolvedMetricExporter = metricExporter === undefined
    ? configuration.metricExporterEndpoint
      ? new OTLPMetricExporter({ url: configuration.metricExporterEndpoint })
      : null
    : metricExporter;
  const metricReaders = resolvedMetricExporter
    ? [new PeriodicExportingMetricReader({
        exporter: resolvedMetricExporter,
        exportIntervalMillis: configuration.metrics.exportIntervalMillis,
        exportTimeoutMillis: configuration.metrics.exportTimeoutMillis,
        cardinalityLimits: { default: configuration.metrics.cardinalityLimit },
      })]
    : [];
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.namespace": "workbench",
    "service.version": serviceVersion,
    "deployment.environment.name": environment,
  });
  const provider = new NodeTracerProvider({
    resource,
    sampler: configuration.sampler,
    spanProcessors,
  });
  const meterProvider = new MeterProvider({ resource, readers: metricReaders });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  metrics.setGlobalMeterProvider(meterProvider);
  const state: TelemetryRuntimeState = {
    serviceName,
    provider,
    meterProvider,
    shutdownPromise: null,
  };
  globalObject[globalStateKey] = state;
  return lifecycle(state, Boolean(resolvedExporter) || Boolean(resolvedMetricExporter));
}

export function shutdownTelemetry(): Promise<void> {
  const state = (globalThis as TelemetryGlobal)[globalStateKey];
  if (!state) return Promise.resolve();
  state.shutdownPromise ??= Promise.all([
    state.provider.shutdown(),
    state.meterProvider.shutdown(),
  ]).then(() => undefined);
  return state.shutdownPromise;
}

const providerStateOperations = new Set(["read", "update", "backfill", "shadow-verify"] as const);
const providerStateOutcomes = new Set(["ok", "error", "conflict", "missing", "replay"] as const);
const transactionOperations = new Set([
  "provider-state-read",
  "provider-state-update",
  "provider-state-backfill",
] as const);
const transactionOutcomes = new Set(["ok", "error", "conflict", "timeout"] as const);
const livenessOperations = new Set([
  "queue-age",
  "submission",
  "provider-first-byte",
  "stream-idle",
  "wall-clock",
  "lease-takeover",
  "terminal-drift",
  "abort",
  "cancel",
  "reconcile",
] as const);
const livenessOutcomes = new Set(["ok", "timeout", "cancelled", "error", "recovered"] as const);
const knowledgeOperations = new Set(["catalog", "execution"] as const);
const knowledgeOutcomes = new Set(["authorized", "hidden", "blocked", "error"] as const);
const stableMetricErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type RuntimeProviderStateMetric = {
  operation: "read" | "update" | "backfill" | "shadow-verify";
  outcome: "ok" | "error" | "conflict" | "missing" | "replay";
  durationMs: number;
  rowsApplied?: 0 | 1;
  eventsApplied?: 0 | 1;
  projectionLag?: number;
  errorCode?: string;
};

export type RuntimeTransactionMetric = {
  operation: "provider-state-read" | "provider-state-update" | "provider-state-backfill";
  outcome: "ok" | "error" | "conflict" | "timeout";
  waitMs: number;
  durationMs: number;
  errorCode?: string;
};

export type RuntimeLivenessMetric = {
  operation:
    | "queue-age"
    | "submission"
    | "provider-first-byte"
    | "stream-idle"
    | "wall-clock"
    | "lease-takeover"
    | "terminal-drift"
    | "abort"
    | "cancel"
    | "reconcile";
  outcome: "ok" | "timeout" | "cancelled" | "error" | "recovered";
  durationMs?: number;
  errorCode?: string;
};

export type KnowledgeVisibilityMetric = {
  operation: "catalog" | "execution";
  outcome: "authorized" | "hidden" | "blocked" | "error";
  errorCode?: string;
};

export function recordRuntimeProviderStateMetric(event: RuntimeProviderStateMetric) {
  assertMetricEnum(event.operation, providerStateOperations, "provider-state operation");
  assertMetricEnum(event.outcome, providerStateOutcomes, "provider-state outcome");
  assertMetricDuration(event.durationMs);
  assertBinaryCount(event.rowsApplied, "rowsApplied");
  assertBinaryCount(event.eventsApplied, "eventsApplied");
  assertNonNegativeInteger(event.projectionLag, "projectionLag");
  const attributes = metricAttributes(event.operation, event.outcome, event.errorCode, 2);
  const instruments = runtimeMetricInstruments();
  instruments.providerStateDuration.record(event.durationMs, attributes);
  if (event.rowsApplied !== undefined) instruments.providerStateRowsApplied.record(event.rowsApplied, attributes);
  if (event.eventsApplied !== undefined) instruments.providerStateEventsApplied.record(event.eventsApplied, attributes);
  if (event.projectionLag !== undefined) instruments.providerStateProjectionLag.record(event.projectionLag, attributes);
  if (event.outcome !== "ok" && event.outcome !== "replay") {
    instruments.providerStateFailures.add(1, attributes);
  }
}

export function recordRuntimeTransactionMetric(event: RuntimeTransactionMetric) {
  assertMetricEnum(event.operation, transactionOperations, "transaction operation");
  assertMetricEnum(event.outcome, transactionOutcomes, "transaction outcome");
  assertMetricDuration(event.waitMs);
  assertMetricDuration(event.durationMs);
  if (event.waitMs > event.durationMs) {
    throw new Error("Telemetry transaction waitMs must not exceed durationMs");
  }
  const attributes = metricAttributes(event.operation, event.outcome, event.errorCode);
  const instruments = runtimeMetricInstruments();
  instruments.transactionWait.record(event.waitMs, attributes);
  instruments.transactionDuration.record(event.durationMs, attributes);
  instruments.transactionEvents.add(1, attributes);
  if (normalizedMetricErrorCode(event.errorCode) === "P2028") {
    instruments.transactionP2028.add(1, attributes);
  }
}

export function recordRuntimeLivenessMetric(event: RuntimeLivenessMetric) {
  assertMetricEnum(event.operation, livenessOperations, "liveness operation");
  assertMetricEnum(event.outcome, livenessOutcomes, "liveness outcome");
  if (event.durationMs !== undefined) assertMetricDuration(event.durationMs);
  const attributes = metricAttributes(event.operation, event.outcome, event.errorCode);
  const instruments = runtimeMetricInstruments();
  instruments.livenessEvents.add(1, attributes);
  if (event.durationMs !== undefined) instruments.livenessDuration.record(event.durationMs, attributes);
}

export function recordKnowledgeVisibilityMetric(event: KnowledgeVisibilityMetric) {
  assertMetricEnum(event.operation, knowledgeOperations, "Knowledge operation");
  assertMetricEnum(event.outcome, knowledgeOutcomes, "Knowledge outcome");
  runtimeMetricInstruments().knowledgeVisibility.add(
    1,
    metricAttributes(event.operation, event.outcome, event.errorCode),
  );
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

let cachedRuntimeMetricInstruments: ReturnType<typeof createRuntimeMetricInstruments> | null = null;

function runtimeMetricInstruments() {
  cachedRuntimeMetricInstruments ??= createRuntimeMetricInstruments();
  return cachedRuntimeMetricInstruments;
}

function createRuntimeMetricInstruments() {
  const meter = metrics.getMeter(instrumentationName, instrumentationVersion);
  return {
    providerStateDuration: meter.createHistogram("workbench.runtime.provider_state.duration", {
      description: "Runtime provider-state operation duration",
      unit: "ms",
    }),
    providerStateRowsApplied: meter.createHistogram("workbench.runtime.provider_state.rows_applied", {
      description: "Rows applied by one Runtime provider-state operation",
      unit: "{row}",
    }),
    providerStateEventsApplied: meter.createHistogram("workbench.runtime.provider_state.events_applied", {
      description: "Events applied by one Runtime provider-state operation",
      unit: "{event}",
    }),
    providerStateProjectionLag: meter.createHistogram("workbench.runtime.provider_state.projection_lag", {
      description: "Attempt sequence minus provider-state projection sequence",
      unit: "{event}",
    }),
    providerStateFailures: meter.createCounter("workbench.runtime.provider_state.failures", {
      description: "Runtime provider-state failures grouped by stable low-cardinality code",
      unit: "{failure}",
    }),
    transactionWait: meter.createHistogram("workbench.runtime.transaction.wait", {
      description: "Runtime database transaction acquisition wait",
      unit: "ms",
    }),
    transactionDuration: meter.createHistogram("workbench.runtime.transaction.duration", {
      description: "Runtime database transaction duration including acquisition wait",
      unit: "ms",
    }),
    transactionEvents: meter.createCounter("workbench.runtime.transaction.events", {
      description: "Runtime database transaction outcomes",
      unit: "{transaction}",
    }),
    transactionP2028: meter.createCounter("workbench.runtime.transaction.p2028", {
      description: "Runtime Prisma P2028 transaction failures",
      unit: "{failure}",
    }),
    livenessEvents: meter.createCounter("workbench.runtime.liveness.events", {
      description: "Runtime liveness state-machine outcomes",
      unit: "{event}",
    }),
    livenessDuration: meter.createHistogram("workbench.runtime.liveness.duration", {
      description: "Runtime submission, idle, wall-clock, cancel, and recovery duration",
      unit: "ms",
    }),
    knowledgeVisibility: meter.createCounter("workbench.knowledge.visibility.events", {
      description: "Knowledge catalog visibility and execution authorization outcomes",
      unit: "{event}",
    }),
  };
}

function metricAttributes(
  operation: string,
  outcome: string,
  errorCode?: string,
  projectionVersion?: number,
): Attributes {
  return compactAttributes({
    operation,
    outcome,
    "error.code": normalizedMetricErrorCode(errorCode),
    "projection.version": projectionVersion,
  });
}

function normalizedMetricErrorCode(errorCode?: string) {
  if (errorCode === undefined) return undefined;
  return stableMetricErrorCode.test(errorCode) ? errorCode : "OTHER";
}

function assertMetricEnum<T extends string>(value: T, values: ReadonlySet<T>, label: string) {
  if (!values.has(value)) throw new Error(`Telemetry ${label} is invalid`);
}

function assertMetricDuration(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error("Telemetry durationMs is invalid");
  }
}

function assertBinaryCount(value: 0 | 1 | undefined, label: string) {
  if (value !== undefined && value !== 0 && value !== 1) throw new Error(`Telemetry ${label} must be 0 or 1`);
}

function assertNonNegativeInteger(value: number | undefined, label: string) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Telemetry ${label} must be a non-negative integer`);
  }
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
    forceFlush: async () => {
      await Promise.all([state.provider.forceFlush(), state.meterProvider.forceFlush()]);
    },
    shutdown: () => shutdownTelemetry(),
  };
}

function disabledLifecycle(): TelemetryLifecycle {
  return {
    enabled: false,
    exporting: false,
    forceFlush: async () => undefined,
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

function resolveMetricEndpoint(env: NodeJS.ProcessEnv): string | null {
  const direct = firstNonEmpty(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
  const base = direct ? null : firstNonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const candidate = direct || base;
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("OTLP metric endpoint must be an absolute URL");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("OTLP metric endpoint must be an http(s) URL without credentials, query, or fragment");
  }
  if (base) url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/metrics`;
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
