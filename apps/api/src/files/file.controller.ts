import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { diskStorage } from "multer";
import type { Response } from "express";
import { createReadStream } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { FileAssetService } from "./file-asset.service";
import { ListConversationFilesQueryDto, UploadFilesDto } from "./dto";
import { PrototypeConversionService } from "./prototype-conversion.service";

const tempUploadDir = path.resolve(process.cwd(), "storage/tmp");
mkdirSync(tempUploadDir, { recursive: true });

@Controller()
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(
    private readonly fileAssetService: FileAssetService,
    private readonly prototypeConversionService: PrototypeConversionService,
  ) {}

  @Post("conversations/:conversationId/files")
  @Throttle({ heavy: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FilesInterceptor("files", 10, {
      storage: diskStorage({
        destination: (_request, _file, callback) => callback(null, tempUploadDir),
        filename: (_request, file, callback) => {
          const extension = path.extname(file.originalname).toLowerCase();
          callback(null, `${randomUUID()}${extension}`);
        },
      }),
      limits: {
        fileSize: 50 * 1024 * 1024,
        files: 10,
      },
    }),
  )
  uploadConversationFiles(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Body() dto: UploadFilesDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.fileAssetService.uploadConversationFiles(user, conversationId, dto, files);
  }

  @Get("conversations/:conversationId/files")
  listConversationFiles(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Query() query: ListConversationFilesQueryDto,
  ) {
    return this.fileAssetService.listConversationFiles(user, conversationId, query);
  }

  @Get("files/:fileId")
  getFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.getFile(user, fileId);
  }

  @Get("files/:fileId/parse-result")
  getParseResult(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.getParseResult(user, fileId);
  }

  @Get("files/:fileId/visual-contexts/:contextId")
	  async getVisualContextFile(
	    @CurrentUser() user: AuthenticatedUser,
	    @Param("fileId") fileId: string,
	    @Param("contextId") contextId: string,
	    @Res({ passthrough: true }) response: Response,
	  ) {
	    const file = await this.fileAssetService.getVisualContextFile(user, fileId, contextId);
	    const inlineSafe = isSafeInlineVisualContextMimeType(file.mimeType);
	    response.setHeader("Content-Type", inlineSafe ? file.mimeType : "application/octet-stream");
	    response.setHeader("X-Content-Type-Options", "nosniff");
	    if (!inlineSafe) {
	      response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
	    }
	    response.setHeader(
	      "Content-Disposition",
	      `${inlineSafe ? "inline" : "attachment"}; filename="${encodeURIComponent(file.fileName)}"`,
	    );
	    return new StreamableFile(createReadStream(file.filePath));
	  }

	  @Post("files/:fileId/reparse")
	  reparseFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
	    return this.fileAssetService.reparseFile(user, fileId);
	  }

  @Get("files/:fileId/prototype-conversion")
  getPrototypeConversion(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.prototypeConversionService.getJobForFile(user, fileId);
  }

  @Post("files/:fileId/prototype-conversion/run")
  @Throttle({ heavy: { limit: 5, ttl: 60_000 } })
  runPrototypeConversion(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.prototypeConversionService.runConversionForFile(user, fileId);
  }

  @Delete("files/:fileId")
	  deleteFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
	    return this.fileAssetService.deleteFile(user, fileId);
	  }
	}

	function isSafeInlineVisualContextMimeType(mimeType: string) {
	  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
	  if (!normalized) return false;
	  if (normalized === "image/svg+xml") return false;
	  if (normalized.startsWith("image/")) return true;
	  return normalized === "application/pdf" || normalized === "text/plain";
	}
