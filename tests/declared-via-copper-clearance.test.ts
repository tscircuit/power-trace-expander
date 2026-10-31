import { expect, test } from "bun:test";
import { measureTraceWidths } from "../src/measureTraceWidths";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

test("via copper spacing respects pad rules independently of drill and trace rules", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.095,
    minTraceToPadEdgeClearance: 0.1,
    minPadEdgeToPadEdgeClearance: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.25,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [],
    obstacles: [],
  };
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "existing-via",
    connection_name: "signal",
    route: [
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
    ],
  };
  for (const fixed of [false, true]) {
    const index = new SpatialObstacleIndex(
      { ...input, fixedTraces: fixed ? [trace] : [] },
      fixed ? [] : [trace],
    );
    const query = {
      point: { x: 0.42, y: 0 },
      layers: ["top", "bottom"],
      padDiameter: 0.3,
      holeDiameter: 0.15,
      connectionNames: ["power"],
    };
    // The 0.27 mm drill gap passes; the 0.12 mm copper gap fails.
    expect(index.collidesVia(query)).toBe(true);
    expect(index.collidesVia({ ...query, point: { x: 0.450001, y: 0 } })).toBe(
      false,
    );
    expect(index.collidesVia({ ...query, connectionNames: ["signal"] })).toBe(
      false,
    );
    // Drill spacing still applies to connected copper.
    expect(
      index.collidesVia({
        ...query,
        point: { x: 0.39, y: 0 },
        connectionNames: ["signal"],
      }),
    ).toBe(true);
    expect(
      index.collides({
        start: query.point,
        end: query.point,
        layer: "top",
        width: 0.3,
        connectionNames: ["power"],
      }),
    ).toBe(false);
  }
});

test("pad and via obstacle classification and trace width measurement support non-zero-index connectedTo and connectsTo aliases", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minPadEdgeToPadEdgeClearance: 0.2,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.5,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pcb_port_id: "pcb_port_power_start" },
          { x: 2, y: 0, layer: "top", pcb_port_id: "pcb_port_power_end" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: ["signal_net", "pcb_via_1"],
      },
      {
        type: "rect",
        center: { x: 2, y: 0 },
        width: 0.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: ["signal_net", "pcb_smtpad_1"],
      },
    ],
  };

  const index = new SpatialObstacleIndex(input, []);
  expect(
    index.collidesVia({
      point: { x: 0.55, y: 0 },
      layers: ["top"],
      padDiameter: 0.4,
      holeDiameter: 0.2,
      connectionNames: ["POWER"],
    }),
  ).toBe(true);
  expect(
    index.collides({
      start: { x: 2, y: 0.5 },
      end: { x: 2, y: 0.5 },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
      obstacleClearance: 0.25,
    }),
  ).toBe(true);

  const metrics = measureTraceWidths(input, [
    {
      type: "pcb_trace",
      pcb_trace_id: "power_trace_1",
      connectsTo: ["pcb_port_power_start", "pcb_port_power_end"],
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.5, layer: "top" },
        { route_type: "wire", x: 2, y: 0, width: 0.5, layer: "top" },
      ],
    },
  ]);
  expect(metrics.get(0.5)?.totalLength).toBeCloseTo(2, 6);
  expect(metrics.get(0.5)?.nominalCoverage).toBeCloseTo(1, 6);
});
