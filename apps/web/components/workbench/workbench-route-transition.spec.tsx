// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { motion } from "framer-motion";
import { describe, expect, it } from "vitest";

import { WorkbenchRouteTransition } from "./workbench-route-transition";

describe("Workbench route motion ownership", () => {
  it("keeps direct Home and Project roots in sync while the previous route exits", async () => {
    const rendered = render(<RouteOwner active="home" />);

    expect(rendered.container.children).toHaveLength(1);
    expect(rendered.getByTestId("home")).toBe(rendered.container.firstElementChild);

    rendered.rerender(<RouteOwner active="project" />);

    expect(rendered.queryByTestId("home")).not.toBeNull();
    expect(rendered.queryByTestId("project")).not.toBeNull();
    expect(rendered.container.children).toHaveLength(2);

    await waitFor(() => {
      expect(rendered.queryByTestId("home")).toBeNull();
    });
    expect(rendered.getByTestId("project")).toBe(rendered.container.firstElementChild);
  });
});

function RouteOwner({ active }: { active: "home" | "project" }) {
  return (
    <WorkbenchRouteTransition routeView={active}>
      <RouteRoot name={active} />
    </WorkbenchRouteTransition>
  );
}

function RouteRoot({ name }: { name: "home" | "project" }) {
  return (
    <motion.section
      animate={{ opacity: 1 }}
      data-testid={name}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.05 }}
    />
  );
}
