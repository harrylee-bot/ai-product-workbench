import { Injectable } from "@nestjs/common";
import {
  workspaceMemberListSchema,
  type WorkspaceMemberList,
} from "@workbench/workbench-contracts";
import { z } from "zod";
import { validationProblem } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";

const workspaceMemberCursorSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1).max(128),
  q: z.string().min(1).max(160).nullable(),
  principalId: z.string().min(1).max(128),
}).strict();

type WorkspaceMemberCursor = z.infer<typeof workspaceMemberCursorSchema>;

@Injectable()
export class WorkspaceMembersService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    principalId: string,
    workspaceId: string,
    query?: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<WorkspaceMemberList> {
    await this.access.assertWorkspaceMember(principalId, workspaceId);

    const normalizedQuery = normalizeWorkspaceMemberQuery(query);
    const containsPattern = normalizedQuery === undefined
      ? undefined
      : escapeWorkspaceMemberContainsPattern(normalizedQuery);
    const decodedCursor = cursor ? decodeWorkspaceMemberCursor(cursor) : undefined;
    if (
      decodedCursor
      && (
        decodedCursor.workspaceId !== workspaceId
        || decodedCursor.q !== (normalizedQuery ?? null)
      )
    ) {
      throw validationProblem("The Workspace member cursor does not belong to these list filters");
    }

    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const members = await this.db.workspaceMember.findMany({
      where: {
        workspaceId,
        ...(decodedCursor ? { principalId: { gt: decodedCursor.principalId } } : {}),
        ...(containsPattern ? {
          principal: {
            is: {
              OR: [
                { displayName: { contains: containsPattern, mode: "insensitive" as const } },
                { email: { contains: containsPattern, mode: "insensitive" as const } },
              ],
            },
          },
        } : {}),
      },
      include: {
        principal: {
          select: { displayName: true, email: true },
        },
      },
      orderBy: { principalId: "asc" },
      take: limit + 1,
    });

    const hasNextPage = members.length > limit;
    const page = hasNextPage ? members.slice(0, limit) : members;
    const last = page.at(-1);
    return workspaceMemberListSchema.parse({
      items: page.map((member) => ({
        principalId: member.principalId,
        role: member.role,
        displayName: member.principal.displayName,
        email: member.principal.email,
      })),
      nextCursor: hasNextPage && last
        ? encodeWorkspaceMemberCursor({
            version: 1,
            workspaceId,
            q: normalizedQuery ?? null,
            principalId: last.principalId,
          })
        : null,
    });
  }
}

export function encodeWorkspaceMemberCursor(cursor: WorkspaceMemberCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeWorkspaceMemberCursor(value: string): WorkspaceMemberCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("invalid cursor encoding");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = workspaceMemberCursorSchema.parse(JSON.parse(decoded));
    if (parsed.q !== null && normalizeWorkspaceMemberQuery(parsed.q) !== parsed.q) {
      throw new Error("non-canonical cursor query");
    }
    return parsed;
  } catch {
    throw validationProblem("The Workspace member cursor is invalid");
  }
}

export function normalizeWorkspaceMemberQuery(value?: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw validationProblem("q must not be blank");
  if (normalized.length > 160) throw validationProblem("q must not exceed 160 characters");
  return normalized;
}

export function escapeWorkspaceMemberContainsPattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
