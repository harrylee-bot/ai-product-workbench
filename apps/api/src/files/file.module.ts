import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { FileAssetService } from "./file-asset.service";
import { FileController } from "./file.controller";
import { FileParserService } from "./file-parser.service";

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FileController],
  providers: [FileAssetService, FileParserService],
  exports: [FileAssetService],
})
export class FileModule {}
