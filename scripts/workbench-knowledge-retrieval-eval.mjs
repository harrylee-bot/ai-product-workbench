#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateKnowledgeRetrieval,
  parseKnowledgeRetrievalEvaluationDatasetV1,
  parseKnowledgeRetrievalEvaluationResultsV1,
  renderKnowledgeRetrievalEvaluationMarkdown,
} from "@workbench/workbench-knowledge";

const options = parseOptions(process.argv.slice(2));
const [datasetJson, resultsJson] = await Promise.all([
  readJson(options.datasetPath, "dataset"),
  readJson(options.resultsPath, "results"),
]);
const dataset = parseKnowledgeRetrievalEvaluationDatasetV1(datasetJson);
const results = parseKnowledgeRetrievalEvaluationResultsV1(resultsJson, dataset);
const report = evaluateKnowledgeRetrieval(dataset, results);
const markdown = renderKnowledgeRetrievalEvaluationMarkdown(report);

await mkdir(options.outputDirectory, { recursive: true });
const jsonPath = path.join(options.outputDirectory, "workbench-knowledge-retrieval-evaluation.json");
const markdownPath = path.join(options.outputDirectory, "workbench-knowledge-retrieval-evaluation.md");
await Promise.all([
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
  atomicWrite(markdownPath, markdown),
]);

console.log(JSON.stringify({
  ok: report.passed,
  dataset: report.dataset,
  metrics: report.metrics,
  gates: report.gates,
  failures: report.failures,
  output: { jsonPath, markdownPath },
}, null, 2));
if (!report.passed) process.exitCode = 1;

function parseOptions(argv) {
  const flags = {};
  for (const argument of argv) {
    const match = /^--(dataset|results|output-dir)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    flags[match[1]] = match[2];
  }
  return {
    datasetPath: path.resolve(required(flags.dataset, "--dataset")),
    resultsPath: path.resolve(required(flags.results, "--results")),
    outputDirectory: path.resolve(required(flags["output-dir"], "--output-dir")),
  };
}

async function readJson(filePath, label) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > 32 * 1024 * 1024) {
    throw new Error(`Knowledge retrieval evaluation ${label} file size is invalid`);
  }
  const bytes = await readFile(filePath);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`Knowledge retrieval evaluation ${label} must be valid UTF-8 JSON`, { cause });
  }
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required ${name} argument`);
  return value;
}
