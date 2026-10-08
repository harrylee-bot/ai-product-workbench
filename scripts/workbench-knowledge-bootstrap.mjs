#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@workbench/workbench-db";
import { readBootstrapAccount } from "./workbench-bootstrap-account-lib.mjs";
import { parseBootstrapProfiles, prepareKnowledgeBootstrap, adoptBootstrapProfiles } from "./workbench-knowledge-bootstrap-lib.mjs";
import { prepareKnowledgeConformance, runKnowledgeConformance } from "./workbench-knowledge-conformance-lib.mjs";

const flags = {};
for (const argument of process.argv.slice(2)) {
  if (argument === "--execute") { flags.execute = true; continue; }
  const match = /^--(embedding-profile|retrieval-profile|embedding-probe|reranker-probe|key|version)=(.+)$/u.exec(argument);
  if (!match || Object.hasOwn(flags, match[1])) throw new Error("Invalid or duplicate Knowledge bootstrap argument");
  flags[match[1]] = match[2];
}
const required = (value, key) => { if (!value?.trim()) throw new Error(`Missing ${key}`); return value.trim(); };
const readJson = async (key) => JSON.parse(await readFile(required(flags[key], `--${key}=<path>`), "utf8"));
const [embeddingSpec, retrievalSpec, embeddingProbeJson, rerankerProbeJson] = await Promise.all([
  readJson("embedding-profile"), readJson("retrieval-profile"), readJson("embedding-probe"), readJson("reranker-probe"),
]);
const profiles = parseBootstrapProfiles(embeddingSpec, retrievalSpec);
const expected = {
  embeddingProfileId: profiles.embedding.spec.id, retrievalProfileId: profiles.retrieval.spec.id,
  embeddingImageDigest: profiles.embedding.spec.engine.imageDigest,
  rerankerImageDigest: profiles.retrieval.spec.reranker.engine.imageDigest,
};
const prepared = prepareKnowledgeConformance({
  embeddingRow: { id: profiles.embedding.spec.id, spec: profiles.embedding.spec, specSha256: profiles.embedding.specSha256, dimension: profiles.embedding.dimension, status: "candidate" },
  retrievalRow: { id: profiles.retrieval.spec.id, spec: profiles.retrieval.spec, specSha256: profiles.retrieval.specSha256, status: "candidate",
    embeddingProfileId: profiles.embedding.spec.id, embeddingProfileSpecSha256: profiles.embedding.specSha256, embeddingDimension: profiles.embedding.dimension },
  embeddingProbeJson, rerankerProbeJson, expected,
});
const pins = {
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: profiles.embedding.spec.id,
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: profiles.embedding.specSha256,
  WORKBENCH_KNOWLEDGE_RETRIEVAL_PROFILE_ID: profiles.retrieval.spec.id,
  WORKBENCH_TEI_IMAGE_DIGEST: expected.embeddingImageDigest,
  WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: expected.rerankerImageDigest,
  WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: profiles.retrieval.spec.reranker.model.id,
  WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: profiles.retrieval.spec.reranker.model.revision,
  WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: profiles.retrieval.spec.reranker.engine.version,
  WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: String(profiles.retrieval.spec.reranker.tokenizer.maximumInputTokens),
};
if (!flags.execute) {
  console.log(JSON.stringify({ mode: "plan", environmentPins: pins, steps: ["normal account", "Knowledge operator", "candidate profiles", "live conformance", "profile adoption receipts", "queue knowledge publication"] }, null, 2));
} else {
  const { KnowledgeRetrievalConfig } = await import("../apps/workbench-api/dist/modules/knowledge/knowledge-retrieval.config.js");
  const { TeiEmbeddingAdapter } = await import("../apps/workbench-file-worker/dist/knowledge/tei-embedding.adapter.js");
  const { TeiRerankerAdapter } = await import("../apps/workbench-api/dist/modules/knowledge/tei-reranker.adapter.js");
  const account = readBootstrapAccount();
  const issuer = new URL(required(process.env.BETTER_AUTH_URL, "BETTER_AUTH_URL"));
  if (issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password
    || !["https:", "http:"].includes(issuer.protocol)
    || (process.env.NODE_ENV === "production" && issuer.protocol !== "https:")) throw new Error("BOOTSTRAP_ISSUER_INVALID");
  const key = required(flags.key, "--key");
  const version = required(flags.version, "--version");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key) || !/^[1-9][0-9]*$/u.test(version) || !Number.isSafeInteger(Number(version))) throw new Error("BOOTSTRAP_RELEASE_IDENTITY_INVALID");
  const providers = new KnowledgeRetrievalConfig(new ConfigService({ ...process.env, ...pins })).providers;
  if (!providers) throw new Error("BOOTSTRAP_PROVIDERS_REQUIRED");
  const authorizedBy = required(process.env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_AUTHORIZED_BY, "WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_AUTHORIZED_BY");
  const changeReference = required(process.env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE, "WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE");
  const datasourceUrl = required(process.env.WORKBENCH_MIGRATOR_DATABASE_URL, "WORKBENCH_MIGRATOR_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl });
  try {
    const identity = await prepareKnowledgeBootstrap(db, { account, issuer: issuer.origin, authorizedBy, changeReference, profiles });
    const embedding = new TeiEmbeddingAdapter(providers.embedding);
    const reranker = new TeiRerankerAdapter(providers.reranker);
    await reranker.assertReady(profiles.retrieval.spec.reranker.candidateLimit);
    const conformance = await runKnowledgeConformance({ prepared, embedding, reranker });
    if (!conformance.ok) {
      console.log(JSON.stringify({ mode: "execute", conformance }, null, 2));
      throw new Error("BOOTSTRAP_LIVE_CONFORMANCE_FAILED");
    }
    await adoptBootstrapProfiles(db, identity.principalId, profiles);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL("./workbench-knowledge-release.mjs", import.meta.url).pathname,
        `--key=${key}`, `--version=${version}`, `--embedding-profile=${profiles.embedding.spec.id}`, `--retrieval-profile=${profiles.retrieval.spec.id}`,
      ], { stdio: "inherit", env: { ...process.env, ...pins } });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("BOOTSTRAP_PUBLICATION_QUEUE_FAILED")));
    });
    console.log(JSON.stringify({ mode: "execute", ...identity, environmentPins: pins, conformance, publication: "queued; wait for File Worker and API readiness" }, null, 2));
  } finally { await db.$disconnect(); }
}
