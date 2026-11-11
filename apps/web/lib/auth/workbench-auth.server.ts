import { betterAuth } from "better-auth";
import { genericOAuth, jwt, username } from "better-auth/plugins";
import { Pool } from "pg";

import { discardStoredOidcIdToken } from "./auth-account-storage";
import { workbenchAuthIpAddressOptions } from "./workbench-auth-ip";
import { isWorkbenchEnterpriseSsoEnabled } from "./workbench-enterprise-sso-policy";
import { isWorkbenchPublicRegistrationEnabled } from "./workbench-registration-policy";
import { verifyWorkbenchPassword } from "./workbench-password";
import {
  isWorkbenchUsername,
  WORKBENCH_OIDC_PROVIDER_ID,
  WORKBENCH_PASSWORD_MAX_LENGTH,
  WORKBENCH_PASSWORD_MIN_LENGTH,
  WORKBENCH_USERNAME_MAX_LENGTH,
  WORKBENCH_USERNAME_MIN_LENGTH,
} from "./workbench-auth.shared";

const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

function runtimeEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.env.NODE_ENV !== "production" || isProductionBuild) return fallback;
  throw new Error(`${name} is required`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.includes("REPLACE_WITH_")) throw new Error(`${name} is required`);
  return value;
}

function normalizedOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without a path, query, or fragment`);
  }
  if (process.env.NODE_ENV === "production" && !isProductionBuild && url.protocol !== "https:") {
    throw new Error(`${name} must use https in production`);
  }
  return url.origin;
}

function normalizedIssuer(value: string, name: string): string {
  const url = new URL(value);
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain a query or fragment`);
  }
  if (process.env.NODE_ENV === "production" && !isProductionBuild && url.protocol !== "https:") {
    throw new Error(`${name} must use https in production`);
  }
  return url.href.replace(/\/$/, "");
}

const authOrigin = normalizedOrigin(
  runtimeEnv("BETTER_AUTH_URL", "http://localhost:3000"),
  "BETTER_AUTH_URL",
);
const databaseSchema = runtimeEnv("WORKBENCH_DATABASE_SCHEMA", "workbench");
const publicRegistrationEnabled = isWorkbenchPublicRegistrationEnabled();
const enterpriseSsoEnabled = isWorkbenchEnterpriseSsoEnabled();
const oidcIssuer = enterpriseSsoEnabled
  ? normalizedIssuer(
      requiredEnv("WORKBENCH_OIDC_PROVIDER_ISSUER"),
      "WORKBENCH_OIDC_PROVIDER_ISSUER",
    )
  : null;
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error("WORKBENCH_DATABASE_SCHEMA must be a simple PostgreSQL identifier");
}
const globalForAuth = globalThis as typeof globalThis & {
  workbenchAuthPool?: Pool;
};

const database = globalForAuth.workbenchAuthPool ?? new Pool({
  connectionString: runtimeEnv(
    "WORKBENCH_DATABASE_URL",
    "postgresql://127.0.0.1/workbench?schema=workbench",
  ),
  max: Number.parseInt(process.env.WORKBENCH_AUTH_DB_POOL_MAX ?? "5", 10),
  application_name: "workbench-web-auth",
  options: `-c search_path=${databaseSchema}`,
});

if (process.env.NODE_ENV !== "production") globalForAuth.workbenchAuthPool = database;

export const auth = betterAuth({
  appName: "产品工作台",
  baseURL: authOrigin,
  secret: runtimeEnv(
    "BETTER_AUTH_SECRET",
    "workbench-build-only-secret-not-for-runtime-use",
  ),
  database,
  trustedOrigins: [authOrigin],
  user: {
    modelName: "auth_users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    modelName: "auth_accounts",
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    encryptOAuthTokens: true,
  },
  databaseHooks: {
    account: {
      create: {
        before: async (account) => ({ data: discardStoredOidcIdToken(account) }),
      },
      update: {
        before: async (account) => ({ data: discardStoredOidcIdToken(account) }),
      },
    },
  },
  verification: {
    modelName: "auth_verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: !publicRegistrationEnabled,
    minPasswordLength: WORKBENCH_PASSWORD_MIN_LENGTH,
    maxPasswordLength: WORKBENCH_PASSWORD_MAX_LENGTH,
    password: { verify: verifyWorkbenchPassword },
  },
  session: {
    modelName: "auth_sessions",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
    },
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 10,
    cookieCache: { enabled: false },
  },
  advanced: {
    cookiePrefix: "workbench",
    useSecureCookies: authOrigin.startsWith("https://"),
    database: { generateId: "uuid" },
    ipAddress: workbenchAuthIpAddressOptions(),
  },
  plugins: [
    username({
      minUsernameLength: WORKBENCH_USERNAME_MIN_LENGTH,
      maxUsernameLength: WORKBENCH_USERNAME_MAX_LENGTH,
      usernameValidator: isWorkbenchUsername,
      displayUsernameNormalization: (value) => value.trim(),
      displayUsernameValidator: (value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 && trimmed.length <= 64;
      },
      schema: {
        user: {
          fields: {
            username: "username",
            displayUsername: "display_username",
          },
        },
      },
    }),
    ...(oidcIssuer ? [genericOAuth({
      config: [
        {
          providerId: WORKBENCH_OIDC_PROVIDER_ID,
          discoveryUrl: `${oidcIssuer}/.well-known/openid-configuration`,
          clientId: requiredEnv("WORKBENCH_OIDC_CLIENT_ID"),
          clientSecret: requiredEnv("WORKBENCH_OIDC_CLIENT_SECRET"),
          scopes: ["openid", "profile", "email"],
          pkce: true,
          accessType: "offline",
        },
      ],
    })] : []),
    jwt({
      jwt: {
        issuer: authOrigin,
        audience: "workbench",
        expirationTime: "5 minutes",
      },
      jwks: {
        keyPairConfig: { alg: "RS256", modulusLength: 2048 },
        rotationInterval: 60 * 60 * 24 * 30,
        gracePeriod: 60 * 60 * 24 * 7,
      },
      schema: {
        jwks: {
          modelName: "auth_jwks",
          fields: {
            publicKey: "public_key",
            privateKey: "private_key",
            createdAt: "created_at",
            expiresAt: "expires_at",
          },
        },
      },
      disableSettingJwtHeader: true,
    }),
  ],
});

export async function checkWorkbenchAuthStorage(): Promise<void> {
  await database.query("SELECT 1");
}
