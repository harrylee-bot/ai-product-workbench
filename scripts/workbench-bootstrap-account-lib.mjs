import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma } from "@workbench/workbench-db";

const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));

export function readBootstrapAccount(env = process.env) {
  const email = (env.WORKBENCH_BOOTSTRAP_ACCOUNT_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const username = (env.WORKBENCH_BOOTSTRAP_ACCOUNT_USERNAME ?? env.BOOTSTRAP_ADMIN_USERNAME ?? "").trim().toLowerCase();
  const password = env.WORKBENCH_BOOTSTRAP_ACCOUNT_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) throw new Error("BOOTSTRAP_ACCOUNT_EMAIL_INVALID");
  if (!/^[a-z0-9_.-]{3,30}$/u.test(username)) throw new Error("BOOTSTRAP_ACCOUNT_USERNAME_INVALID");
  if (password.length < 8 || password.length > 128 || password.includes("REPLACE_WITH_")) {
    throw new Error("BOOTSTRAP_ACCOUNT_PASSWORD_INVALID");
  }
  return { email, username, password, name: username };
}

// This creates a normal password account only. It never changes registration
// policy, existing passwords, memberships, or Knowledge operator privileges.
export async function ensureWorkbenchPasswordAccount(db, input) {
  const { hashPassword, verifyPassword } = await import(pathToFileURL(webRequire.resolve("better-auth/crypto")).href);
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('workbench.bootstrap.account', 0))::TEXT`);
    const existing = await tx.authUser.findFirst({ where: { OR: [{ email: input.email }, { username: input.username }] } });
    if (existing) {
      if (existing.email !== input.email || existing.username !== input.username) throw new Error("BOOTSTRAP_ACCOUNT_IDENTITY_CONFLICT");
      const account = await tx.authAccount.findUnique({ where: { providerId_accountId: { providerId: "credential", accountId: existing.id } } });
      if (!account?.password || account.userId !== existing.id || !await verifyPassword({ hash: account.password, password: input.password })) {
        throw new Error("BOOTSTRAP_ACCOUNT_REPLAY_CREDENTIAL_MISMATCH");
      }
      return { id: existing.id, created: false };
    }
    const now = new Date();
    const id = randomUUID();
    const user = await tx.authUser.create({ data: {
      id, name: input.name, email: input.email, username: input.username,
      displayUsername: input.username, emailVerified: false,
      accounts: { create: { providerId: "credential", accountId: id, password: passwordHash, updatedAt: now } },
    } });
    return { id: user.id, created: true };
  });
}
