import {
  boardNodeProtocol,
  replaceBoardRequestSchema,
} from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { boardToFlow, flowToBoardRequest } from "./adapter";
import { createBoardDrawing } from "./tool-actions";

describe("Board Drawing persistence", () => {
  it("round-trips a resized node without changing the stroke coordinate system", () => {
    const drawing = createBoardDrawing(
      [],
      [
        { x: 100, y: 200, pressure: 0.25 },
        { x: 160, y: 240, pressure: 0.8 },
      ],
      { size: 6, simulatePressure: false },
      () => "resized",
    ).nodes[0]!;
    drawing.measured = { width: 136, height: 24 };

    const request = replaceBoardRequestSchema.parse(flowToBoardRequest(
      { x: 0, y: 0, zoom: 1 },
      [drawing],
      [],
    ));
    expect(request.nodes[0]).toMatchObject({
      id: "drawing_resized",
      size: { width: 136, height: 24 },
      data: {
        protocol: boardNodeProtocol,
        nodeType: "drawing",
        stroke: {
          intrinsicSize: { width: 68, height: 48 },
          simulatePressure: false,
        },
      },
    });

    const reloaded = boardToFlow({
      id: "board-1",
      projectId: "project-1",
      revision: 1,
      ...request,
    }).nodes[0]!;
    expect(reloaded).toMatchObject({
      style: { width: 136, height: 24 },
      workbench: { size: { width: 136, height: 24 } },
      data: {
        nodeType: "drawing",
        stroke: { intrinsicSize: { width: 68, height: 48 } },
      },
    });
  });
});
