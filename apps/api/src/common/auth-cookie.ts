import type { CookieOptions } from "express";

export const AUTH_COOKIE_NAME = "access_token";

export function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: authCookieSameSite(),
    secure: authCookieSecure(),
    path: "/",
    maxAge: jwtCookieMaxAgeMs(),
  };
}

export function clearAuthCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...options } = authCookieOptions();
  return options;
}

function authCookieSecure() {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured) return configured === "true" || configured === "1";
  return process.env.NODE_ENV === "production";
}

function authCookieSameSite(): CookieOptions["sameSite"] {
  const configured = process.env.AUTH_COOKIE_SAME_SITE?.trim().toLowerCase();
  if (configured === "strict" || configured === "lax" || configured === "none") return configured;
  return "lax";
}

function jwtCookieMaxAgeMs() {
  const explicit = process.env.JWT_COOKIE_MAX_AGE_MS?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return parseDurationMs(process.env.JWT_EXPIRES_IN?.trim()) ?? 7 * 24 * 60 * 60 * 1000;
}

function parseDurationMs(value?: string) {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const unit = match[2].toLowerCase();
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return Math.round(amount * multiplier[unit]);
}
