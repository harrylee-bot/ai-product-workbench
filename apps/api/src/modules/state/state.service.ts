import { Injectable } from "@nestjs/common";
import { Prisma, ProductDesignStateStatus, PrototypeArtifactStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1Prd, Phase1ProductStateInput, Phase1Prototype } from "./state.types";

@Injectable()
export class StateService {
  constructor(private readonly prisma: PrismaService) {}

  async saveFromMessage(input: {
    projectId: string;
    userId: string;
    productState: Phase1ProductStateInput;
    prd: Phase1Prd;
    prototype: Phase1Prototype;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.productDesignState.findFirst({
        where: { projectId: input.projectId },
        orderBy: { version: "desc" },
      });
      const version = (latest?.version ?? 0) + 1;
      const prdSnapshot = input.prd as unknown as Prisma.InputJsonValue;
      const prototypeSpecSnapshot = {
        title: input.productState.title,
        pages: input.productState.pages,
        html: input.prototype.html,
      } as Prisma.InputJsonValue;

      const state = await tx.productDesignState.create({
        data: {
          projectId: input.projectId,
          version,
          title: input.productState.title,
          summary: input.productState.businessGoal,
          businessGoal: input.productState.businessGoal,
          targetUsers: [],
          userScenarios: [],
          pages: input.productState.pages as Prisma.InputJsonValue,
          features: [],
          backendConfigs: [],
          frontendRules: [],
          businessRules: input.productState.rules as Prisma.InputJsonValue,
          stateRules: [],
          exceptionScenarios: [],
          acceptanceCriteria: [],
          assumptions: [],
          knowledgeRefs: [],
          pendingQuestions: [],
          confirmedFacts: [],
          prdDocument: prdSnapshot,
          prototypeSpec: prototypeSpecSnapshot,
          status: ProductDesignStateStatus.prototype_ready,
          createdBy: input.userId,
          updatedBy: input.userId,
        },
      });

      const prdDocument = await tx.requirementDocument.create({
        data: {
          projectId: input.projectId,
          productDesignStateId: state.id,
          productDesignStateVersion: state.version,
          title: `${state.title} 需求文档`,
          sections: input.prd.sections as unknown as Prisma.InputJsonValue,
          assumptions: [],
          knowledgeRefs: [],
          pendingQuestions: [],
          validationNotes: [],
          createdBy: input.userId,
          updatedBy: input.userId,
        },
      });

      const prototypeSpec = await tx.prototypeSpecRecord.create({
        data: {
          projectId: input.projectId,
          productDesignStateId: state.id,
          productDesignStateVersion: state.version,
          title: `${state.title} 原型规格`,
          styleGuide: {
            tone: "phase1-mock",
            layoutDensity: "simple",
          },
          pages: input.productState.pages as Prisma.InputJsonValue,
          navigation: [],
          interactions: [],
          assumptions: [],
          knowledgeRefs: [],
        },
      });

      const artifact = await tx.prototypeArtifact.create({
        data: {
          projectId: input.projectId,
          prototypeSpecId: prototypeSpec.id,
          productDesignStateId: state.id,
          productDesignStateVersion: state.version,
          title: `${state.title} 原型`,
          status: PrototypeArtifactStatus.ready,
          htmlContent: input.prototype.html,
          entryFilePath: "index.html",
          pageCount: 1,
          createdBy: input.userId,
          updatedBy: input.userId,
        },
      });

      const updatedState = await tx.productDesignState.update({
        where: { id: state.id },
        data: {
          prdDocument: {
            id: prdDocument.id,
            sections: input.prd.sections,
          } as Prisma.InputJsonValue,
          prototypeSpec: {
            id: prototypeSpec.id,
            artifactId: artifact.id,
            html: input.prototype.html,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.project.update({
        where: { id: input.projectId },
        data: {
          currentProductDesignStateId: state.id,
          currentPrdDocumentId: prdDocument.id,
          currentPrototypeArtifactId: artifact.id,
          status: "prototype_ready",
          lastActivityAt: new Date(),
        },
      });

      return {
        productDesignState: updatedState,
        prd: prdDocument,
        prototype: artifact,
      };
    });
  }
}
