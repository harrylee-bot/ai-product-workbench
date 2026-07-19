// @vitest-environment node

import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Better Auth product accounts on PostgreSQL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers once, signs in by username or email, and preserves the short JWT contract", async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
    const username = `product_${suffix}`.slice(0, 30);
    const email = `${username}@example.test`;
    const password = `Wb!${suffix}Aa1`;
    const pool = new Pool({ connectionString: databaseUrl });

    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "product-account-postgres-test-secret-with-32-bytes");
    vi.stubEnv("WORKBENCH_DATABASE_URL", databaseUrl!);
    vi.stubEnv("WORKBENCH_DATABASE_SCHEMA", "workbench");
    vi.stubEnv("WORKBENCH_AUTH_CLIENT_IP_HEADER", "x-workbench-client-ip");
    vi.stubEnv("WORKBENCH_OIDC_PROVIDER_ISSUER", "http://127.0.0.1:9080/realms/workbench");
    vi.stubEnv("WORKBENCH_OIDC_CLIENT_ID", "workbench-web-test");
    vi.stubEnv("WORKBENCH_OIDC_CLIENT_SECRET", "workbench-oidc-test-secret");

    try {
      const { auth } = await import("./workbench-auth.server");
      const signUp = await auth.handler(authRequest("/sign-up/email", {
        email,
        name: "Product Owner",
        password,
        username: username.toUpperCase(),
        displayUsername: "Product Owner",
      }));
      expect(signUp.status).toBe(200);
      const registered = await signUp.json() as {
        user: { id: string; username: string; displayUsername: string };
      };
      expect(registered.user).toMatchObject({
        username,
        displayUsername: "Product Owner",
      });

      const usernameSignIn = await auth.handler(authRequest("/sign-in/username", {
        username: username.toUpperCase(),
        password,
      }));
      expect(usernameSignIn.status).toBe(200);
      const usernameSession = await usernameSignIn.json() as {
        user: { id: string; username: string };
      };
      expect(usernameSession.user).toMatchObject({ id: registered.user.id, username });
      const cookie = sessionCookie(usernameSignIn);

      const emailSignIn = await auth.handler(authRequest("/sign-in/email", {
        email: email.toUpperCase(),
        password,
      }));
      expect(emailSignIn.status).toBe(200);
      await expect(emailSignIn.json()).resolves.toMatchObject({
        user: { id: registered.user.id },
      });

      const tokenResponse = await auth.handler(new Request(
        "http://localhost:3000/api/auth/token",
        { headers: authHeaders({ Cookie: cookie }) },
      ));
      expect(tokenResponse.status).toBe(200);
      const { token } = await tokenResponse.json() as { token: string };
      const claims = decodeJwt(token);
      expect(claims.sub).toBe(registered.user.id);
      expect(claims.iss).toBe("http://localhost:3000");
      expect(claims.aud).toBe("workbench");
      expect(claims.exp! - claims.iat!).toBe(300);

      const stored = await pool.query<{
        username: string;
        display_username: string;
        credential_count: string;
      }>(`
        SELECT u.username, u.display_username,
          count(a.id) FILTER (WHERE a.provider_id = 'credential')::text AS credential_count
        FROM workbench.auth_users u
        LEFT JOIN workbench.auth_accounts a ON a.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id
      `, [registered.user.id]);
      expect(stored.rows).toEqual([{
        username,
        display_username: "Product Owner",
        credential_count: "1",
      }]);
    } finally {
      await pool.query("DELETE FROM workbench.auth_users WHERE email = $1", [email]);
      await pool.end();
    }
  }, 20_000);
});

function authRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function authHeaders(values: Record<string, string>) {
  return {
    Origin: "http://localhost:3000",
    "X-Workbench-Client-IP": "127.0.0.1",
    ...values,
  };
}

function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}
