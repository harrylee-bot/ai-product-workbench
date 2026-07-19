import type {
  ProjectInvitationStatus,
  ProjectRelationship,
} from "@workbench/workbench-contracts";

import type { CursorPageOptions } from "../../../transport/contracts";

export type ProjectListOptions = CursorPageOptions & {
  q?: string;
  relationship?: ProjectRelationship;
};

export type WorkspaceMemberListOptions = CursorPageOptions & {
  q?: string;
};

export type ProjectInvitationListOptions = CursorPageOptions & {
  status?: ProjectInvitationStatus;
};

export * from "./capabilities";
export * from "./home-project";
export * from "./project-invitation-link";
