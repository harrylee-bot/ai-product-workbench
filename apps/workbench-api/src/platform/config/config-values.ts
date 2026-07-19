import type { ConfigService } from "@nestjs/config";

export function optionalString(config: ConfigService, name: string) {
  const value = config.get<string>(name)?.trim();
  return value || undefined;
}

export function booleanValue(
  config: ConfigService,
  name: string,
  fallback: boolean,
) {
  const value = optionalString(config, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function integerValue(
  config: ConfigService,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = optionalString(config, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function safeObjectKeyPrefix(value: string, variableName: string) {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${variableName} must be a non-empty object-key prefix`);
  }
  return normalized;
}
