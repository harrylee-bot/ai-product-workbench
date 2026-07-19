import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Better Auth production registration policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ["unset", undefined],
    ["false", "false"],
  ])("rejects a direct signup HTTP request when the policy is %s", async (_label, policy) => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
    const email = `closed_${suffix}@example.test`;
    const pool = new Pool({ connectionString: databaseUrl });
    stubProductionAuthEnvironment(policy);

    try {
      const { auth } = await import("./workbench-auth.server");
      const response = await auth.handler(new Request(
        "https://workbench.example.test/api/auth/sign-up/email",
        {
          method: "POST",
          headers: {
            Origin: "https://workbench.example.test",
            "Content-Type": "application/json",
            "X-Workbench-Client-IP": "192.0.2.10",
          },
          body: JSON.stringify({
            email,
            name: "Closed Registration",
            password: "ClosedRegistration!2026",
            username: `closed_${suffix}`.slice(0, 30),
            displayUsername: "Closed Registration",
          }),
        },
      ));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
      });
      const stored = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workbench.auth_users WHERE email = $1",
        [email],
      );
      expect(stored.rows).toEqual([{ count: "0" }]);
    } finally {
      await pool.query("DELETE FROM workbench.auth_users WHERE email = $1", [email]);
      await pool.end();
    }
  }, 20_000);
});

function stubProductionAuthEnvironment(publicRegistrationPolicy: string | undefined) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.stubEnv("BETTER_AUTH_URL", "https://workbench.example.test");
  vi.stubEnv("BETTER_AUTH_SECRET", "production-registration-policy-test-secret");
  vi.stubEnv("WORKBENCH_DATABASE_URL", databaseUrl!);
  vi.stubEnv("WORKBENCH_DATABASE_SCHEMA", "workbench");
  vi.stubEnv("WORKBENCH_AUTH_CLIENT_IP_HEADER", "x-workbench-client-ip");
  vi.stubEnv("WORKBENCH_OIDC_PROVIDER_ISSUER", "https://identity.example.test/realms/workbench");
  vi.stubEnv("WORKBENCH_OIDC_CLIENT_ID", "workbench-web-test");
  vi.stubEnv("WORKBENCH_OIDC_CLIENT_SECRET", "workbench-oidc-test-secret");
  if (publicRegistrationPolicy === undefined) {
    delete process.env.WORKBENCH_PUBLIC_REGISTRATION_ENABLED;
  } else {
    vi.stubEnv("WORKBENCH_PUBLIC_REGISTRATION_ENABLED", publicRegistrationPolicy);
  }
}
