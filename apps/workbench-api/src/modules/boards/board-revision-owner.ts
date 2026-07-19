import { Prisma } from "@workbench/workbench-db";

type BoardRevisionOwnerClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type BoardRevisionOwnerState = {
  boardId: string | null;
  revision: string | null;
};

const maximumBoardRevision = 2_147_483_647;

export async function withBoardRevisionOwner<T>(
  tx: BoardRevisionOwnerClient,
  boardId: string,
  resultRevision: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    boardId.length === 0
    || !Number.isInteger(resultRevision)
    || resultRevision < 0
    || resultRevision > maximumBoardRevision
  ) {
    throw new Error("BOARD_REVISION_OWNER_INVALID");
  }

  const [current] = await tx.$queryRaw<BoardRevisionOwnerState[]>(Prisma.sql`
    SELECT
      NULLIF(current_setting('workbench.board_revision_owner', TRUE), '') AS "boardId",
      NULLIF(current_setting('workbench.board_revision_owner_revision', TRUE), '') AS "revision"
  `);
  if (!current || current.boardId !== null || current.revision !== null) {
    throw new Error("BOARD_REVISION_OWNER_ALREADY_CLAIMED");
  }

  const revision = String(resultRevision);
  const [claimed] = await tx.$queryRaw<BoardRevisionOwnerState[]>(Prisma.sql`
    SELECT
      set_config('workbench.board_revision_owner', ${boardId}, TRUE) AS "boardId",
      set_config('workbench.board_revision_owner_revision', ${revision}, TRUE) AS "revision"
  `);
  if (claimed?.boardId !== boardId || claimed.revision !== revision) {
    throw new Error("BOARD_REVISION_OWNER_CLAIM_FAILED");
  }

  const result = await operation();
  const [released] = await tx.$queryRaw<BoardRevisionOwnerState[]>(Prisma.sql`
    SELECT
      set_config('workbench.board_revision_owner', '', TRUE) AS "boardId",
      set_config('workbench.board_revision_owner_revision', '', TRUE) AS "revision"
  `);
  if (released?.boardId !== "" || released.revision !== "") {
    throw new Error("BOARD_REVISION_OWNER_RELEASE_FAILED");
  }
  return result;
}
