import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { FileAssetService } from "./file-asset.service";
import { ListProjectFilesQueryDto, UploadFilesDto } from "./dto";

const tempUploadDir = path.resolve(process.cwd(), "storage/tmp");
mkdirSync(tempUploadDir, { recursive: true });

@Controller()
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileAssetService: FileAssetService) {}

  @Post("projects/:projectId/files")
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
  uploadProjectFiles(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: UploadFilesDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.fileAssetService.uploadProjectFiles(user, projectId, dto, files);
  }

  @Get("projects/:projectId/files")
  listProjectFiles(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Query() query: ListProjectFilesQueryDto,
  ) {
    return this.fileAssetService.listProjectFiles(user, projectId, query);
  }

  @Get("files/:fileId")
  getFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.getFile(user, fileId);
  }

  @Get("files/:fileId/parse-result")
  getParseResult(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.getParseResult(user, fileId);
  }

  @Post("files/:fileId/reparse")
  reparseFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.reparseFile(user, fileId);
  }

  @Delete("files/:fileId")
  deleteFile(@CurrentUser() user: AuthenticatedUser, @Param("fileId") fileId: string) {
    return this.fileAssetService.deleteFile(user, fileId);
  }
}
