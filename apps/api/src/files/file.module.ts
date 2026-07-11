import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { FileAssetService } from "./file-asset.service";
import { FileController } from "./file.controller";
import { FileParserService } from "./file-parser.service";
import { PrototypeConversionService } from "./prototype-conversion.service";
import { TempFileCleanupInterceptor } from "./temp-file-cleanup.interceptor";
import { FileRecoveryService } from "./file-recovery.service";

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FileController],
  providers: [
    FileAssetService,
    FileParserService,
    PrototypeConversionService,
    TempFileCleanupInterceptor,
    FileRecoveryService,
  ],
  exports: [FileAssetService, PrototypeConversionService],
})
export class FileModule {}
