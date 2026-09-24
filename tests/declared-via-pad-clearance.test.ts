import { expect, test } from "bun:test";
import { SpatialObstacleIndex, type PowerTraceExpanderInput } from "../src";
import type { ViaCollisionQuery } from "../src/types";

test("via queries honor the declared pad clearance without widening trace rules", (): void => {
  for (const clearance of [0.15, 0.25, 0.4]) {
    const input: PowerTraceExpanderInput = {
      layerCount: 4,
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.13,
      minViaEdgeToPadEdgeClearance: clearance,
      bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
      connections: [],
      obstacles: [
        {
          type: "rect",
          center: { x: 0, y: 0 },
          width: 0.5,
          height: 0.5,
          layers: ["top"],
          connectedTo: ["pcb_smtpad_1", "pcb_port_1", "PAD_NET"],
        },
      ],
    };
    const index = new SpatialObstacleIndex(input, []);
    const query: ViaCollisionQuery = {
      point: { x: 0.25 + 0.225 + clearance - 0.01, y: 0 },
      layers: index.boardLayers,
      padDiameter: 0.45,
      holeDiameter: 0.15,
      connectionNames: ["VIA_NET"],
      obstacleClearance: 0.13,
    };

    // The via clears the trace rule but violates the separate via-pad rule.
    expect(index.collidesVia(query)).toBe(true);
    expect(
      index.collides({
        start: query.point,
        end: query.point,
        layer: "top",
        width: query.padDiameter,
        connectionNames: query.connectionNames,
        obstacleClearance: query.obstacleClearance,
      }),
    ).toBe(false);
    const clearQuery = {
      ...query,
      point: { x: query.point.x + 0.02, y: 0 },
    };
    expect(index.collidesVia(clearQuery)).toBe(false);
    expect(
      index.collidesVia({
        ...clearQuery,
        obstacleClearance: clearance + 0.02,
      }),
    ).toBe(true);
    const legacyIndex = new SpatialObstacleIndex(
      { ...input, minViaEdgeToPadEdgeClearance: undefined },
      [],
    );
    expect(legacyIndex.collidesVia(query)).toBe(false);
    expect(
      legacyIndex.collidesVia({
        ...query,
        point: { x: 0.25 + 0.225 + 0.08, y: 0 },
        obstacleClearance: 0.05,
      }),
    ).toBe(false);
    const traceIndex = new SpatialObstacleIndex(
      { ...input, obstacles: [] },
      [
        {
          type: "pcb_trace",
          pcb_trace_id: "other_trace",
          connection_name: "OTHER_NET",
          route: [
            { route_type: "wire", x: 0, y: -1, layer: "top", width: 0.1 },
            { route_type: "wire", x: 0, y: 1, layer: "top", width: 0.1 },
          ],
        },
      ],
    );
    expect(
      traceIndex.collidesVia({
        ...query,
        point: { x: 0.05 + 0.225 + 0.14, y: 0 },
      }),
    ).toBe(false);
  }
});
