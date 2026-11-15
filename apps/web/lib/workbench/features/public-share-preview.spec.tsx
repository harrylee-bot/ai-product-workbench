// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type {
  PublicProjectRelease,
  PublicShare,
} from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicRelease as ShareView } from "@/components/studio/public-release";
import { publicSharePreviewEntries } from "./public-share-preview";

const queries=vi.hoisted(()=>({version:vi.fn(),content:vi.fn()}));
vi.mock("@/lib/workbench/features/public-shares",()=>({
 useWorkbenchPublicSharedArtifactVersion:(...args:unknown[])=>{queries.version(...args);return {data:{value:{kind:'data',contentMode:'inline',content:{text:'Public artifact'}}}};},
 useWorkbenchPublicSharedArtifactContent:(...args:unknown[])=>{queries.content(...args);return {};},
}));
vi.mock("@/lib/studio/api",()=>({useWorkbenchPublicSharesApi:()=>({})}));

afterEach(cleanup);

describe("Public Share screen selection", () => {
  it("restores every explicit Prototype screen from the immutable Board snapshot", () => {
    expect(publicSharePreviewEntries(release())).toEqual([
      {
        key: "board:node-home",
        artifactId: "artifact-prototype",
        artifactVersionId: "version-prototype",
        kind: "prototype",
        screenId: "screen-home",
        title: "Home screen",
      },
      {
        key: "board:node-success",
        artifactId: "artifact-prototype",
        artifactVersionId: "version-prototype",
        kind: "prototype",
        screenId: "screen-success",
        title: "Success screen",
      },
      {
        key: "artifact:artifact-data",
        artifactId: "artifact-data",
        artifactVersionId: "version-data",
        kind: "data",
        title: "Metrics",
      },
    ]);
  });

  it("selects only pinned immutable artifacts through token-authorized public queries", () => {
    render(<ShareView share={share()} token="wbs_public_token" />);
    expect(queries.version).toHaveBeenLastCalledWith("wbs_public_token","artifact-prototype","version-prototype");
    fireEvent.click(screen.getByRole("button",{name:"Metrics"}));
    expect(queries.version).toHaveBeenLastCalledWith("wbs_public_token","artifact-data","version-data");
    expect(screen.queryByRole("button",{name:/发送|编辑|运行/})).toBeNull();
  });
});

function share(): PublicShare {
  return {
    shareId: "share-1",
    scope: "view",
    expiresAt: null,
    release: release(),
  } as PublicShare;
}

function release(): PublicProjectRelease {
  const checksum = "a".repeat(64);
  const prototypePin = {
    position: 0,
    artifactId: "artifact-prototype",
    artifactVersionId: "version-prototype",
    title: "Prototype",
    kind: "prototype" as const,
    version: 2,
    schemaVersion: 1,
    checksum,
  };
  const dataPin = {
    position: 1,
    artifactId: "artifact-data",
    artifactVersionId: "version-data",
    title: "Metrics",
    kind: "data" as const,
    version: 1,
    schemaVersion: 1,
    checksum,
  };
  return {
    projectId: "project-1",
    version: 3,
    artifactPins: [prototypePin, dataPin],
    boardSnapshot: {
      id: "board-1",
      projectId: "project-1",
      revision: 4,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        artifactNode("node-home", "Home screen", "screen-home"),
        artifactNode("node-success", "Success screen", "screen-success"),
      ],
      edges: [],
    },
  } as unknown as PublicProjectRelease;
}

function artifactNode(id: string, title: string, screenId: string) {
  return {
    id,
    kind: "artifact" as const,
    parentNodeId: null,
    order: id === "node-home" ? 0 : 1,
    position: { x: 0, y: 0 },
    size: { width: 390, height: 844 },
    artifactId: "artifact-prototype",
    artifactVersionId: "version-prototype",
    data: {
      protocol: "workbench.board-node.v1" as const,
      nodeType: "artifact" as const,
      title,
      artifactKind: "prototype" as const,
      screenId,
    },
  };
}
