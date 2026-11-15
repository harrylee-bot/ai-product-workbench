import { z } from "zod";
import {
  isoDateTimeSchema,
  opaqueIdSchema,
  prototypeFeedbackQuerySchema,
  type PrototypeFeedbackQuery,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { validationProblem } from "../../common/problem-details.js";

const cursorSchema = z
  .object({
    scope: z.string(),
    createdAt: isoDateTimeSchema,
    id: opaqueIdSchema,
  })
  .strict();

/** Newest first keyset paging. Cursor scope binds filters and both revisions. */
export function feedbackPageQuery(
  projectId: string,
  sourceRevisionId: string,
  targetRevisionId: string,
  input: PrototypeFeedbackQuery = {},
) {
  const query = prototypeFeedbackQuerySchema.parse(input);
  const scope = JSON.stringify([
    projectId,
    sourceRevisionId,
    targetRevisionId,
    query.status ?? null,
    query.pageId ?? null,
  ]);
  let after: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.cursor))
        throw new Error("cursor encoding");
      after = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (after.scope !== scope) throw new Error("cursor scope");
    } catch {
      throw validationProblem(
        "Feedback cursor is invalid for this source, target, or filter",
      );
    }
  }
  const where: Prisma.PrototypeFeedbackWhereInput = {
    projectId,
    revisionId: sourceRevisionId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.pageId
      ? { anchor: { path: ["pageId"], equals: query.pageId } }
      : {}),
    ...(after
      ? {
          OR: [
            { createdAt: { lt: new Date(after.createdAt) } },
            { createdAt: new Date(after.createdAt), id: { lt: after.id } },
          ],
        }
      : {}),
  };
  return {
    args: {
      where,
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
      take: query.limit + 1,
    },
    page<T extends { id: string; createdAt: Date }>(rows: T[]) {
      const items = rows.slice(0, query.limit),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(
                JSON.stringify({
                  scope,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    },
  };
}
