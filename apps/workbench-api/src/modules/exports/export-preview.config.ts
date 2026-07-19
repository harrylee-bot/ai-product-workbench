import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createPreviewToken,
  decodePreviewTokenSecret,
} from "@workbench/workbench-preview-token";
import { integerValue } from "../../platform/config/config-values.js";

@Injectable()
export class ExportPreviewConfig {
  private readonly publicOrigin: string;
  private readonly tokenSecret: Uint8Array;
  private readonly maximumTtlSeconds: number;

  constructor(config: ConfigService) {
    const production = config.get<string>("NODE_ENV")?.trim() === "production";
    this.publicOrigin = parseOrigin(
      "WORKBENCH_PREVIEW_ORIGIN",
      config.getOrThrow<string>("WORKBENCH_PREVIEW_ORIGIN"),
      production,
    );
    const webOrigins = config.getOrThrow<string>("WORKBENCH_WEB_ORIGIN")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => parseOrigin("WORKBENCH_WEB_ORIGIN", value, production));
    if (webOrigins.length === 0) throw new Error("WORKBENCH_WEB_ORIGIN must contain at least one origin");
    if (webOrigins.includes(this.publicOrigin)) {
      throw new Error("WORKBENCH_PREVIEW_ORIGIN must be independent from WORKBENCH_WEB_ORIGIN");
    }
    this.tokenSecret = decodePreviewTokenSecret(
      config.getOrThrow<string>("WORKBENCH_PREVIEW_TOKEN_SECRET").trim(),
    );
    this.maximumTtlSeconds = integerValue(
      config,
      "WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS",
      3_600,
      1,
      3_600,
    );
  }

  createCapability(
    exportJobId: string,
    now = new Date(),
    expiresNoLaterThan?: Date,
  ) {
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const configuredExpirySeconds = nowSeconds + this.maximumTtlSeconds;
    const boundedExpirySeconds = expiresNoLaterThan
      ? Math.min(configuredExpirySeconds, Math.floor(expiresNoLaterThan.getTime() / 1_000))
      : configuredExpirySeconds;
    if (boundedExpirySeconds <= nowSeconds) {
      throw new Error("PREVIEW_CAPABILITY_EXPIRY_INVALID");
    }
    const expiresAt = new Date(boundedExpirySeconds * 1_000);
    const token = createPreviewToken(
      { exportJobId, expiresAt },
      this.tokenSecret,
      { now, maximumTtlSeconds: this.maximumTtlSeconds },
    );
    return {
      url: `${this.publicOrigin}/preview/${token}`,
      expiresAt,
    };
  }
}

function parseOrigin(name: string, rawValue: string, requireHttps: boolean) {
  const value = rawValue.trim();
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (requireHttps && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be a bare ${requireHttps ? "HTTPS" : "HTTP(S)"} origin`);
  }
  return url.origin;
}
