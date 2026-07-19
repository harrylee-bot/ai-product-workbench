import { describe, expect, it } from "vitest";

import { workbenchQueryKeys } from "./keys";

describe("Workbench query keys", () => {
  it("keeps project-owned resources under the project prefix", () => {
    expect(workbenchQueryKeys.runtimeModels()).toEqual(["workbench", "runtime", "models"]);
    expect(workbenchQueryKeys.communicationPreferences().slice(0, -1))
      .toEqual(workbenchQueryKeys.identity());
    expect(workbenchQueryKeys.exportCapabilities()).toEqual(["workbench", "exports", "capabilities"]);
    expect(workbenchQueryKeys.designSystemInfiniteCatalog("workspace-1", { q: "design" }).slice(0, -2))
      .toEqual(workbenchQueryKeys.designSystemCatalogs("workspace-1"));
    expect(workbenchQueryKeys.designSystemCatalog("workspace-1", { q: "design" }))
      .not.toEqual(workbenchQueryKeys.designSystemCatalog("workspace-2", { q: "design" }));
    expect(workbenchQueryKeys.workspaceMemberInfiniteList("workspace-1", { q: "owner" }).slice(0, -2))
      .toEqual(workbenchQueryKeys.workspaceMemberLists("workspace-1"));
    expect(workbenchQueryKeys.workspaceMemberInfiniteList("workspace-1", { q: "owner" }))
      .not.toEqual(workbenchQueryKeys.workspaceMemberInfiniteList("workspace-2", { q: "owner" }));
    expect(workbenchQueryKeys.projectInfiniteList({
      q: "design",
      relationship: "shared",
    }).slice(0, -2)).toEqual(workbenchQueryKeys.projectLists());
    expect(workbenchQueryKeys.projectMember("project-1", "principal-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.projectMembers("project-1"));
    expect(workbenchQueryKeys.projectInvitationInfiniteList("project-1", { status: "pending" }).slice(0, -2))
      .toEqual(workbenchQueryKeys.projectInvitations("project-1"));
    expect(workbenchQueryKeys.projectInvitationInfiniteList("project-1", { status: "pending" }))
      .not.toEqual(workbenchQueryKeys.projectInvitationInfiniteList("project-2", { status: "pending" }));
    expect(workbenchQueryKeys.bootstrap("project-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.project("project-1"));
    expect(workbenchQueryKeys.bootstrap("project-1", "thread-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.bootstraps("project-1"));
    expect(workbenchQueryKeys.bootstrap("project-1", "thread-1"))
      .not.toEqual(workbenchQueryKeys.bootstrap("project-1", "thread-2"));
    expect(workbenchQueryKeys.board("project-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.project("project-1"));
    expect(workbenchQueryKeys.releaseList("project-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.releaseLists("project-1"));
    expect(workbenchQueryKeys.release("project-1", "release-1").slice(0, -2))
      .toEqual(workbenchQueryKeys.releases("project-1"));
    expect(workbenchQueryKeys.shareList("project-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.shareLists("project-1"));
    expect(workbenchQueryKeys.share("project-1", "share-1").slice(0, -2))
      .toEqual(workbenchQueryKeys.shares("project-1"));
    expect(workbenchQueryKeys.exportJobList("project-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.exportJobLists("project-1"));
    expect(workbenchQueryKeys.exportContent("project-1", "export-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.exportJob("project-1", "export-1"));
    expect(workbenchQueryKeys.artifactList("project-1", { kind: "prd" }).slice(0, -1))
      .toEqual(workbenchQueryKeys.artifactLists("project-1"));
    expect(workbenchQueryKeys.artifactVersionFavoriteInfiniteList(
      "project-1",
      { limit: 20 },
    ).slice(0, -2)).toEqual(workbenchQueryKeys.artifactVersionFavoriteLists("project-1"));
    expect(workbenchQueryKeys.artifactVersionFavoriteInfiniteList("project-1", { limit: 20 }))
      .not.toEqual(workbenchQueryKeys.artifactVersionFavoriteInfiniteList(
        "project-2",
        { limit: 20 },
      ));
    expect(workbenchQueryKeys.artifact("project-1", "artifact-1").slice(0, -2))
      .toEqual(workbenchQueryKeys.artifacts("project-1"));
    expect(workbenchQueryKeys.artifactVersion("project-1", "artifact-1", "version-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.artifactVersionLists("project-1", "artifact-1"));
    expect(workbenchQueryKeys.artifactVersion("project-1", "artifact-1", "version-1"))
      .not.toEqual(workbenchQueryKeys.artifactVersion("project-1", "artifact-1", "version-2"));
    expect(workbenchQueryKeys.artifactVersionPreference(
      "principal-1",
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    ).slice(0, -2)).toEqual(workbenchQueryKeys.artifactVersion(
      "project-1",
      "artifact-1",
      "version-1",
    ));
    expect(workbenchQueryKeys.artifactVersionPreference(
      "principal-1", "project-1", "artifact-1", "version-1", "screen-home",
    )).not.toEqual(workbenchQueryKeys.artifactVersionPreference(
      "principal-1", "project-1", "artifact-1", "version-1", "screen-success",
    ));
    expect(workbenchQueryKeys.artifactVersionPreference(
      "principal-1", "project-1", "artifact-1", "version-1", "screen-home",
    )).not.toEqual(workbenchQueryKeys.artifactVersionPreference(
      "principal-2", "project-1", "artifact-1", "version-1", "screen-home",
    ));
    expect(workbenchQueryKeys.artifactVersionAsset(
      "project-1",
      "artifact-1",
      "version-1",
      "asset-1",
    ).slice(0, -1)).toEqual(workbenchQueryKeys.artifactVersionAssets(
      "project-1",
      "artifact-1",
      "version-1",
    ));
    expect(workbenchQueryKeys.artifactVersionAsset(
      "project-1",
      "artifact-1",
      "version-1",
      "asset-1",
    )).not.toEqual(workbenchQueryKeys.artifactVersionAsset(
      "project-1",
      "artifact-1",
      "version-1",
      "asset-2",
    ));
    expect(workbenchQueryKeys.fileList("project-1", { status: "ready" }).slice(0, -1))
      .toEqual(workbenchQueryKeys.fileLists("project-1"));
    expect(workbenchQueryKeys.file("project-1", "file-1").slice(0, -2))
      .toEqual(workbenchQueryKeys.files("project-1"));
    expect(workbenchQueryKeys.fileUpload("project-1", "upload-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.fileUploads("project-1"));
    expect(workbenchQueryKeys.file("project-1", "file-1"))
      .not.toEqual(workbenchQueryKeys.file("project-2", "file-1"));
    expect(workbenchQueryKeys.entries("project-1", "thread-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.entryLists("project-1", "thread-1"));
    expect(workbenchQueryKeys.entryLists("project-1", "thread-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.thread("project-1", "thread-1"));
    expect(workbenchQueryKeys.runList("project-1", "thread-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.runLists("project-1", "thread-1"));
    expect(workbenchQueryKeys.runList("project-1", "thread-1"))
      .not.toEqual(workbenchQueryKeys.runList("project-1", "thread-2"));
    expect(workbenchQueryKeys.approval("run-1", "approval-1").slice(0, -1))
      .toEqual(workbenchQueryKeys.approvals("run-1"));
  });
});
