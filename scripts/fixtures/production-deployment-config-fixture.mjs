import { INFRASTRUCTURE_IMAGE_DEFINITIONS } from "../production-deployment-config.mjs";

export function productionDeploymentConfigFixtureEnvironment({
  enterpriseSsoEnabled = false,
  overrides = {},
} = {}) {
  const environment = {
    WORKBENCH_WEB_ORIGIN: "https://workbench.example.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
    WORKBENCH_ENTERPRISE_SSO_ENABLED: String(enterpriseSsoEnabled),
    WORKBENCH_OIDC_PROVIDER_ISSUER: enterpriseSsoEnabled ? "https://identity.example.test/realms/workbench" : "",
    WORKBENCH_OIDC_CLIENT_ID: enterpriseSsoEnabled ? "workbench-web" : "",
    WORKBENCH_IDENTITY_HOSTNAME: enterpriseSsoEnabled ? "identity.example.test" : "",
    WORKBENCH_S3_INTERNAL_ENDPOINT: "https://s3.internal.example.test",
    WORKBENCH_S3_EGRESS_UPSTREAM_HOST: "s3.internal.example.test",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test/workbench",
    WORKBENCH_S3_BUCKET: "workbench",
    WORKBENCH_S3_REGION: "cn-hangzhou",
    WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "false",
    WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "s3-if-none-match",
    WORKBENCH_RUNTIME_WORKER_REPLICAS: "10",
    WORKBENCH_RUNTIME_CONCURRENCY: "10",
    WORKBENCH_RUNTIME_CANCELLATION_POLL_INTERVAL_MS: "1000",
    WORKBENCH_RUNTIME_CANCELLATION_QUERY_BATCH_SIZE: "100",
    WORKBENCH_RUNTIME_EXECUTION_LEASE_MS: "45000",
    WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS: "15000",
    WORKBENCH_RUNTIME_EXECUTION_MAX_WALL_CLOCK_MS: "1800000",
    WORKBENCH_RUNTIME_EXECUTION_DEADLINE_CANCEL_MS: "30000",
    WORKBENCH_RUNTIME_PROVIDER_STATE_MODE: "projection-required",
    WORKBENCH_RUNTIME_EXECUTION_RECONCILE_BATCH_SIZE: "100",
    WORKBENCH_DEERFLOW_TIMEOUT_MS: "600000",
    WORKBENCH_DEERFLOW_SUBMISSION_TIMEOUT_MS: "120000",
    WORKBENCH_DEERFLOW_IDLE_TIMEOUT_MS: "120000",
    WORKBENCH_CLAMAV_HOST: "clamav.internal.example.test",
    WORKBENCH_CLAMAV_PORT: "3310",
    WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS: "172800000",
    WORKBENCH_CLAMAV_STREAM_MAX_BYTES: "26214400",
    WORKBENCH_DOCLING_URL: "https://docling.internal.example.test",
    WORKBENCH_FILE_PARSER_VERSION: "docling-serve/1.26.0+docling/2.107.0",
    WORKBENCH_DOCLING_RESULT_RETENTION_SECONDS: "86400",
    WORKBENCH_TEI_URL: "https://tei.internal.example.test",
    WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_URL: "https://reranker.internal.example.test",
    WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: "bge-reranker-v2-m3",
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: "revision-20260720",
    WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: "1.8.3",
    WORKBENCH_DEX_IMAGE: "",
    WORKBENCH_MINIO_IMAGE: "",
    WORKBENCH_MINIO_MC_IMAGE: "",
    ...Object.fromEntries(INFRASTRUCTURE_IMAGE_DEFINITIONS.map((definition, index) => [
      definition.environment,
      `registry.example.test/infra/${definition.name}:v1@sha256:${String(index + 1).repeat(64)}`,
    ])),
    ...overrides,
  };
  const deployed = new Map(INFRASTRUCTURE_IMAGE_DEFINITIONS.map((definition) => [
    definition.name,
    environment[definition.environment],
  ]));
  const dependency = (name, fields, index) => ({
    name,
    configAttestationSha256: String((index % 8) + 1).repeat(64),
    ...fields,
  });
  const dependencies = [
    dependency("clamav", {
      kind: "external-service",
      endpoint: `tcp://${environment.WORKBENCH_CLAMAV_HOST}:${environment.WORKBENCH_CLAMAV_PORT}`,
      version: "clamav-1.4.5",
      imageRef: null,
      digest: null,
    }, 0),
    dependency("docling", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_DOCLING_URL,
      version: environment.WORKBENCH_FILE_PARSER_VERSION,
      imageRef: null,
      digest: null,
    }, 1),
    dependency("edge-gateway", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_WEB_ORIGIN,
      version: "edge-config-20260720",
      imageRef: null,
      digest: null,
    }, 2),
    dependency("gateway", {
      kind: "deployed-image",
      endpoint: null,
      version: deployed.get("gateway").split("@").at(-1),
      imageRef: deployed.get("gateway"),
      digest: deployed.get("gateway").split("@").at(-1),
    }, 3),
    dependency("object-storage", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_S3_INTERNAL_ENDPOINT,
      version: "s3-api-2006-03-01",
      imageRef: null,
      digest: null,
    }, 4),
    dependency("postgres", {
      kind: "deployed-image",
      endpoint: null,
      version: deployed.get("postgres").split("@").at(-1),
      imageRef: deployed.get("postgres"),
      digest: deployed.get("postgres").split("@").at(-1),
    }, 5),
    dependency("reranker", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_KNOWLEDGE_RERANKER_URL,
      version: `${environment.WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST}/${environment.WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION}`,
      imageRef: null,
      digest: null,
    }, 6),
    dependency("tei", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_TEI_URL,
      version: environment.WORKBENCH_TEI_IMAGE_DIGEST,
      imageRef: null,
      digest: null,
    }, 7),
    ...(enterpriseSsoEnabled ? [dependency("enterprise-identity", {
      kind: "external-service",
      endpoint: environment.WORKBENCH_OIDC_PROVIDER_ISSUER,
      version: "idp-2026.07",
      imageRef: null,
      digest: null,
    }, 8)] : []),
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  environment.WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON = JSON.stringify(dependencies);
  environment.WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON = JSON.stringify([
    { name: "better-auth", version: "v17", attestationSha256: "8".repeat(64) },
    { name: "docling-api", version: "v4", attestationSha256: "9".repeat(64) },
    { name: "object-storage-roles", version: "v23", attestationSha256: "a".repeat(64) },
  ]);
  return new Map(Object.entries(environment));
}
