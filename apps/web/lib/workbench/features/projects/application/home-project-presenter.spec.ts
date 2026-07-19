import type { ProjectListItem } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { toWorkbenchHomeProjectItem } from "./home-project-presenter";

const project: ProjectListItem = {
  id: "project-stable-1",
  workspaceId: "workspace-1",
  title: "打卡签到系统",
  summary: null,
  status: "active",
  revision: 0,
  createdAt: "2026-07-08T04:00:00.000Z",
  updatedAt: "2026-07-12T04:00:00.000Z",
  role: "owner",
  relationship: "owned",
};

describe("Workbench project presenter", () => {
  it("keeps identity and thumbnail choices stable while presenting mutable fields", () => {
    const options = {
      locale: "en-US",
      now: new Date("2026-07-12T12:00:00.000Z"),
      timeZone: "UTC",
    };
    const first = toWorkbenchHomeProjectItem(project, options);
    const renamed = toWorkbenchHomeProjectItem({ ...project, title: "Renamed" }, options);

    expect(first).toMatchObject({
      id: project.id,
      title: project.title,
      date: "Jul 12, 2026",
      group: "最近",
      shared: false,
    });
    expect(renamed.title).toBe("Renamed");
    expect(renamed.accent).toBe(first.accent);
    expect(renamed.variant).toBe(first.variant);
  });

  it("uses calendar-day groups without classifying old real projects as samples", () => {
    const options = {
      now: new Date("2026-07-12T12:00:00.000Z"),
      timeZone: "UTC",
    };
    const yesterday = toWorkbenchHomeProjectItem({
      ...project,
      updatedAt: "2026-07-11T01:00:00.000Z",
    }, options);
    const earlier = toWorkbenchHomeProjectItem({
      ...project,
      updatedAt: "2026-05-01T01:00:00.000Z",
    }, options);
    const lastWeek = toWorkbenchHomeProjectItem({
      ...project,
      updatedAt: "2026-07-06T01:00:00.000Z",
    }, options);

    expect(yesterday.group).toBe("昨天");
    expect(lastWeek.group).toBe("过去 7 天");
    expect(earlier.group).toBe("更早");
  });

  it("uses the server relationship projection for shared projects", () => {
    expect(toWorkbenchHomeProjectItem({
      ...project,
      role: "viewer",
      relationship: "shared",
    }).shared).toBe(true);
  });
});
