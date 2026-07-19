import { describe, expect, it } from "vitest";

import { workbenchProjectCapabilities } from "./capabilities";

describe("Workbench Project capabilities", () => {
  it("keeps the role capability matrix explicit", () => {
    expect(workbenchProjectCapabilities("viewer")).toEqual({
      canArchive: false,
      canDuplicate: true,
      canEdit: false,
      canExport: false,
      canPreview: true,
      canManageMembers: false,
      canRun: false,
      canShare: false,
      canUpload: false,
    });
    expect(workbenchProjectCapabilities("editor")).toMatchObject({
      canArchive: false,
      canDuplicate: true,
      canEdit: true,
      canExport: true,
      canPreview: true,
      canManageMembers: false,
      canRun: true,
      canShare: false,
      canUpload: true,
    });
    expect(workbenchProjectCapabilities("owner")).toEqual({
      canArchive: true,
      canDuplicate: true,
      canEdit: true,
      canExport: true,
      canPreview: true,
      canManageMembers: true,
      canRun: true,
      canShare: true,
      canUpload: true,
    });
    expect(workbenchProjectCapabilities(undefined).canDuplicate).toBe(false);
  });
});
