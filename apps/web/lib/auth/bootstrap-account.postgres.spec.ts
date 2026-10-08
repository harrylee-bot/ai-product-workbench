// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Offline normal-account bootstrap", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("supports real password login with registration closed, idempotent replay and no operator grant", async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const script = new URL("../../../../scripts/workbench-bootstrap-account-lib.mjs", import.meta.url).href;
    const { ensureWorkbenchPasswordAccount, readBootstrapAccount } = await import(script);
    const username = `bootstrap_${randomUUID().slice(0, 12)}`;
    const input = readBootstrapAccount({ WORKBENCH_BOOTSTRAP_ACCOUNT_EMAIL: `${username}@example.test`, WORKBENCH_BOOTSTRAP_ACCOUNT_USERNAME: username, WORKBENCH_BOOTSTRAP_ACCOUNT_PASSWORD: `Test-only-${randomUUID()}` });
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "isolated-bootstrap-regression-secret-32bytes");
    vi.stubEnv("WORKBENCH_DATABASE_URL", databaseUrl!);
    vi.stubEnv("WORKBENCH_DATABASE_SCHEMA", "workbench");
    vi.stubEnv("WORKBENCH_AUTH_CLIENT_IP_HEADER", "x-workbench-client-ip");
    vi.stubEnv("WORKBENCH_PUBLIC_REGISTRATION_ENABLED", "false");
    try {
      const created = await ensureWorkbenchPasswordAccount(db, input);
      expect(created.created).toBe(true);
      expect(await ensureWorkbenchPasswordAccount(db, input)).toEqual({ id: created.id, created: false });
      await expect(ensureWorkbenchPasswordAccount(db, { ...input, password: "Wrong-test-password" })).rejects.toThrow("BOOTSTRAP_ACCOUNT_REPLAY_CREDENTIAL_MISMATCH");
      expect(await db.principal.count({ where: { subject: created.id } })).toBe(0);
      const { auth } = await import("./workbench-auth.server");
      const request = (path: string, body: unknown) => new Request(`http://localhost:3000/api/auth/${path}`, { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-Workbench-Client-IP": "127.0.0.1" }, body: JSON.stringify(body) });
      const signIn = await auth.handler(request("sign-in/username", { username, password: input.password }));
      expect(signIn.status).toBe(200);
      expect((await signIn.json()).user.id).toBe(created.id);
      const signUp = await auth.handler(request("sign-up/email", { username: `${username}a`, email: `${username}a@example.test`, name: "blocked", password: input.password }));
      expect(signUp.status).toBe(400);
    } finally {
      await db.authUser.deleteMany({ where: { email: input.email } });
      await db.$disconnect();
    }
  }, 30_000);
});
