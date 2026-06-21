import { BadRequestException, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  assertOwnerMutation,
  assertProjectAccess,
  json,
} from "./product-evolution.helpers";
import type {
  InteractionEventType,
  InteractionTargetType,
  ProductInteractionEventItem,
} from "./product-evolution.types";

type ContractEventType =
  | "agent_started"
  | "agent_completed"
  | "state_updated"
  | "state_version_created"
  | "prd_generated"
  | "prototype_generated"
  | "patch_applied"
  | "qa_completed";

type ProductInteractionEventRow = {
  id: string;
  projectId: string;
  type: string;
  targetType: string;
  targetId: string | null;
  content: string | null;
  metadata: unknown;
  createdBy: string;
  createdAt: Date;
};

@Injectable()
export class InteractionCaptureService {
  constructor(private readonly prisma: PrismaService) {}

  async createForUser(
    user: AuthenticatedUser,
    input: {
      projectId: string;
      type: InteractionEventType;
      targetType: InteractionTargetType;
      targetId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接记录用户项目反馈");
    this.assertExplicitFeedback(input.content, input.metadata);

    const event = await this.prisma.productInteractionEvent.create({
      data: {
        projectId: input.projectId,
        type: input.type,
        targetType: input.targetType,
        targetId: input.targetId?.trim() || undefined,
        content: input.content?.trim() || undefined,
        metadata: json(input.metadata),
        createdBy: user.id,
      },
    });

    return { event: this.toItem(event as ProductInteractionEventRow) };
  }

  async listForProject(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const items = await this.prisma.productInteractionEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: items.map((item) => this.toItem(item as ProductInteractionEventRow)),
      total: items.length,
    };
  }

  async createContractEventForUser(
    user: AuthenticatedUser,
    input: {
      eventType: ContractEventType;
      projectId: string;
      targetId?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const timestamp = new Date().toISOString();
    return this.createForUser(user, {
      projectId: input.projectId,
      type: toInteractionType(input.eventType),
      targetType: toTargetType(input.eventType),
      targetId: input.targetId,
      content: contractEventContent(input.eventType),
      metadata: {
        eventSchema: "v1",
        eventType: input.eventType,
        timestamp,
        projectId: input.projectId,
        payload: input.payload ?? {},
      },
    });
  }

  toItem(row: ProductInteractionEventRow): ProductInteractionEventItem {
    return {
      id: row.id,
      projectId: row.projectId,
      type: row.type as InteractionEventType,
      targetType: row.targetType as InteractionTargetType,
      targetId: row.targetId ?? undefined,
      content: row.content ?? undefined,
      metadata: row.metadata ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private assertExplicitFeedback(content?: string, metadata?: Record<string, unknown>) {
    const hasContent = Boolean(content?.trim());
    const hasMetadata = metadata && Object.keys(metadata).length > 0;
    if (!hasContent && !hasMetadata) {
      throw new BadRequestException("INTERACTION_EVENT_EMPTY");
    }

    const serialized = JSON.stringify(metadata ?? {}).toLowerCase();
    const forbidden = ["clickstream", "funnel", "ctr", "pageview", "analytics", "heatmap"];
    if (forbidden.some((keyword) => serialized.includes(keyword))) {
      throw new BadRequestException("INTERACTION_ANALYTICS_FORBIDDEN");
    }
  }
}

function toInteractionType(eventType: ContractEventType): InteractionEventType {
  if (eventType === "patch_applied") return "patch";
  if (eventType === "prd_generated" || eventType === "prototype_generated") return "selection";
  return "comment";
}

function toTargetType(eventType: ContractEventType): InteractionTargetType {
  if (eventType === "prototype_generated") return "prototype";
  if (eventType === "state_updated" || eventType === "state_version_created") return "state";
  return "prd";
}

function contractEventContent(eventType: ContractEventType) {
  return `event-schema:${eventType}`;
}
