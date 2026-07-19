// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkbenchArtifactPreferenceActions,
  WorkbenchArtifactPreferenceProvider,
} from "./workbench-artifact-preference-actions";

afterEach(cleanup);

describe("WorkbenchArtifactPreferenceActions", () => {
  it("renders persisted state and delegates an available action", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <WorkbenchArtifactPreferenceProvider controller={{
        artifactVersionId: "version-1",
        screenId: "screen-home",
        busy: false,
        preference: { favorite: true, reaction: "like" },
        onToggle,
      }}>
        <WorkbenchArtifactPreferenceActions
          artifactVersionId="version-1"
          screenId="screen-home"
        />
      </WorkbenchArtifactPreferenceProvider>,
    );

    expect(screen.getByRole("button", { name: "收藏界面" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "喜欢" }).getAttribute("aria-pressed"))
      .toBe("true");
    await user.click(screen.getByRole("button", { name: "不喜欢" }));
    expect(onToggle).toHaveBeenCalledWith("dislike");
  });

  it("disables controls when the selected ArtifactVersion screen does not match", () => {
    render(
      <WorkbenchArtifactPreferenceProvider controller={{
        artifactVersionId: "version-1",
        screenId: "screen-home",
        busy: false,
        preference: { favorite: false, reaction: null },
        onToggle: vi.fn(),
      }}>
        <WorkbenchArtifactPreferenceActions
          artifactVersionId="version-1"
          screenId="screen-detail"
        />
      </WorkbenchArtifactPreferenceProvider>,
    );

    expect(screen.getByRole("button", { name: "收藏界面" }).hasAttribute("disabled"))
      .toBe(true);
  });
});
