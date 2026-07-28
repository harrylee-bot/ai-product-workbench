import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  initializeTelemetry,
  queuePayload,
  recordKnowledgeVisibilityMetric,
  recordRuntimeLivenessMetric,
  recordRuntimeProviderStateMetric,
  recordRuntimeTransactionMetric,
  telemetryConfigurationFromEnv,
  traceHttpServerRequest,
  traceQueueConsume,
  traceQueuePublish,
  tracedFetch,
} from "../src/index.js";

const exporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const lifecycle = initializeTelemetry({
  serviceName: "workbench-telemetry-test",
  exporter,
  metricExporter,
  env: {},
});

afterAll(async () => {
  await lifecycle.shutdown();
});

describe("Product Workbench telemetry", () => {
  it("stays offline when no OTLP endpoint is configured", () => {
    const config = telemetryConfigurationFromEnv({});
    expect(config.disabled).toBe(false);
    expect(config.exporterEndpoint).toBeNull();
    expect(config.metricExporterEndpoint).toBeNull();
    const configured = telemetryConfigurationFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com/otel",
    });
    expect(configured.exporterEndpoint).toBe("https://collector.example.com/otel/v1/traces");
    expect(configured.metricExporterEndpoint).toBe("https://collector.example.com/otel/v1/metrics");
    expect(telemetryConfigurationFromEnv({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.com/custom",
    }).metricExporterEndpoint).toBe("https://metrics.example.com/custom");
  });

  it("exports low-cardinality Runtime and Knowledge metrics without scope identities", async () => {
    metricExporter.reset();
    recordRuntimeProviderStateMetric({
      operation: "update",
      outcome: "conflict",
      durationMs: 12,
      rowsApplied: 0,
      eventsApplied: 0,
      projectionLag: 1,
      errorCode: "RUNTIME_PROVIDER_STATE_SEQUENCE_GAP",
    });
    recordRuntimeLivenessMetric({
      operation: "wall-clock",
      outcome: "timeout",
      durationMs: 900_001,
      errorCode: "RUNTIME_WALL_CLOCK_EXCEEDED",
    });
    recordRuntimeTransactionMetric({
      operation: "provider-state-update",
      outcome: "timeout",
      waitMs: 3,
      durationMs: 18_727,
      errorCode: "P2028",
    });
    recordKnowledgeVisibilityMetric({
      operation: "execution",
      outcome: "blocked",
      errorCode: "WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING",
    });
    await lifecycle.forceFlush();

    const exported = metricExporter.getMetrics();
    const metricData = exported.flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(metricData.map((metric) => metric.descriptor.name)).toEqual(expect.arrayContaining([
      "workbench.runtime.provider_state.duration",
      "workbench.runtime.provider_state.failures",
      "workbench.runtime.transaction.wait",
      "workbench.runtime.transaction.duration",
      "workbench.runtime.transaction.p2028",
      "workbench.runtime.liveness.events",
      "workbench.knowledge.visibility.events",
    ]));
    const serialized = JSON.stringify(exported);
    expect(serialized).toContain("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP");
    expect(serialized).toContain("P2028");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("runtimeAttemptId");
    expect(serialized).not.toContain("externalEventId");
    expect(serialized).not.toContain("prompt");
  });

  it("bounds metric labels and rejects invalid numeric observations", () => {
    expect(() => recordRuntimeProviderStateMetric({
      operation: "read",
      outcome: "error",
      durationMs: 1,
      errorCode: "contains-sensitive-free-form-text",
    })).not.toThrow();
    expect(() => recordRuntimeProviderStateMetric({
      operation: "read",
      outcome: "ok",
      durationMs: -1,
    })).toThrow(/durationMs is invalid/u);
    expect(() => recordRuntimeProviderStateMetric({
      operation: "read",
      outcome: "ok",
      durationMs: 1,
      projectionLag: -1,
    })).toThrow(/projectionLag must be a non-negative integer/u);
    expect(() => recordRuntimeTransactionMetric({
      operation: "provider-state-read",
      outcome: "ok",
      waitMs: 2,
      durationMs: 1,
    })).toThrow(/waitMs must not exceed durationMs/u);
  });

  it("creates linked server and client spans without propagating baggage or token attributes", async () => {
    exporter.reset();
    let outgoing = new Headers();
    const fetchMock = vi.fn(async (_input, init) => {
      outgoing = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await traceHttpServerRequest({
      method: "POST",
      route: "/api/v1/*",
      headers: new Headers({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=release",
        baggage: "authorization=Bearer%20secret,workspace.id=private",
      }),
    }, async () => tracedFetch("https://api.internal.example/v1/resource?token=secret", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        baggage: "api.token=secret",
      },
    }, fetchMock), (response) => response.status);

    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.kind === 1);
    const client = spans.find((span) => span.kind === 2);
    expect(server?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(client?.spanContext().traceId).toBe(server?.spanContext().traceId);
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(outgoing.get("traceparent")).toContain(client?.spanContext().spanId);
    expect(outgoing.has("baggage")).toBe(false);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret");
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("token=");
  });

  it("links pg-boss producer and consumer spans through bounded trace metadata", async () => {
    exporter.reset();
    let queued: Record<string, unknown> = {};
    await traceQueuePublish("runtime.execute", {
      runId: "run_1",
      authorization: "Bearer business-secret",
    }, async (data) => {
      queued = data;
      return "job_1";
    });
    await traceQueueConsume({
      destination: "runtime.execute",
      messageId: "job_1",
      retryCount: 0,
      retryLimit: 5,
    }, queued, async () => undefined);

    const metadata = queued.__workbench_otel as Record<string, string>;
    expect(Object.keys(metadata).sort()).toEqual(["traceparent"]);
    expect(metadata).not.toHaveProperty("baggage");
    expect(queuePayload(queued)).toEqual({
      runId: "run_1",
      authorization: "Bearer business-secret",
    });
    const spans = exporter.getFinishedSpans();
    const producer = spans.find((span) => span.kind === 3);
    const consumer = spans.find((span) => span.kind === 4);
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("business-secret");
  });

  it("ignores forged queue context while preserving the strict business payload", async () => {
    exporter.reset();
    const forged = {
      runId: "run_1",
      __workbench_otel: {
        traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
        baggage: "authorization=secret",
      },
    };
    await traceQueueConsume({ destination: "runtime.execute", messageId: "job_2" }, forged, async () => undefined);
    expect(queuePayload(forged)).toEqual({ runId: "run_1" });
    const [consumer] = exporter.getFinishedSpans();
    expect(consumer?.parentSpanContext).toBeUndefined();
  });
});
