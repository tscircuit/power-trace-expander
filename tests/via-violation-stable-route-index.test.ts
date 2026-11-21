import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

test("via violation identity survives wire insertion but tracks drill geometry", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.2,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [],
    obstacles: [],
  };
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "signal",
    connection_name: "signal",
    route: [
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.45,
        via_hole_diameter: 0.2,
      },
    ],
  };
  const query = {
    point: { x: 0.35, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.45,
    holeDiameter: 0.2,
    connectionNames: ["power"],
  };
  const signatures = (candidate: SimplifiedPcbTrace): Set<string> =>
    new SpatialObstacleIndex(input, [candidate]).getViaViolationSignatures(
      query,
    );
  const baseline = signatures(trace);
  expect(baseline.size).toBeGreaterThan(0);
  const withWire = structuredClone(trace);
  withWire.route.unshift({
    route_type: "wire",
    x: -2,
    y: 0,
    layer: "top",
    width: 0.1,
  });
  expect(signatures(withWire)).toEqual(baseline);
  const changedHole = structuredClone(withWire);
  const via = changedHole.route.at(-1)!;
  if (via.route_type !== "via") throw new Error("Expected a via");
  via.via_hole_diameter = 0.25;
  expect(signatures(changedHole)).not.toEqual(baseline);
  via.x = 0.05;
  expect(signatures(changedHole)).not.toEqual(signatures(withWire));
});
