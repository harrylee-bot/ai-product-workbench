import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUserHtmlCsp } from "../src/ai/user-html-security";

describe("user HTML security headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not include localhost frame ancestors in production unless explicitly configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_ORIGIN", "https://aionbench.com");

    const csp = buildUserHtmlCsp();

    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self' https://aionbench.com");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toContain("127.0.0.1");
  });

  it("keeps local frame ancestors only for development preview", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_ORIGIN", "");

    const csp = buildUserHtmlCsp();

    expect(csp).toContain("http://localhost:3000");
    expect(csp).toContain("http://127.0.0.1:3000");
  });
});
