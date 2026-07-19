import { describe, expect, it } from "vitest";

import {
  buildSecurityHeaders,
  normalizeBrowserUploadBucketUrl,
} from "../../security-headers";

describe("Workbench asset security headers", () => {
  it("allows only local object URLs for authorized Prototype font bytes", () => {
    const contentSecurityPolicy = buildSecurityHeaders({ isProduction: true })
      .find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain("font-src 'self' data: blob:");
    expect(contentSecurityPolicy).not.toContain("font-src 'self' data: blob: https:");
  });

  it("allows the isolated Preview origin as a frame and the exact upload origin for PUT traffic", () => {
    const contentSecurityPolicy = buildSecurityHeaders({
      isProduction: true,
      previewOrigin: "https://preview.workbench.example.test",
      uploadBucketUrl: "https://uploads.workbench.example.test/workbench-files",
    }).find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain(
      "frame-src 'self' blob: https://preview.workbench.example.test",
    );
    expect(contentSecurityPolicy).toContain(
      "connect-src 'self' https://uploads.workbench.example.test",
    );
    expect(contentSecurityPolicy).not.toContain("/workbench-files");
  });

  it("keeps development API traffic on the same-origin BFF", () => {
    const contentSecurityPolicy = buildSecurityHeaders({
      isProduction: false,
      previewOrigin: "http://localhost:4300",
    }).find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain("connect-src 'self'");
    expect(contentSecurityPolicy).not.toContain("localhost:4000");
    expect(contentSecurityPolicy).not.toContain("127.0.0.1:4000");
  });

  it("fails closed for Preview frames in production when no origin is configured", () => {
    const contentSecurityPolicy = buildSecurityHeaders({ isProduction: true })
      .find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain("frame-src 'self' blob:");
    expect(contentSecurityPolicy).not.toContain("frame-src 'self' blob: http");
  });

  it("fails closed for an invalid browser upload URL", () => {
    const contentSecurityPolicy = buildSecurityHeaders({
      isProduction: true,
      uploadBucketUrl: "javascript:alert(1)",
    }).find((header) => header.key === "Content-Security-Policy")?.value;

    expect(contentSecurityPolicy).toContain("connect-src 'self'");
    expect(contentSecurityPolicy).not.toContain("javascript:");
  });

  it("requires a secure browser upload bucket URL for production builds", () => {
    expect(() => normalizeBrowserUploadBucketUrl(undefined, true))
      .toThrow("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL is required");
    expect(() => normalizeBrowserUploadBucketUrl(
      "http://uploads.workbench.example.test/workbench-files",
      true,
    )).toThrow("must be HTTPS in production");
    expect(normalizeBrowserUploadBucketUrl(
      "http://127.0.0.1:9000/workbench-files/",
      true,
    )).toBe("http://127.0.0.1:9000/workbench-files");
    expect(normalizeBrowserUploadBucketUrl(
      "https://uploads.workbench.example.test/workbench-files/",
      true,
    )).toBe("https://uploads.workbench.example.test/workbench-files");
  });
});
