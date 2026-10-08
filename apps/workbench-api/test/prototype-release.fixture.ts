import { randomUUID } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import type { Prisma } from "@workbench/workbench-db";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { AccessService } from "../src/modules/access/access.service.js";
import { canonicalSha256 } from "../src/modules/releases/release.mapper.js";
import { ReleasesService } from "../src/modules/releases/releases.service.js";

export async function seedPrototypeRelease(tx: Prisma.TransactionClient, projectId: string, principalId: string, boardId: string) {
  const artifact = await tx.artifact.create({ data: { projectId, kind: "prototype", title: "Shared Prototype" } });
  const content = JSON.parse(canonicalJson(prototypeDocumentFixture())) as Prisma.InputJsonValue;
  const version = await tx.artifactVersion.create({ data: {
    artifactId: artifact.id, projectId, version: 1, schemaVersion: 1, status: "ready",
    content, checksum: canonicalSha256(content), citations: [],
  } });
  await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
  const board = await tx.board.findUniqueOrThrow({ where: { id: boardId } });
  const service = new ReleasesService({
    projectRelease: tx.projectRelease,
    $transaction: <T>(callback: (client: Prisma.TransactionClient) => Promise<T>) => callback(tx),
  } as never, new AccessService(tx as never));
  const release = await service.create(principalId, projectId, board.revision, randomUUID(), { boardId, boardRevision: board.revision });
  return { ...release, artifactVersionId: version.id };
}
