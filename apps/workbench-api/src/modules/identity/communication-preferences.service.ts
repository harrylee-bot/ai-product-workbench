import { Injectable } from "@nestjs/common";
import {
  Prisma,
  type PrincipalCommunicationPreference,
} from "@workbench/workbench-db";
import type {
  CommunicationPreferences,
  UpdateCommunicationPreferencesRequest,
} from "@workbench/workbench-contracts";
import { revisionConflictProblem } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";

const unpersistedPreferences: CommunicationPreferences = {
  productUpdatesEmail: false,
  researchInvitations: false,
  revision: 0,
  createdAt: null,
  updatedAt: null,
};

@Injectable()
export class CommunicationPreferencesService {
  constructor(private readonly db: WorkbenchDbService) {}

  async get(principalId: string): Promise<CommunicationPreferences> {
    const preferences = await this.db.principalCommunicationPreference.findUnique({
      where: { principalId },
    });
    return preferences ? mapCommunicationPreferences(preferences) : { ...unpersistedPreferences };
  }

  async update(
    principalId: string,
    expectedRevision: number,
    request: UpdateCommunicationPreferencesRequest,
  ): Promise<CommunicationPreferences> {
    try {
      return await this.db.$transaction(async (tx) => {
        const updated = await tx.principalCommunicationPreference.updateMany({
          where: { principalId, revision: expectedRevision },
          data: {
            productUpdatesEmail: request.productUpdatesEmail,
            researchInvitations: request.researchInvitations,
            revision: { increment: 1 },
          },
        });
        if (updated.count === 1) {
          const preferences = await tx.principalCommunicationPreference.findUniqueOrThrow({
            where: { principalId },
          });
          return mapCommunicationPreferences(preferences);
        }

        if (expectedRevision !== 0) throw revisionConflictProblem();

        const preferences = await tx.principalCommunicationPreference.create({
          data: {
            principalId,
            productUpdatesEmail: request.productUpdatesEmail,
            researchInvitations: request.researchInvitations,
            revision: 1,
          },
        });
        return mapCommunicationPreferences(preferences);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw revisionConflictProblem();
      }
      throw error;
    }
  }
}

function mapCommunicationPreferences(
  preferences: PrincipalCommunicationPreference,
): CommunicationPreferences {
  return {
    productUpdatesEmail: preferences.productUpdatesEmail,
    researchInvitations: preferences.researchInvitations,
    revision: preferences.revision,
    createdAt: preferences.createdAt.toISOString(),
    updatedAt: preferences.updatedAt.toISOString(),
  };
}
