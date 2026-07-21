import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveOriginManifest,
  readDeploymentEnv,
  renderCaddyEnvironment,
} from "./workbench-origin-manifest.mjs";

test("derives every Caddy hostname from the validated public URLs", () => {
  const manifest = deriveOriginManifest(environment({
    WORKBENCH_WEB_ORIGIN: "https://studio.alpha.example",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.alpha.example",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.alpha.example/workbench",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.alpha.example/realms/workbench",
    WORKBENCH_IDENTITY_HOSTNAME: "identity.alpha.example",
  }));

  assert.deepEqual(manifest.authCookie, {
    domainPolicy: "host-only",
    hostname: "studio.alpha.example",
    secure: true,
  });
  assert.equal(manifest.enterpriseSsoEnabled, true);
  assert.match(renderCaddyEnvironment(manifest), /WORKBENCH_PREVIEW_HOSTNAME=preview\.alpha\.example/u);
});

test("omits identity configuration when enterprise SSO is disabled", () => {
  const manifest = deriveOriginManifest(environment({
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "false",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "",
    WORKBENCH_OIDC_CLIENT_ID: "",
    WORKBENCH_OIDC_CLIENT_SECRET: "",
    WORKBENCH_IDENTITY_HOSTNAME: "",
  }));

  assert.equal(manifest.enterpriseSsoEnabled, false);
  assert.equal(manifest.oidcIssuer, null);
  assert.equal(manifest.identityHostname, null);
  assert.doesNotMatch(renderCaddyEnvironment(manifest), /IDENTITY/u);
});

test("supports a second deployment domain without product-domain constants", () => {
  const manifest = deriveOriginManifest(environment({
    WORKBENCH_WEB_ORIGIN: "https://workbench.beta.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.beta.test",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://objects.beta.test/workbench",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://sso.beta.test/dex",
    WORKBENCH_IDENTITY_HOSTNAME: "sso.beta.test",
  }));

  assert.equal(manifest.webHostname, "workbench.beta.test");
  assert.equal(manifest.s3Hostname, "objects.beta.test");
  assert.equal(manifest.identityHostname, "sso.beta.test");
});

test("supports virtual-hosted object storage at the custom-domain root", () => {
  const manifest = deriveOriginManifest(environment({
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test",
  }));

  assert.equal(manifest.s3BrowserBucketUrl, "https://uploads.example.test");
  assert.equal(manifest.s3Hostname, "uploads.example.test");
});

test("derives the identity hostname without a redundant production setting", () => {
  const manifest = deriveOriginManifest(environment({
    WORKBENCH_IDENTITY_HOSTNAME: "",
  }));

  assert.equal(manifest.enterpriseSsoEnabled, true);
  assert.equal(manifest.identityHostname, "identity.example.test");
});

for (const [label, overrides, pattern] of [
  ["non-HTTPS origin", { WORKBENCH_WEB_ORIGIN: "http://workbench.example.test" }, /must use HTTPS/u],
  ["same Web and Preview host", { WORKBENCH_PREVIEW_ORIGIN: "https://workbench.example.test" }, /must be distinct/u],
  ["Preview port", { WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test:8443" }, /must not contain credentials, a port/u],
  ["issuer hostname drift", { WORKBENCH_IDENTITY_HOSTNAME: "other.example.test" }, /must equal the OIDC issuer hostname/u],
  ["ambiguous SSO policy", { WORKBENCH_ENTERPRISE_SSO_ENABLED: "1" }, /must be true or false/u],
  ["enabled SSO without a client id", { WORKBENCH_OIDC_CLIENT_ID: "" }, /WORKBENCH_OIDC_CLIENT_ID is required/u],
  ["disabled SSO with dormant provider configuration", {
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "false",
  }, /must be empty when enterprise SSO is disabled/u],
  ["shared cookie domain", { WORKBENCH_COOKIE_DOMAIN: ".example.test" }, /cookies must remain host-only/u],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => deriveOriginManifest(environment(overrides)), pattern);
  });
}

test("rejects duplicate environment keys", () => {
  assert.throws(
    () => readDeploymentEnv("WORKBENCH_WEB_ORIGIN=https://one.test\nWORKBENCH_WEB_ORIGIN=https://two.test\n"),
    /must occur exactly once/u,
  );
});

function environment(overrides = {}) {
  return new Map(Object.entries({
    WORKBENCH_WEB_ORIGIN: "https://workbench.example.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test/workbench",
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "true",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.example.test/realms/workbench",
    WORKBENCH_OIDC_CLIENT_ID: "workbench-web",
    WORKBENCH_OIDC_CLIENT_SECRET: "oidc-secret",
    WORKBENCH_IDENTITY_HOSTNAME: "identity.example.test",
    ...overrides,
  }));
}
