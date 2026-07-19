#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROHIBITED_COOKIE_DOMAIN_KEYS = Object.freeze([
  "BETTER_AUTH_COOKIE_DOMAIN",
  "WORKBENCH_AUTH_COOKIE_DOMAIN",
  "WORKBENCH_COOKIE_DOMAIN",
]);

export function readDeploymentEnv(source) {
  const values = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = rawLine.indexOf("=");
    if (separator <= 0) throw new Error(`invalid environment entry at line ${index + 1}`);
    const name = rawLine.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`invalid environment name at line ${index + 1}`);
    }
    if (values.has(name)) throw new Error(`${name} must occur exactly once`);
    values.set(name, stripMatchingQuotes(rawLine.slice(separator + 1).trim()));
  }
  return values;
}

export function deriveOriginManifest(environment) {
  const web = strictHttpsUrl(required(environment, "WORKBENCH_WEB_ORIGIN"), {
    name: "WORKBENCH_WEB_ORIGIN",
    allowPath: false,
  });
  const preview = strictHttpsUrl(required(environment, "WORKBENCH_PREVIEW_ORIGIN"), {
    name: "WORKBENCH_PREVIEW_ORIGIN",
    allowPath: false,
  });
  const uploads = strictHttpsUrl(required(environment, "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL"), {
    name: "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL",
    allowPath: true,
    requirePath: true,
  });
  const issuer = strictHttpsUrl(required(environment, "WORKBENCH_OIDC_PROVIDER_ISSUER"), {
    name: "WORKBENCH_OIDC_PROVIDER_ISSUER",
    allowPath: true,
  });
  const configuredIdentityHostname = required(environment, "WORKBENCH_IDENTITY_HOSTNAME").toLowerCase();
  assertHostname(configuredIdentityHostname, "WORKBENCH_IDENTITY_HOSTNAME");
  if (configuredIdentityHostname !== issuer.hostname) {
    throw new Error("WORKBENCH_IDENTITY_HOSTNAME must equal the OIDC issuer hostname");
  }

  for (const key of PROHIBITED_COOKIE_DOMAIN_KEYS) {
    if (environment.get(key)?.trim()) {
      throw new Error(`${key} is forbidden; Better Auth cookies must remain host-only`);
    }
  }

  const publicHostnames = [web.hostname, preview.hostname, uploads.hostname, issuer.hostname];
  if (new Set(publicHostnames).size !== publicHostnames.length) {
    throw new Error("Web, Preview, browser upload, and identity hostnames must be distinct");
  }

  return Object.freeze({
    schemaVersion: 1,
    webOrigin: web.origin,
    webHostname: web.hostname,
    previewOrigin: preview.origin,
    previewHostname: preview.hostname,
    s3BrowserBucketUrl: uploads.href.replace(/\/$/u, ""),
    s3Hostname: uploads.hostname,
    oidcIssuer: issuer.href.replace(/\/$/u, ""),
    identityHostname: issuer.hostname,
    authCookie: Object.freeze({
      domainPolicy: "host-only",
      hostname: web.hostname,
      secure: true,
    }),
  });
}

export function renderCaddyEnvironment(manifest) {
  return [
    `WORKBENCH_WEB_HOSTNAME=${manifest.webHostname}`,
    `WORKBENCH_PREVIEW_HOSTNAME=${manifest.previewHostname}`,
    `WORKBENCH_S3_HOSTNAME=${manifest.s3Hostname}`,
    `WORKBENCH_IDENTITY_HOSTNAME=${manifest.identityHostname}`,
    "",
  ].join("\n");
}

function strictHttpsUrl(value, { name, allowPath, requirePath = false }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a port, query, or fragment`);
  }
  assertHostname(url.hostname, name);
  if (!allowPath && url.pathname !== "/") throw new Error(`${name} must not contain a path`);
  if (requirePath && url.pathname === "/") throw new Error(`${name} must include the bucket path`);
  if (/\/{2,}/u.test(url.pathname) || /(?:^|\/)\.\.?\//u.test(url.pathname)) {
    throw new Error(`${name} contains an ambiguous path`);
  }
  return url;
}

function assertHostname(value, name) {
  if (value !== value.toLowerCase() || !HOSTNAME_PATTERN.test(value) || value.includes("..")) {
    throw new Error(`${name} must contain a canonical lowercase DNS hostname`);
  }
}

function required(environment, name) {
  const value = environment.get(name)?.trim();
  if (!value || value.includes("REPLACE_WITH_")) throw new Error(`${name} is required`);
  return value;
}

function stripMatchingQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArguments(argv) {
  const result = { format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env-file") result.envFile = argv[++index];
    else if (argument === "--format") result.format = argv[++index];
    else throw new Error(`unsupported argument: ${argument}`);
  }
  if (!result.envFile) throw new Error("--env-file is required");
  if (!["json", "caddy-env"].includes(result.format)) throw new Error("--format must be json or caddy-env");
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = readFileSync(resolve(args.envFile), "utf8");
  const manifest = deriveOriginManifest(readDeploymentEnv(source));
  process.stdout.write(args.format === "caddy-env"
    ? renderCaddyEnvironment(manifest)
    : `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`workbench origin manifest: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
