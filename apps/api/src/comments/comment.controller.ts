import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CommentService } from "./comment.service";

class CreateCommentDto {
  @IsNotEmpty()
  @IsString()
  projectId!: string;

  @IsNotEmpty()
  @IsString()
  targetType!: string;

  @IsNotEmpty()
  @IsString()
  targetId!: string;

  @IsOptional()
  @IsString()
  sectionId?: string;

  @IsNotEmpty()
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  parentCommentId?: string;
}

class UpdateCommentDto {
  @IsNotEmpty()
  @IsString()
  content!: string;
}

@Controller("comments")
@UseGuards(JwtAuthGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCommentDto
  ) {
    const comment = await this.commentService.createComment(user, dto);
    return { comment };
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("projectId") projectId: string,
    @Query("targetType") targetType?: string,
    @Query("targetId") targetId?: string
  ) {
    const comments = await this.commentService.listComments(
      user,
      projectId,
      targetType,
      targetId
    );
    return { comments };
  }

  @Patch(":id")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateCommentDto
  ) {
    const comment = await this.commentService.updateComment(
      user,
      id,
      dto.content
    );
    return { comment };
  }

  @Delete(":id")
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string
  ) {
    await this.commentService.deleteComment(user, id);
    return { success: true };
  }

  @Post(":id/resolve")
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string
  ) {
    const comment = await this.commentService.resolveComment(user, id);
    return { comment };
  }

  @Post(":id/unresolve")
  async unresolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string
  ) {
    const comment = await this.commentService.unresolveComment(user, id);
    return { comment };
  }
}
