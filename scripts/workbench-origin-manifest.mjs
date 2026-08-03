#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROHIBITED_COOKIE_DOMAIN_KEYS = Object.freeze([
  "BETTER_AUTH_COOKIE_DOMAIN",
  "WORKBENCH_AUTH_COOKIE_DOMAIN",
  "WORKBENCH_COOKIE_DOMAIN",
]);

export function readDeploymentEnv(source, { label = "deployment environment" } = {}) {
  const text = decodeEnvironmentSource(source, label);
  const values = new Map();
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (rawLine !== line) {
      throw new Error(`${label} entry at line ${index + 1} must not have leading or trailing whitespace`);
    }
    const separator = rawLine.indexOf("=");
    if (separator <= 0) throw new Error(`invalid ${label} entry at line ${index + 1}`);
    const name = rawLine.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`invalid ${label} name at line ${index + 1}`);
    }
    if (values.has(name)) throw new Error(`${name} must occur exactly once`);
    values.set(name, parseCanonicalEnvironmentValue(rawLine.slice(separator + 1), name, index + 1, label));
  }
  return values;
}

function decodeEnvironmentSource(source, label) {
  if (typeof source === "string") return source;
  if (!(source instanceof Uint8Array)) throw new Error(`${label} must be UTF-8 text`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
}

function parseCanonicalEnvironmentValue(encoded, name, lineNumber, label) {
  if (encoded.startsWith('"') || encoded.startsWith("'")) {
    throw new Error(`${name} at line ${lineNumber} must not use quoted syntax in ${label}`);
  }
  if (/[\s$\\]/u.test(encoded)) {
    throw new Error(
      `${name} at line ${lineNumber} must not contain whitespace, $, or a backslash`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(encoded)) {
    throw new Error(`${name} at line ${lineNumber} contains a forbidden control character`);
  }
  return encoded;
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
  });
  const enterpriseSsoEnabled = optionalBoolean(
    environment,
    "WORKBENCH_ENTERPRISE_SSO_ENABLED",
    false,
  );
  const enterpriseSsoKeys = [
    "WORKBENCH_OIDC_PROVIDER_ISSUER",
    "WORKBENCH_OIDC_CLIENT_ID",
    "WORKBENCH_OIDC_CLIENT_SECRET",
    "WORKBENCH_IDENTITY_HOSTNAME",
  ];
  let issuer = null;
  if (enterpriseSsoEnabled) {
    issuer = strictHttpsUrl(required(environment, "WORKBENCH_OIDC_PROVIDER_ISSUER"), {
      name: "WORKBENCH_OIDC_PROVIDER_ISSUER",
      allowPath: true,
    });
    required(environment, "WORKBENCH_OIDC_CLIENT_ID");
    required(environment, "WORKBENCH_OIDC_CLIENT_SECRET");
    const configuredIdentityHostname = environment.get("WORKBENCH_IDENTITY_HOSTNAME")?.trim();
    if (configuredIdentityHostname) {
      assertHostname(configuredIdentityHostname, "WORKBENCH_IDENTITY_HOSTNAME");
      if (configuredIdentityHostname !== issuer.hostname) {
        throw new Error("WORKBENCH_IDENTITY_HOSTNAME must equal the OIDC issuer hostname");
      }
    }
  } else {
    for (const key of enterpriseSsoKeys) {
      if (environment.get(key)?.trim()) {
        throw new Error(`${key} must be empty when enterprise SSO is disabled`);
      }
    }
  }

  for (const key of PROHIBITED_COOKIE_DOMAIN_KEYS) {
    if (environment.get(key)?.trim()) {
      throw new Error(`${key} is forbidden; Better Auth cookies must remain host-only`);
    }
  }

  const publicHostnames = [
    web.hostname,
    preview.hostname,
    uploads.hostname,
    ...(issuer ? [issuer.hostname] : []),
  ];
  if (new Set(publicHostnames).size !== publicHostnames.length) {
    throw new Error("Web, Preview, browser upload, and enabled identity hostnames must be distinct");
  }

  return Object.freeze({
    schemaVersion: 1,
    webOrigin: web.origin,
    webHostname: web.hostname,
    previewOrigin: preview.origin,
    previewHostname: preview.hostname,
    s3BrowserBucketUrl: uploads.href.replace(/\/$/u, ""),
    s3Hostname: uploads.hostname,
    enterpriseSsoEnabled,
    oidcIssuer: issuer?.href.replace(/\/$/u, "") ?? null,
    identityHostname: issuer?.hostname ?? null,
    authCookie: Object.freeze({
      domainPolicy: "host-only",
      hostname: web.hostname,
      secure: true,
    }),
  });
}

export function renderCaddyEnvironment(manifest) {
  const lines = [
    `WORKBENCH_WEB_HOSTNAME=${manifest.webHostname}`,
    `WORKBENCH_PREVIEW_HOSTNAME=${manifest.previewHostname}`,
    `WORKBENCH_S3_HOSTNAME=${manifest.s3Hostname}`,
  ];
  if (manifest.identityHostname) {
    lines.push(`WORKBENCH_IDENTITY_HOSTNAME=${manifest.identityHostname}`);
  }
  return `${lines.join("\n")}\n`;
}

function strictHttpsUrl(value, { name, allowPath }) {
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

function optionalBoolean(environment, name, fallback) {
  const value = environment.get(name)?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
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
  const source = readFileSync(resolve(args.envFile));
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
