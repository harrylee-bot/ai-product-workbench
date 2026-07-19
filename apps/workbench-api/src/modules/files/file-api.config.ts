import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  fileExtractionOutputSchemaVersion,
  fileExtractionParser,
  fileExtractionParserVersion,
} from "@workbench/workbench-contracts";
import {
  integerValue,
  optionalString,
  safeObjectKeyPrefix,
} from "../../platform/config/config-values.js";

const MEBIBYTE = 1024 * 1024;

@Injectable()
export class FileApiConfig {
  readonly sessionTtlSeconds: number;
  readonly signedUrlTtlSeconds: number;
  readonly preferredPartSize: number;
  readonly stagingPrefix: string;
  readonly parser: string;
  readonly parserVersion: string;
  readonly extractionSchemaVersion: number;

  constructor(config: ConfigService) {
    this.sessionTtlSeconds = integerValue(config, "WORKBENCH_FILE_UPLOAD_TTL_SECONDS", 86_400, 300, 7 * 86_400);
    this.signedUrlTtlSeconds = integerValue(config, "WORKBENCH_FILE_SIGNED_URL_TTL_SECONDS", 900, 60, 3_600);
    this.preferredPartSize = integerValue(
      config,
      "WORKBENCH_FILE_UPLOAD_PART_SIZE",
      8 * MEBIBYTE,
      5 * MEBIBYTE,
      2_147_483_647,
    );
    this.stagingPrefix = safeObjectKeyPrefix(
      optionalString(config, "WORKBENCH_S3_STAGING_PREFIX") ?? "staging/files",
      "WORKBENCH_S3_STAGING_PREFIX",
    );
    this.parser = exactString(config, "WORKBENCH_FILE_PARSER", fileExtractionParser);
    this.parserVersion = exactString(config, "WORKBENCH_FILE_PARSER_VERSION", fileExtractionParserVersion);
    this.extractionSchemaVersion = exactInteger(
      config,
      "WORKBENCH_FILE_EXTRACTION_SCHEMA_VERSION",
      fileExtractionOutputSchemaVersion,
    );
  }

}

function exactString(config: ConfigService, name: string, expected: string) {
  const value = optionalString(config, name);
  if (value !== undefined && value !== expected) {
    throw new Error(`${name} must equal the pinned extraction contract value`);
  }
  return expected;
}

function exactInteger(config: ConfigService, name: string, expected: number) {
  const value = optionalString(config, name);
  if (value === undefined) return expected;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== expected) {
    throw new Error(`${name} must equal the pinned extraction contract value (${expected})`);
  }
  return expected;
}
