#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const configPath = path.resolve(process.argv[2] || "/opt/quartz/quartz.config.yaml");
const baseUrl = normalizeQuartzBaseUrl(process.env.QUARTZ_BASE_URL || "");
const productUrl = normalizeProductOrigin(process.env.KNOWLEDGE_WEB_URL || "");
let config = await readFile(configPath, "utf8");

config = replaceExactlyOnce(config, /^  baseUrl:.*$/mu, `  baseUrl: ${yamlString(baseUrl)}`);
config = replaceExactlyOnce(
  config,
  /^        业务系统:.*$/mu,
  `        业务系统: ${yamlString(productUrl)}`,
);
config = replaceExactlyOnce(
  config,
  /^        知识维护:.*$/mu,
  `        知识维护: ${yamlString(`${productUrl}/knowledge`)}`,
);

await writeFile(configPath, config, "utf8");

function normalizeQuartzBaseUrl(value) {
  const candidate = value.trim();
  if (!candidate) throw new Error("QUARTZ_BASE_URL is required");
  const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("QUARTZ_BASE_URL must be an HTTP(S) host/path without credentials, query, or fragment");
  }
  const pathname = `/${url.pathname.split("/").filter(Boolean).join("/")}`;
  return `${url.host}${pathname === "/" ? "" : pathname}`;
}

function normalizeProductOrigin(value) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)
  ) {
    throw new Error("KNOWLEDGE_WEB_URL must be an HTTP(S) origin");
  }
  return url.origin;
}

function replaceExactlyOnce(source, pattern, replacement) {
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one Quartz configuration match for ${pattern.source}`);
  }
  return source.replace(pattern, replacement);
}

function yamlString(value) {
  return JSON.stringify(value);
}
