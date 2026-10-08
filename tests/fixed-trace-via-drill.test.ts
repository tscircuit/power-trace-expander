import { expect, test } from "bun:test";
import { centralObstacleFixture } from "../fixtures/central-obstacle";
import { SpatialObstacleIndex } from "../src";

const wire = (x: number, y: number) => ({
  route_type: "wire" as const,
  x,
  y,
  width: 0.15,
  layer: "top",
});

test("checks same-index vias from distinct fixed traces independently", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [];
  input.minViaHoleEdgeToViaHoleEdgeClearance = 0.2;
  input.fixedTraces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-via-outside-drill-radius",
      connection_name: "POWER",
      route: [
        wire(-1, -1),
        {
          route_type: "via",
          x: 0.35,
          y: 0.35,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.01,
          via_hole_diameter: 0.2,
        },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-via-inside-drill-radius",
      connection_name: "POWER",
      route: [
        wire(1, 1),
        {
          route_type: "via",
          x: 0.2,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.01,
          via_hole_diameter: 0.2,
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, []);
  const query = {
    point: { x: 0, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.01,
    holeDiameter: 0.2,
    connectionNames: ["POWER"],
  };

  expect(index.collidesVia(query)).toBe(true);
  expect(
    [...index.getViaViolationSignatures(query)].some((signature) =>
      signature.includes("fixed-trace:1"),
    ),
  ).toBe(true);
});
