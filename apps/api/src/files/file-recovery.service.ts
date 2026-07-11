import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileAssetService } from "./file-asset.service";
import { PrototypeConversionService } from "./prototype-conversion.service";

@Injectable()
export class FileRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FileRecoveryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly files: FileAssetService,
    private readonly conversions: PrototypeConversionService,
  ) {}

  async onApplicationBootstrap() {
    if (!readBoolean(this.config.get<string>("FILE_RECOVERY_ENABLED"), true)) {
      this.logger.warn("File recovery is disabled by FILE_RECOVERY_ENABLED=false.");
      return;
    }

    const parsing = await this.files.failInterruptedParsingFiles();
    const conversions = await this.conversions.recoverInterruptedJobs(
      readPositiveInteger(this.config.get<string>("FILE_RECOVERY_MAX_QUEUED_CONVERSIONS"), 20),
    );
    this.logger.log(JSON.stringify({ interruptedParsingCount: parsing.count, ...conversions }));
  }
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "true";
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
