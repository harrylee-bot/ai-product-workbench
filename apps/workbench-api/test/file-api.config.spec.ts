import { ConfigService } from "@nestjs/config";
import {
  fileExtractionOutputSchemaVersion,
  fileExtractionParser,
  fileExtractionParserVersion,
} from "@workbench/workbench-contracts";
import { FileApiConfig } from "../src/modules/files/file-api.config.js";

describe("FileApiConfig extraction contract", () => {
  it("uses the shared pinned parser contract by default", () => {
    const config = new FileApiConfig(new ConfigService({}));

    expect(config.parser).toBe(fileExtractionParser);
    expect(config.parserVersion).toBe(fileExtractionParserVersion);
    expect(config.extractionSchemaVersion).toBe(fileExtractionOutputSchemaVersion);
  });

  it.each([
    ["WORKBENCH_FILE_PARSER", "another-parser"],
    ["WORKBENCH_FILE_PARSER_VERSION", "another-version"],
    ["WORKBENCH_FILE_EXTRACTION_SCHEMA_VERSION", "2"],
  ])("rejects a deployment override that would create unprocessable tasks", (name, value) => {
    expect(() => new FileApiConfig(new ConfigService({ [name]: value })))
      .toThrow(/pinned extraction contract value/);
  });
});
