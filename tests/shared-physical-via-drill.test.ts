import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

test("same-net route references at one through drill do not collide with each other", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [],
    obstacles: [],
  };
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "branch-a",
    connection_name: "ground",
    route: [{
      route_type: "via",
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "inner1",
      via_diameter: 0.5,
      via_hole_diameter: 0.25,
    }],
  };
  const index = new SpatialObstacleIndex(input, [trace]);
  const query = {
    point: { x: 0, y: 0 },
    layers: ["top", "inner1", "inner2", "bottom"],
    padDiameter: 0.5,
    holeDiameter: 0.25,
    connectionNames: ["ground"],
  };

  expect(index.collidesVia(query)).toBe(false);
  expect(index.collidesVia({ ...query, point: { x: 0.1, y: 0 } })).toBe(true);
  expect(index.collidesVia({ ...query, connectionNames: ["signal"] })).toBe(true);
  expect(index.collidesVia({ ...query, holeDiameter: 0.3 })).toBe(true);
});
