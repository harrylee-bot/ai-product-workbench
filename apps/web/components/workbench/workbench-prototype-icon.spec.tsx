// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeLucideIconName,
  WorkbenchPrototypeIcon,
} from "./workbench-prototype-icon";

afterEach(cleanup);

describe("Workbench Prototype Lucide icon", () => {
  it.each([
    ["CircleCheck", "circle-check"],
    ["circle_check", "circle-check"],
    ["circle check", "circle-check"],
  ])("normalizes %s to a dynamic Lucide key", (input, expected) => {
    expect(normalizeLucideIconName(input)).toBe(expected);
  });

  it("loads a real Lucide SVG and fails visibly for unknown icon names", async () => {
    const rendered = render(<WorkbenchPrototypeIcon iconName="circle-check" />);
    await waitFor(() => expect(rendered.container.querySelector("svg")).not.toBeNull());

    rendered.rerender(<WorkbenchPrototypeIcon iconName="DefinitelyMissingIcon" />);
    expect(screen.getByText("DefinitelyMissingIcon")).not.toBeNull();
  });
});
