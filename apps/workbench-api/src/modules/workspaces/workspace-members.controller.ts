import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { validationProblem } from "../../common/problem-details.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { WorkspaceMembersService } from "./workspace-members.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class WorkspaceMembersController {
  constructor(private readonly members: WorkspaceMembersService) {}

  @Get("workspaces/:workspaceId/members")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("workspaceId") workspaceId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    assertKnownQueryFields(query);
    return this.members.list(
      principal.id,
      workspaceId,
      singleQueryValue("q", query.q),
      parseCursor(query.cursor),
      parseLimit(query.limit),
    );
  }
}

function assertKnownQueryFields(query: Record<string, unknown>) {
  const unknown = Object.keys(query).filter((key) => !["q", "cursor", "limit"].includes(key));
  if (unknown.length > 0) {
    throw validationProblem(`Unknown Workspace member query field: ${unknown[0]}`);
  }
}

function parseCursor(value?: string | string[]) {
  value = singleQueryValue("cursor", value);
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 2_048) {
    throw validationProblem("cursor must contain between 1 and 2048 characters");
  }
  return value;
}

function parseLimit(value?: string | string[]) {
  value = singleQueryValue("limit", value);
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

function singleQueryValue(name: string, value?: string | string[]) {
  if (Array.isArray(value)) throw validationProblem(`${name} must be provided at most once`);
  return value;
}
