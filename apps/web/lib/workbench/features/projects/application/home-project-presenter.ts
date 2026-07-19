import type { ProjectListItem } from "@workbench/workbench-contracts";

import type {
  WorkbenchHomeProjectGroup,
  WorkbenchHomeProjectItem,
  WorkbenchHomeProjectVariant,
} from "../domain";

export type WorkbenchProjectPresentationOptions = {
  locale?: string;
  now?: Date;
  timeZone?: string;
};

const projectAccents = ["#7467f6", "#5f8f86", "#c25b68", "#597fb8", "#ad7f45", "#7d6aa8"] as const;
const projectVariants: readonly WorkbenchHomeProjectVariant[] = [
  "dark",
  "light",
  "mobile",
  "editor",
  "book",
  "landscape",
];

export function toWorkbenchHomeProjectItem(
  project: ProjectListItem,
  options: WorkbenchProjectPresentationOptions = {},
): WorkbenchHomeProjectItem {
  const locale = options.locale ?? "en-US";
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const updatedAt = new Date(project.updatedAt);
  const stableHash = hashString(project.id);

  return {
    id: project.id,
    accent: projectAccents[stableHash % projectAccents.length],
    date: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone,
    }).format(updatedAt),
    group: projectGroup(updatedAt, now, timeZone),
    revision: project.revision,
    role: project.role,
    shared: project.relationship === "shared",
    title: project.title,
    variant: projectVariants[hashString(`variant:${project.id}`) % projectVariants.length],
  };
}

export function toWorkbenchHomeProjectItems(
  projects: readonly ProjectListItem[],
  options: WorkbenchProjectPresentationOptions = {},
): WorkbenchHomeProjectItem[] {
  return projects.map((project) => toWorkbenchHomeProjectItem(project, options));
}

function projectGroup(updatedAt: Date, now: Date, timeZone: string): WorkbenchHomeProjectGroup {
  const ageInDays = zonedDayOrdinal(now, timeZone) - zonedDayOrdinal(updatedAt, timeZone);
  if (ageInDays <= 0) return "最近";
  if (ageInDays === 1) return "昨天";
  if (ageInDays <= 7) return "过去 7 天";
  return "更早";
}

function zonedDayOrdinal(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (![year, month, day].every(Number.isInteger)) {
    throw new RangeError(`Unable to derive a calendar date in ${timeZone}`);
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}
