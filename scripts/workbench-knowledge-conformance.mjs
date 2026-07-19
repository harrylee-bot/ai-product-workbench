#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { PrismaClient } from "@workbench/workbench-db";
import { TeiEmbeddingAdapter } from "../apps/workbench-file-worker/dist/knowledge/tei-embedding.adapter.js";
import { TeiRerankerAdapter } from "../apps/workbench-api/dist/modules/knowledge/tei-reranker.adapter.js";
import {
  prepareKnowledgeConformance,
  runKnowledgeConformance,
} from "./workbench-knowledge-conformance-lib.mjs";

const options = readOptions(process.env, process.argv.slice(2));
const db = new PrismaClient();

try {
  await db.$connect();
  const [embeddingRow, retrievalRow, embeddingProbeJson, rerankerProbeJson] = await Promise.all([
    db.embeddingProfile.findUnique({ where: { id: options.embeddingProfileId } }),
    db.retrievalProfile.findUnique({ where: { id: options.retrievalProfileId } }),
    readJson(options.embeddingProbePath),
    readJson(options.rerankerProbePath),
  ]);
  if (!embeddingRow || !retrievalRow) throw new Error("KNOWLEDGE_CONFORMANCE_PROFILE_NOT_FOUND");
  const prepared = prepareKnowledgeConformance({
    embeddingRow,
    retrievalRow,
    embeddingProbeJson,
    rerankerProbeJson,
    expected: {
      embeddingProfileId: options.embeddingProfileId,
      retrievalProfileId: options.retrievalProfileId,
      embeddingImageDigest: options.embeddingImageDigest,
      rerankerImageDigest: options.rerankerImageDigest,
    },
  });

  const embedding = new TeiEmbeddingAdapter({
    origin: options.embeddingOrigin,
    apiKey: options.embeddingApiKey,
    requestTimeoutMs: options.embeddingTimeoutMs,
    maximumRequestBytes: options.embeddingMaximumRequestBytes,
    maximumResponseBytes: options.embeddingMaximumResponseBytes,
    imageDigest: options.embeddingImageDigest,
    profileId: prepared.embeddingProfile.spec.id,
    profileSpecSha256: prepared.embeddingProfile.specSha256,
  });
  const reranker = new TeiRerankerAdapter({
    origin: options.rerankerOrigin,
    apiKey: options.rerankerApiKey,
    requestTimeoutMs: options.rerankerTimeoutMs,
    maximumRequestBytes: options.rerankerMaximumRequestBytes,
    maximumResponseBytes: options.rerankerMaximumResponseBytes,
    imageDigest: options.rerankerImageDigest,
    modelId: prepared.retrievalProfile.spec.reranker.model.id,
    modelRevision: prepared.retrievalProfile.spec.reranker.model.revision,
    teiVersion: prepared.retrievalProfile.spec.reranker.engine.version,
    maximumInputTokens: prepared.retrievalProfile.spec.reranker.tokenizer.maximumInputTokens,
  });
  const report = await runKnowledgeConformance({ prepared, embedding, reranker });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await db.$disconnect().catch(() => undefined);
}

function readOptions(environment, argv) {
  const flags = parseFlags(argv);
  return {
    embeddingProfileId: required(
      flags.embeddingProfile ?? environment.WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID,
      "embedding profile id",
    ),
    retrievalProfileId: required(
      flags.retrievalProfile ?? environment.WORKBENCH_KNOWLEDGE_RETRIEVAL_PROFILE_ID,
      "retrieval profile id",
    ),
    embeddingProbePath: required(
      flags.embeddingProbe ?? environment.WORKBENCH_KNOWLEDGE_EMBEDDING_PROBE_PATH,
      "embedding probe path",
    ),
    rerankerProbePath: required(
      flags.rerankerProbe ?? environment.WORKBENCH_KNOWLEDGE_RERANKER_PROBE_PATH,
      "reranker probe path",
    ),
    embeddingOrigin: serviceOrigin(environment.WORKBENCH_TEI_URL, "WORKBENCH_TEI_URL"),
    embeddingApiKey: optional(environment.WORKBENCH_TEI_API_KEY),
    embeddingImageDigest: imageDigest(environment.WORKBENCH_TEI_IMAGE_DIGEST, "WORKBENCH_TEI_IMAGE_DIGEST"),
    embeddingTimeoutMs: boundedInteger(environment.WORKBENCH_TEI_REQUEST_TIMEOUT_MS, 30_000, 500, 120_000, "WORKBENCH_TEI_REQUEST_TIMEOUT_MS"),
    embeddingMaximumRequestBytes: boundedInteger(environment.WORKBENCH_TEI_MAX_REQUEST_BYTES, 8 * 1024 * 1024, 4_096, 64 * 1024 * 1024, "WORKBENCH_TEI_MAX_REQUEST_BYTES"),
    embeddingMaximumResponseBytes: boundedInteger(environment.WORKBENCH_TEI_MAX_RESPONSE_BYTES, 32 * 1024 * 1024, 4_096, 256 * 1024 * 1024, "WORKBENCH_TEI_MAX_RESPONSE_BYTES"),
    rerankerOrigin: serviceOrigin(environment.WORKBENCH_KNOWLEDGE_RERANKER_URL, "WORKBENCH_KNOWLEDGE_RERANKER_URL"),
    rerankerApiKey: optional(environment.WORKBENCH_KNOWLEDGE_RERANKER_API_KEY),
    rerankerImageDigest: imageDigest(environment.WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST, "WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST"),
    rerankerTimeoutMs: boundedInteger(environment.WORKBENCH_KNOWLEDGE_RERANKER_TIMEOUT_MS, 30_000, 500, 120_000, "WORKBENCH_KNOWLEDGE_RERANKER_TIMEOUT_MS"),
    rerankerMaximumRequestBytes: boundedInteger(environment.WORKBENCH_KNOWLEDGE_RERANKER_MAX_REQUEST_BYTES, 8 * 1024 * 1024, 4_096, 64 * 1024 * 1024, "WORKBENCH_KNOWLEDGE_RERANKER_MAX_REQUEST_BYTES"),
    rerankerMaximumResponseBytes: boundedInteger(environment.WORKBENCH_KNOWLEDGE_RERANKER_MAX_RESPONSE_BYTES, 1024 * 1024, 4_096, 64 * 1024 * 1024, "WORKBENCH_KNOWLEDGE_RERANKER_MAX_RESPONSE_BYTES"),
  };
}

async function readJson(path) {
  const value = await readFile(path);
  if (value.byteLength < 2 || value.byteLength > 2 * 1024 * 1024) {
    throw new Error("KNOWLEDGE_CONFORMANCE_PROBE_SIZE_INVALID");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
}

function parseFlags(argv) {
  const flags = {};
  for (const argument of argv) {
    const match = /^--(embedding-profile|retrieval-profile|embedding-probe|reranker-probe)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const key = match[1].replace(/-([a-z])/gu, (_value, letter) => letter.toUpperCase());
    flags[key] = match[2];
  }
  return flags;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(value, label) {
  const result = optional(value);
  if (!result) throw new Error(`Missing Knowledge conformance ${label}`);
  return result;
}

function serviceOrigin(value, name) {
  const url = new URL(required(value, name));
  if (
    !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)
  ) throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  return url.origin;
}

function imageDigest(value, name) {
  const result = required(value, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${name} must be a pinned image digest`);
  return result;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const result = optional(value) ?? String(fallback);
  if (!/^\d+$/u.test(result)) throw new Error(`${name} must be an integer`);
  const parsed = Number(result);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
