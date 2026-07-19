import type { ProjectRole } from "@workbench/workbench-contracts";

export type WorkbenchHomeProjectGroup = "最近" | "昨天" | "过去 7 天" | "更早" | "示例";
export type WorkbenchHomeProjectVariant = "dark" | "light" | "mobile" | "editor" | "book" | "landscape";

export type WorkbenchHomeProjectItem = {
  id: string;
  accent: string;
  date: string;
  group: WorkbenchHomeProjectGroup;
  revision: number;
  role: ProjectRole;
  shared: boolean;
  title: string;
  variant: WorkbenchHomeProjectVariant;
};
