import { parseConditionalObjectCreateMode } from "@workbench/workbench-content-security";

export function loadPrototypeArtifactStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  const endpoint = env.WORKBENCH_S3_INTERNAL_ENDPOINT?.trim() || undefined;
  const forcePathStyle = env.WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE?.trim();
  if (forcePathStyle && forcePathStyle !== "true" && forcePathStyle !== "false") {
    throw new Error("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE must be true or false");
  }
  return {
    artifactBucket: env.WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET?.trim() || env.WORKBENCH_S3_BUCKET?.trim() || "",
    artifactPrefix: env.WORKBENCH_PROTOTYPE_ARTIFACT_S3_PREFIX?.trim() || "prototype-v2",
    artifactEndpoint: endpoint,
    artifactRegion: env.WORKBENCH_S3_REGION?.trim() || "us-east-1",
    artifactForcePathStyle: forcePathStyle ? forcePathStyle === "true" : Boolean(endpoint),
    artifactConditionalCreateMode: parseConditionalObjectCreateMode(env.WORKBENCH_S3_CONDITIONAL_CREATE_MODE),
    artifactAccessKeyId: env.WORKBENCH_PROTOTYPE_ARTIFACT_S3_ACCESS_KEY_ID?.trim() || undefined,
    artifactSecretAccessKey: env.WORKBENCH_PROTOTYPE_ARTIFACT_S3_SECRET_ACCESS_KEY?.trim() || undefined,
  };
}
