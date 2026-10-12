// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { motion } from "framer-motion";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkbenchRouteEnterAnimation } from "./workbench-route-motion";
import { WorkbenchRouteTransition } from "./workbench-route-transition";

afterEach(cleanup);

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

  it("starts the incoming animation before the navigation commit can paint", async () => {
    const started: string[] = [];
    const commitSnapshots: string[][] = [];
    const props = {
      onAnimationStart: (name: string, opacity: number) => started.push(`${name}:${opacity}`),
      onLayout: () => commitSnapshots.push([...started]),
    };
    const rendered = render(<RouteOwner active="project" {...props} />);
    await waitFor(() => expect(rendered.getByTestId("project").style.opacity).toBe("1"));
    started.length = 0;

    rendered.rerender(<RouteOwner active="home" {...props} />);

    expect(commitSnapshots.at(-1)).toEqual(expect.arrayContaining(["project:0", "home:1"]));
    await waitFor(() => expect(rendered.getByTestId("home").style.opacity).toBe("1"));
    expect(rendered.queryByTestId("project")).toBeNull();
  });

  it("restores a route that returns before its exit finishes, including StrictMode", async () => {
    const rendered = render(<StrictMode><RouteOwner active="home" /></StrictMode>);
    await waitFor(() => expect(rendered.getByTestId("home").style.opacity).toBe("1"));

    rendered.rerender(<StrictMode><RouteOwner active="project" /></StrictMode>);
    expect(rendered.queryByTestId("home")).not.toBeNull();
    rendered.rerender(<StrictMode><RouteOwner active="home" /></StrictMode>);

    await waitFor(() => {
      expect(rendered.queryByTestId("project")).toBeNull();
      expect(rendered.getByTestId("home").style.opacity).toBe("1");
      expect(rendered.getByTestId("home").style.transform).toBe("none");
    });
    expect(rendered.container.children).toHaveLength(1);
  });
});

function RouteOwner({ active, onAnimationStart, onLayout }: {
  active: "home" | "project";
  onAnimationStart?: (name: string, opacity: number) => void;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => { onLayout?.(); });
  return (
    <WorkbenchRouteTransition routeView={active}>
      <RouteRoot name={active} onAnimationStart={onAnimationStart} />
    </WorkbenchRouteTransition>
  );
}

function RouteRoot({ name, onAnimationStart }: {
  name: "home" | "project";
  onAnimationStart?: (name: string, opacity: number) => void;
}) {
  const routeAnimation = useWorkbenchRouteEnterAnimation(name);
  return (
    <motion.section
      animate={routeAnimation}
      data-testid={name}
      exit={name === "home" ? { opacity: 0, y: -6 } : { opacity: 0 }}
      initial={name === "home" ? { opacity: 0, y: 6 } : { opacity: 0 }}
      onAnimationStart={(definition) => {
        if (typeof definition === "object" && "opacity" in definition) {
          onAnimationStart?.(name, Number(definition.opacity));
        }
      }}
      transition={{ duration: 0.05 }}
    />
  );
}
